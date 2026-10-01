package oao

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"sort"
	"strings"
)

//go:embed static
var staticFS embed.FS

// ErrNoTables 创建组件时没有提供任何表格。
var ErrNoTables = errors.New("oao: 至少要注册一张表")

// Logger 宿主可选的日志接口；nil 时静默。
type Logger interface {
	Infof(format string, args ...any)
	Errorf(format string, args ...any)
}

// Config 组件配置。
type Config struct {
	Tables []Table
	Logger Logger

	// Auth 鉴权中间件，由宿主注入（papa 传白名单 + 访问密钥那两道）。
	// 为 nil 时不鉴权 —— 只适合本地 demo。
	Auth func(http.Handler) http.Handler

	// Prefix API 前缀，默认 "/api/oao"。
	Prefix string

	// OnAction 每次操作转发结束时回调（成功与失败都调），宿主可用它记审计日志。
	// 组件自己不落任何存储 —— 要不要记、记到哪，由宿主决定。
	OnAction func(ActionEvent)
}

// Oao 表格组件。宿主负责 Mount 路由、把 StaticFS 挂到静态资源路径。
type Oao struct {
	tables []*TableInfo
	byKey  map[string]*TableInfo
	cfg    Config
}

// New 创建组件并校验所有表格声明；任何配置问题都在这里一次性报出来。
func New(cfg Config) (*Oao, error) {
	if len(cfg.Tables) == 0 {
		return nil, ErrNoTables
	}
	if cfg.Prefix == "" {
		cfg.Prefix = "/api/oao"
	}
	if !strings.HasPrefix(cfg.Prefix, "/") {
		// 少了前导斜杠路由会静默不生效，不如直接报错
		return nil, fmt.Errorf("oao: Prefix %q 必须以 / 开头", cfg.Prefix)
	}
	if strings.HasSuffix(cfg.Prefix, "/") {
		return nil, fmt.Errorf("oao: Prefix %q 不能以 / 结尾", cfg.Prefix)
	}
	o := &Oao{byKey: make(map[string]*TableInfo, len(cfg.Tables)), cfg: cfg}

	for _, t := range cfg.Tables {
		if err := validate(t); err != nil {
			return nil, err
		}
		if _, dup := o.byKey[t.Key]; dup {
			return nil, fmt.Errorf("oao: table key %q 重复", t.Key)
		}
		info, err := t.resolve()
		if err != nil {
			return nil, err
		}
		o.tables = append(o.tables, info)
		o.byKey[info.Key] = info
		if cfg.Logger != nil {
			cfg.Logger.Infof("oao: table %q registered (columns=%d, filters=%d, actions=%d)",
				info.Key, len(info.Columns), len(info.Filters), len(info.Actions))
		}
	}
	sort.Slice(o.tables, func(i, j int) bool { return o.tables[i].Key < o.tables[j].Key })
	return o, nil
}

// validate 校验单张表的声明。
func validate(t Table) error {
	if t.Key == "" {
		return errors.New("oao: table key 不能为空")
	}
	if t.Key == "tables" {
		// 与表格清单接口 {prefix}/tables 冲突，这样的表永远访问不到
		return errors.New(`oao: table key "tables" 是保留字（与 {prefix}/tables 接口冲突）`)
	}
	if !validKey(t.Key) {
		return fmt.Errorf("oao: table key %q 只能用字母、数字、下划线、连字符", t.Key)
	}
	if t.Source == nil {
		return fmt.Errorf("oao: table %q 缺少 Source", t.Key)
	}
	if len(t.Columns) == 0 {
		return fmt.Errorf("oao: table %q 至少要声明一列", t.Key)
	}
	seen := make(map[string]bool, len(t.Columns))
	for _, c := range t.Columns {
		if c.Field == "" {
			return fmt.Errorf("oao: table %q 有列未填 Field", t.Key)
		}
		if seen[c.Field] {
			return fmt.Errorf("oao: table %q 列 %q 重复", t.Key, c.Field)
		}
		seen[c.Field] = true
		if c.Render == RenderEnum && len(c.Enum) == 0 {
			return fmt.Errorf("oao: table %q 列 %q 用了 enum 渲染但没给 Enum 映射", t.Key, c.Field)
		}
		if c.Render == RenderCustom && c.HTML == "" {
			return fmt.Errorf("oao: table %q 列 %q 用了 custom 渲染但没给 HTML", t.Key, c.Field)
		}
	}
	for _, f := range t.Filters {
		if f.Field == "" {
			return fmt.Errorf("oao: table %q 有筛选项未填 Field", t.Key)
		}
	}
	if t.DefaultSort != "" {
		// 支持多字段："-status,amount" —— 逐个剥掉前导 - 再校验
		for _, part := range strings.Split(t.DefaultSort, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name := strings.TrimPrefix(part, "-")
			if !seen[name] {
				return fmt.Errorf("oao: table %q 的 DefaultSort %q 里有未声明的列 %q", t.Key, t.DefaultSort, name)
			}
		}
	}
	return nil
}

// Tables 返回全部表格元数据，供宿主渲染侧边栏菜单。
func (o *Oao) Tables() []*TableInfo { return o.tables }

// Table 按 key 取表格元数据。
func (o *Oao) Table(key string) (*TableInfo, bool) {
	t, ok := o.byKey[key]
	return t, ok
}

// Prefix 返回 API 前缀。
func (o *Oao) Prefix() string { return o.cfg.Prefix }

// StaticFS 返回静态资源文件系统，供宿主挂到静态资源路径。
func (o *Oao) StaticFS() (fs.FS, error) { return fs.Sub(staticFS, "static") }

// validKey 表 key 要直接进 URL 路径，限制成 URL 安全字符，避免编码/路由上的意外。
func validKey(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

package oao

import (
	"fmt"
	"strings"
)

// Table 一个表格页的声明 —— 纯展示，不含模型、不含库、不含查询实现。
type Table struct {
	Key   string // URL 与菜单标识（字母/数字/下划线/连字符）
	Label string // 菜单与页面标题，留空用 Key
	Group string // 侧边栏分组，留空用 "General"

	Columns []Column // 显示哪些列、怎么显示；至少一列
	Filters []Filter // 可筛选的字段，留空则不显示筛选栏
	// Actions 声明操作列。留空 = 只读表，不注册任何写路由；
	// 组件只把操作请求转发给 Handler，自己不碰数据。
	Actions []Action

	DefaultSort string // 默认排序，"col" 升序 / "-col" 降序；必须是已声明的列
	PageSize    int    // 每页条数，默认 20
	PageSizes   []int  // 可选每页条数，默认 {20, 50, 100}

	Source Source // 数据来源，业务实现；必填
}

// Column 一列的声明。
type Column struct {
	Field  string   // 字段名，同时作为 rows 里取值用的 key
	Label  string   // 展示名，留空由 Field 生成（"order_no" -> "Order No"）
	Kind   Kind     // 取值类型，留空按字符串；决定默认渲染方式
	Width  string   // 列宽，如 "80px" / "20%"
	Render Renderer // 显示方式，留空按 Kind 推断
	NoSort bool     // 该列不可排序；默认都可排序
	NoEdit bool     // 该列不进自动生成的编辑表单（主键、创建时间等）
	// Hidden 声明但不显示：数据仍会下发（供操作列的乐观锁比对等用），只是不渲染这一列。
	Hidden bool

	// 以下为各 Renderer 的参数，按需填写。

	Enum   map[string]string // RenderEnum：取值 -> 文案
	Tone   map[string]string // RenderEnum：取值 -> Tone（ok/warn/err/info）
	Href   string            // RenderLink：跳转模板，支持 {字段名} 占位
	MaxLen int               // RenderInput：只读输入框宽度（字符数）
	Size   int               // RenderImage：缩略图边长（px），默认 64
	Format string            // RenderTime："date" 只显示日期，留空显示到秒
	HTML   string            // RenderCustom：HTML 片段（受信任内容，组件不转义）
}

// Filter 一个筛选条件的声明。组件只把值透传给 Source，不解释语义。
type Filter struct {
	Field   string
	Label   string
	Op      Op                // 留空按 Kind 推断：字符串 Like，其余 Eq
	Widget  Widget            // 留空按 Op 推断
	Kind    Kind              // 取值类型，留空按字符串
	Options map[string]string // In / 下拉的选项：值 -> 文案
}

// TableInfo 表格的运行时元数据 —— 前端渲染所需的一切。
// 注册时把声明里的留空项都补齐，前端拿到的永远是具体值。
type TableInfo struct {
	Key         string       `json:"key"`
	Label       string       `json:"label"`
	Group       string       `json:"group"`
	Columns     []ColumnInfo `json:"columns"`
	Filters     []FilterInfo `json:"filters"`
	Actions     []ActionInfo `json:"actions"`
	DefaultSort string       `json:"default_sort,omitempty"`
	PageSize    int          `json:"page_size"`
	PageSizes   []int        `json:"page_sizes"`

	source       Source
	actionByName map[string]ActionHandler
	// actionFields 每个动作允许接收的表单字段，用来挡住客户端多塞的字段。
	actionFields map[string]map[string]bool
	filterSpecs  map[string]FilterSpec // 字段名 -> 筛选规格，交给 Query 解码用
	sortableSet  map[string]bool       // 允许排序的列，交给 Query 校验排序参数用
}

// ColumnInfo 一列的渲染元数据。
type ColumnInfo struct {
	Name     string            `json:"name"`
	Label    string            `json:"label"`
	Kind     Kind              `json:"kind"`
	Render   Renderer          `json:"render"`
	Width    string            `json:"width,omitempty"`
	Sortable bool              `json:"sortable"`
	NoEdit   bool              `json:"-"` // 仅供自动表单推导，不必给前端
	Hidden   bool              `json:"hidden,omitempty"`
	Enum     map[string]string `json:"enum,omitempty"`
	Tone     map[string]string `json:"tone,omitempty"`
	Href     string            `json:"href,omitempty"`
	MaxLen   int               `json:"max_len,omitempty"`
	Size     int               `json:"size,omitempty"`
	Format   string            `json:"format,omitempty"`
	HTML     string            `json:"html,omitempty"`
}

// FilterInfo 一个筛选控件的元数据。
type FilterInfo struct {
	Name    string            `json:"name"`
	Label   string            `json:"label"`
	Kind    Kind              `json:"kind"`
	Op      Op                `json:"op"`
	Widget  Widget            `json:"widget"`
	Options map[string]string `json:"options,omitempty"`
}

// resolve 把声明里的留空项补成具体值，并做基本校验。
func (t Table) resolve() (*TableInfo, error) {
	info := &TableInfo{
		Key: t.Key, Label: orDefault(t.Label, t.Key), Group: orDefault(t.Group, "General"),
		DefaultSort: t.DefaultSort, PageSize: t.PageSize, PageSizes: t.PageSizes,
		Filters: []FilterInfo{}, // 非 nil：序列化成 []，前端不用处理 null
		Actions: []ActionInfo{},
		source:  t.Source,
	}
	if info.PageSize <= 0 {
		info.PageSize = 20
	}
	if len(info.PageSizes) == 0 {
		info.PageSizes = []int{20, 50, 100}
	}

	for _, c := range t.Columns {
		b := c // 拷贝，避免修改调用方传进来的结构
		if b.Kind == "" {
			b.Kind = KindString
		}
		ci := ColumnInfo{
			Name: b.Field, Label: orDefault(b.Label, humanize(b.Field)), Kind: b.Kind,
			Render: b.Render, Width: b.Width, Sortable: !b.NoSort, NoEdit: b.NoEdit, Hidden: b.Hidden,
			Enum: b.Enum, Tone: b.Tone, Href: b.Href,
			MaxLen: b.MaxLen, Size: b.Size, Format: b.Format, HTML: b.HTML,
		}
		if ci.Render == RenderAuto {
			ci.Render = defaultRender(ci.Kind)
		}
		if ci.Render == RenderImage && ci.Size <= 0 {
			ci.Size = 64
		}
		info.Columns = append(info.Columns, ci)
	}

	filterSeen := make(map[string]bool, len(t.Filters))
	for _, f := range t.Filters {
		b := f
		if b.Kind == "" {
			b.Kind = KindString
		}
		fi := FilterInfo{
			Name: b.Field, Label: orDefault(b.Label, humanize(b.Field)), Kind: b.Kind,
			Op: b.Op, Widget: b.Widget, Options: b.Options,
		}
		if fi.Op == "" {
			fi.Op = defaultOp(fi.Kind)
		}
		if fi.Widget == WidgetAuto {
			fi.Widget = defaultWidget(fi.Op, fi.Kind, b.Options)
		}
		if filterSeen[fi.Name] {
			return nil, fmt.Errorf("oao: table %q 筛选字段 %q 重复声明", t.Key, fi.Name)
		}
		filterSeen[fi.Name] = true
		info.Filters = append(info.Filters, fi)
		if info.filterSpecs == nil {
			info.filterSpecs = make(map[string]FilterSpec, len(t.Filters))
		}
		info.filterSpecs[fi.Name] = FilterSpec{
			Field: fi.Name, Op: fi.Op, Kind: fi.Kind, Options: fi.Options,
		}
	}

	infos, handlers, err := resolveActions(t.Key, t.Actions, info.Columns)
	if err != nil {
		return nil, err
	}
	info.Actions = infos
	info.actionByName = make(map[string]ActionHandler, len(handlers))
	info.actionFields = make(map[string]map[string]bool, len(infos))
	for i, a := range infos {
		info.actionByName[a.Key] = handlers[i]
		allowed := make(map[string]bool, len(a.Form))
		for _, f := range a.Form {
			allowed[f.Name] = true
		}
		info.actionFields[a.Key] = allowed
	}

	return info, nil
}

// column 按字段名找已声明的列。
func (t *TableInfo) column(name string) (ColumnInfo, bool) {
	for _, c := range t.Columns {
		if c.Name == name {
			return c, true
		}
	}
	return ColumnInfo{}, false
}

// markSortable 记下一个可排序列。
func (t *TableInfo) markSortable(name string) {
	if t.sortableSet == nil {
		t.sortableSet = make(map[string]bool)
	}
	t.sortableSet[name] = true
}

// defaultRender 按取值类型推断默认渲染方式。
func defaultRender(k Kind) Renderer {
	switch k {
	case KindBool:
		return RenderEnum
	case KindTime:
		return RenderTime
	case KindJSON:
		return RenderJSON
	default:
		return RenderText
	}
}

// defaultOp 字符串默认模糊匹配，其余等值。
func defaultOp(k Kind) Op {
	if k == KindString {
		return OpLike
	}
	return OpEq
}

// defaultWidget 按算子与类型推断前端控件。
func defaultWidget(op Op, k Kind, options map[string]string) Widget {
	switch op {
	case OpIn:
		return WidgetSelect
	case OpBetween:
		return WidgetDateRange
	}
	if len(options) > 0 {
		return WidgetSelect
	}
	if k == KindTime {
		return WidgetDate
	}
	return WidgetInput
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// humanize 把 snake_case 字段名转为展示名："created_at" -> "Created At"
func humanize(s string) string {
	words := strings.Split(s, "_")
	for i, w := range words {
		if w == "" {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

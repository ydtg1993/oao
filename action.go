package oao

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ActionHandler 业务实现的操作处理逻辑。组件只把请求转发过来，
// 具体改哪个库、做什么校验，全由业务决定。
type ActionHandler func(ctx context.Context, req ActionRequest) error

// ActionRequest 一次前端操作请求。
//
// 取值用下面的助手，别直接读 map —— 表单提交的是 JSON，数字一律是 float64：
//
//	if req.Bool("notify") { ... }
//	if n, ok := req.Int("amount"); ok { ... }
type ActionRequest struct {
	Table  string         // 表 key
	Action string         // 动作 key
	ID     string         // 目标行主键（组件不知道你的主键是什么，原样透传）
	Values map[string]any // 表单提交的字段值；无表单时为空
	Row    map[string]any // 客户端展示时那一行的原始数据
	Req    *http.Request  // 逃生舱：需要读请求头/上下文时用
}

// String 取表单项的字符串值。
func (r ActionRequest) String(name string) string {
	s, _ := r.Values[name].(string)
	return s
}

// Int 取表单项的整数（JSON 数字是 float64，这里帮你转）。
func (r ActionRequest) Int(name string) (int, bool) {
	switch v := r.Values[name].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		return n, err == nil
	}
	return 0, false
}

// Float 取表单项的浮点数。
func (r ActionRequest) Float(name string) (float64, bool) {
	switch v := r.Values[name].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return f, err == nil
	}
	return 0, false
}

// Bool 取表单项的布尔值。
func (r ActionRequest) Bool(name string) bool {
	switch v := r.Values[name].(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		s := strings.ToLower(strings.TrimSpace(v))
		return s == "1" || s == "true" || s == "yes"
	}
	return false
}

// RowString 取原行数据的字符串值（乐观锁比对、拼业务条件时用）。
func (r ActionRequest) RowString(name string) string {
	switch v := r.Row[name].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// Action 操作列上的一个动作。
//
//	oao.EditAction(func(ctx context.Context, req oao.ActionRequest) error { ... })
//	{Key: "approve", Label: "审核通过", Tone: oao.ToneOK,
//	 Confirm: "确认通过该订单？", Handler: approveOrder}
type Action struct {
	Key     string
	Label   string
	Tone    Tone   // 按钮语义色：空 / ok / warn / err / info
	Confirm string // 非空：点完先弹确认框，文案即内容

	Form []Field // 非空：点完先弹表单，字段即表单内容
	// DeriveForm 为 true 时忽略 Form，改由表里声明的列推导表单
	// （跳过图片 / JSON / 链接 / 自定义这些只读展示列）。EditAction 用的就是它。
	DeriveForm bool

	Handler ActionHandler
}

// Field 弹窗表单里的一个字段。
type Field struct {
	Name     string
	Label    string
	Kind     Kind              // 决定输入类型与值转换，默认字符串
	Widget   Widget            // 留空按 Kind 推断：文本 / 数字 / 下拉 / 多行 / 开关
	Options  map[string]string // Widget 为下拉时的选项：值 -> 文案
	Required bool
	Help     string // 字段下方的说明
	Rows     int    // 多行文本框的行数，默认 3

	// Placeholder 下拉未选择时触发器上的提示，默认"请选择"
	Placeholder string
}

// ActionInfo 操作/表单字段的渲染元数据 —— 注册时把留空项补齐。
type ActionInfo struct {
	Key     string      `json:"key"`
	Label   string      `json:"label"`
	Tone    Tone        `json:"tone,omitempty"`
	Confirm string      `json:"confirm,omitempty"`
	Form    []FieldInfo `json:"form,omitempty"`
}

// FieldInfo 表单字段的渲染元数据。
type FieldInfo struct {
	Name        string            `json:"name"`
	Label       string            `json:"label"`
	Kind        Kind              `json:"kind"`
	Widget      Widget            `json:"widget"`
	Options     map[string]string `json:"options,omitempty"`
	Required    bool              `json:"required,omitempty"`
	Help        string            `json:"help,omitempty"`
	Rows        int               `json:"rows,omitempty"`
	Placeholder string            `json:"placeholder,omitempty"`
}

// ActionEvent 一次操作转发的结局，供宿主记审计（成功与失败都会回调）。
type ActionEvent struct {
	Table  string
	Action string
	ID     string
	Values map[string]any
	Err    error // nil 表示业务处理器返回成功
	IP     string
	At     time.Time
}

// ActionError 业务可以用它指定返回给前端的 HTTP 状态码与提示语。
// 不包这个类型时统一按 500 处理。
type ActionError struct {
	Status  int
	Message string
}

func (e *ActionError) Error() string { return e.Message }

// Fail 构造一个带状态码的业务错误，例如：
//
//	oao.Fail(http.StatusConflict, "该行已被他人修改")
//	oao.Fail(http.StatusBadRequest, "备注不能为空")
func Fail(status int, format string, args ...any) error {
	return &ActionError{Status: status, Message: fmt.Sprintf(format, args...)}
}

// EditAction 内置「编辑」动作：表单字段由表里声明的列推导（跳过只读展示列）。
func EditAction(h ActionHandler) Action {
	return Action{Key: "edit", Label: "编辑", DeriveForm: true, Handler: h}
}

// RemoveAction 内置「删除」动作：先弹二次确认。
func RemoveAction(h ActionHandler) Action {
	return Action{Key: "remove", Label: "删除", Tone: ToneErr, Confirm: "删除后不可恢复，确认删除这一行？", Handler: h}
}

// resolveActions 补齐动作的留空项并做校验。
func resolveActions(tableKey string, actions []Action, columns []ColumnInfo) ([]ActionInfo, []ActionHandler, error) {
	if len(actions) == 0 {
		return []ActionInfo{}, nil, nil // 非 nil：序列化成 []，前端不用处理 null
	}
	infos := make([]ActionInfo, 0, len(actions))
	handlers := make([]ActionHandler, 0, len(actions))
	seen := make(map[string]bool, len(actions))

	for _, a := range actions {
		if a.Key == "" {
			return nil, nil, fmt.Errorf("oao: table %q 有操作未填 Key", tableKey)
		}
		if !validKey(a.Key) {
			// Key 会进路由 {prefix}/{table}/action/{key}
			return nil, nil, fmt.Errorf("oao: table %q 操作 key %q 只能用字母、数字、下划线、连字符", tableKey, a.Key)
		}
		if seen[a.Key] {
			return nil, nil, fmt.Errorf("oao: table %q 操作 %q 重复", tableKey, a.Key)
		}
		seen[a.Key] = true
		if a.Handler == nil {
			return nil, nil, fmt.Errorf("oao: table %q 操作 %q 缺少 Handler", tableKey, a.Key)
		}
		info := ActionInfo{
			Key: a.Key, Label: orDefault(a.Label, a.Key), Tone: a.Tone, Confirm: a.Confirm,
		}
		if a.DeriveForm {
			info.Form = autoForm(columns)
		} else {
			for _, f := range a.Form {
				if f.Name == "" {
					return nil, nil, fmt.Errorf("oao: table %q 操作 %q 有表单项未填 Name", tableKey, a.Key)
				}
				if !validKey(f.Name) {
					// Name 会进 data-field 属性与 querySelector，限制字符集避免选择器注入
					return nil, nil, fmt.Errorf("oao: table %q 操作 %q 表单项 %q 只能用字母、数字、下划线、连字符", tableKey, a.Key, f.Name)
				}
				fi := FieldInfo{
					Name: f.Name, Label: orDefault(f.Label, humanize(f.Name)),
					Kind: orDefaultKind(f.Kind), Widget: f.Widget,
					Options: f.Options, Required: f.Required, Help: f.Help, Rows: f.Rows,
					Placeholder: f.Placeholder,
				}
				if fi.Widget == WidgetAuto {
					fi.Widget = defaultFormWidget(fi.Kind, f.Options)
				}
				if fi.Widget == WidgetTextarea && fi.Rows <= 0 {
					fi.Rows = 3
				}
				info.Form = append(info.Form, fi)
			}
		}
		infos = append(infos, info)
		handlers = append(handlers, a.Handler)
	}
	return infos, handlers, nil
}

// autoForm 按列声明推导编辑表单：
// 只读展示类（图片 / JSON / 链接 / 自定义）与标了 NoEdit 的列（主键、创建时间等）不进表单。
func autoForm(columns []ColumnInfo) []FieldInfo {
	out := make([]FieldInfo, 0, len(columns))
	for _, c := range columns {
		if c.NoEdit || c.Hidden {
			continue // 隐藏列不该出现在编辑表单里（与"不显示"自相矛盾）
		}
		switch c.Render {
		case RenderImage, RenderJSON, RenderCustom, RenderLink:
			continue
		}
		fi := FieldInfo{Name: c.Name, Label: c.Label, Kind: c.Kind, Widget: defaultFormWidget(c.Kind, c.Enum)}
		if len(c.Enum) > 0 {
			fi.Options = c.Enum
		}
		out = append(out, fi)
	}
	return out
}

func orDefaultKind(k Kind) Kind {
	if k == "" {
		return KindString
	}
	return k
}

// defaultFormWidget 按字段类型推断表单控件。
func defaultFormWidget(k Kind, options map[string]string) Widget {
	if len(options) > 0 {
		return WidgetSelect
	}
	switch k {
	case KindNumber:
		return WidgetNumber
	case KindBool:
		return WidgetSwitch
	case KindTime:
		return WidgetDate
	case KindJSON:
		return WidgetTextarea
	default:
		return WidgetInput
	}
}

// asActionError 把业务返回的错误映射成状态码与给前端看的消息。
func asActionError(err error) (int, string) {
	var ae *ActionError
	if errors.As(err, &ae) {
		status := ae.Status
		if status == 0 {
			status = http.StatusBadRequest
		}
		// Fail 的语义是"这次操作失败了"。传 2xx 会让前端 resp.ok 判成成功，
		// 传越界值也不是合法状态码 —— 统一兜成 500。
		if status < 400 || status > 599 {
			status = http.StatusInternalServerError
		}
		return status, ae.Message
	}
	// 非 Fail 的错误是业务内部的意外，细节只进日志，不回给前端
	return http.StatusInternalServerError, "服务器内部错误"
}

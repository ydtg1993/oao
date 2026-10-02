// Package oao 是一个表格渲染组件。
//
// 它把业务层给的数据，按声明渲染成 OA 后台的表格页 —— 只做展示协议，
// 不碰数据层：读数据由业务实现 Source，操作请求由组件转发给业务。
//
// 明确一下职责边界：它不发 SQL、不认识模型、不落任何存储、不做鉴权，
// 也不负责数据的正确性与并发/幂等 —— 同一操作被触发多次时的去重、
// 记录的状态怎么流转，都由宿主在自己的数据层决定（见 README「组件的职责边界」）。
//
//	oao.New(oao.Config{
//	    Tables: []oao.Table{{
//	        Key: "order", Label: "订单管理",
//	        Columns: []oao.Column{{Field: "order_no", Label: "订单号"}},
//	        Source:  mySource,          // 业务实现
//	    }},
//	}).Mount(mux)
//
// 组件零外部依赖，样式只消费宿主提供的设计 token。
package oao

// Kind 列的取值类型，仅用于推断默认渲染方式与前端对齐方式。
type Kind string

const (
	KindString Kind = "string"
	KindNumber Kind = "number"
	KindBool   Kind = "bool"
	KindTime   Kind = "time"
	KindJSON   Kind = "json"
)

// Renderer 列的显示方式；RenderAuto 表示按 Kind 推断。
type Renderer string

const (
	RenderAuto   Renderer = ""       // 按 Kind 推断
	RenderText   Renderer = "text"   // 纯文本，过长省略 + 悬停看全文
	RenderInput  Renderer = "input"  // 只读输入框：长度可控、横向滚动逐字看完（不是编辑）
	RenderLink   Renderer = "link"   // 可点击跳转
	RenderImage  Renderer = "image"  // 图片缩略图
	RenderEnum   Renderer = "enum"   // 取值映射为彩色标签
	RenderTime   Renderer = "time"   // 时间格式化
	RenderJSON   Renderer = "json"   // 折叠查看
	RenderCustom Renderer = "custom" // 逃生舱：自定义 HTML 片段（受信任内容）
)

// Op 筛选算子。组件只做声明与透传，具体怎么落到查询上由业务 Source 决定。
type Op string

const (
	OpEq      Op = "eq"      // 等于
	OpLike    Op = "like"    // 模糊（前后通配，用不上索引）
	OpPrefix  Op = "prefix"  // 前缀匹配（只有后通配，可以走索引）
	OpIn      Op = "in"      // 多选
	OpBetween Op = "between" // 区间
	OpGt      Op = "gt"      // 大于
	OpLt      Op = "lt"      // 小于
)

// Widget 前端筛选 / 表单控件；WidgetAuto 表示按类型推断。
type Widget string

const (
	WidgetAuto      Widget = ""
	WidgetInput     Widget = "input"     // 单行文本
	WidgetNumber    Widget = "number"    // 数字
	WidgetTextarea  Widget = "textarea"  // 多行文本
	WidgetSelect    Widget = "select"    // 下拉
	WidgetSwitch    Widget = "switch"    // 开关
	WidgetDate      Widget = "date"      // 日期
	WidgetDateRange Widget = "daterange" // 日期区间（仅筛选用）
	WidgetMulti     Widget = "multi"     // 多选（仅筛选用）
)

// Tone 徽章 / 按钮的语义色。
type Tone string

const (
	ToneDefault Tone = ""
	ToneOK      Tone = "ok"
	ToneWarn    Tone = "warn"
	ToneErr     Tone = "err"
	ToneInfo    Tone = "info"
)

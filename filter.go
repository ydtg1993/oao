package oao

import (
	"sort"
	"strconv"
	"strings"
	"time"
)

// FilterSpec 描述"某个字段是按什么规则筛的"—— 来自表格声明，调用方不用猜。
type FilterSpec struct {
	Field   string
	Op      Op
	Kind    Kind
	Options map[string]string // In / 下拉的选项：值 -> 文案
}

// FilterValue 一个字段的筛选值，已带上它的算子与类型，方便按规则取值。
//
//	switch v := q.Get("status"); v.Op() {
//	case oao.OpIn:      ids := v.IntList()
//	case oao.OpBetween: from, to, _ := v.Range()
//	case oao.OpLike:    kw := v.String()
//	}
type FilterValue struct {
	spec FilterSpec
	raw  string
}

// Op 该字段声明的算子。
func (v FilterValue) Op() Op { return v.spec.Op }

// Kind 该字段声明的类型。
func (v FilterValue) Kind() Kind { return v.spec.Kind }

// Field 字段名（即 rows 里的 key）。
func (v FilterValue) Field() string { return v.spec.Field }

// Options In / 下拉的选项：值 -> 文案。
func (v FilterValue) Options() map[string]string { return v.spec.Options }

// Raw 未经处理的原始值：
//   - In      → "1,2,3"
//   - Between → "2026-01-01..2026-01-31"
//   - 其余    → 原样
func (v FilterValue) Raw() string { return v.raw }

// Empty 调用方没填这个筛选。
func (v FilterValue) Empty() bool { return strings.TrimSpace(v.raw) == "" }

// String 取字符串值（Eq / Like / Gt / Lt 用）。
func (v FilterValue) String() string { return v.raw }

// Int 取整数；解析失败返回 false。
func (v FilterValue) Int() (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(v.raw))
	if err != nil {
		return 0, false
	}
	return n, true
}

// Float 取浮点数；解析失败返回 false。
func (v FilterValue) Float() (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(v.raw), 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// Bool 取布尔值；认 1/0、true/false、yes/no。
func (v FilterValue) Bool() (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(v.raw)) {
	case "1", "true", "yes":
		return true, true
	case "0", "false", "no":
		return false, true
	}
	return false, false
}

// List 取多选值（In 用），已去掉空白项。
func (v FilterValue) List() []string {
	parts := strings.Split(v.raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// IntList 取整型多选（In + 数字字段用）；非数字项被跳过。
func (v FilterValue) IntList() []int {
	out := make([]int, 0, 4)
	for _, p := range v.List() {
		if n, err := strconv.Atoi(p); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// Range 取区间两端（Between 用）。值形如 "a..b"，两端都会 TrimSpace。
// 缺任一端返回 ok=false —— 说明这不是一个完整的区间条件。
func (v FilterValue) Range() (from, to string, ok bool) {
	lo, hi, found := strings.Cut(v.raw, "..")
	lo, hi = strings.TrimSpace(lo), strings.TrimSpace(hi)
	if !found || lo == "" || hi == "" {
		return "", "", false
	}
	return lo, hi, true
}

// Time 取时间值。依次尝试 RFC3339、2006-01-02 15:04:05、2006-01-02。
func (v FilterValue) Time() (time.Time, bool) {
	return parseTime(strings.TrimSpace(v.raw))
}

// TimeRange 取时间区间，两端**按输入原样解析**。
//
// 注意语义陷阱：如果选的是 2026-09-01 ~ 2026-09-10，返回的 to 是
// 2026-09-10T00:00:00 —— 直接 `BETWEEN from AND to` 会把 9/10 当天整天的数据漏掉。
// 按天筛选请用 DateRange()。
func (v FilterValue) TimeRange() (from, to time.Time, ok bool) {
	lo, hi, ok := v.Range()
	if !ok {
		return time.Time{}, time.Time{}, false
	}
	from, okFrom := parseTime(lo)
	to, okTo := parseTime(hi)
	if !okFrom || !okTo {
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

// DateRange 把日期区间解成**半开区间 [from, end)**，专给日期控件用：
//
//	from = 开始日 00:00
//	end  = 结束日的次日 00:00（所以 end 本身不含）
//
// 前端日期控件给的就是 2006-01-02，这样写才不会漏掉结束日当天：
//
//	from, end, ok := f.DateRange()
//	db.Where("created_at >= ? AND created_at < ?", from, end)
//
// 输入里带了时刻时按时刻处理：from 用原值，end 用该时刻（即 [from, end)）。
func (v FilterValue) DateRange() (from, end time.Time, ok bool) {
	lo, hi, ok := v.Range()
	if !ok {
		return time.Time{}, time.Time{}, false
	}
	from, okFrom := parseTime(lo)
	end, okTo := parseTime(hi)
	if !okFrom || !okTo {
		return time.Time{}, time.Time{}, false
	}
	if isDateOnly(lo) {
		from = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, from.Location())
	}
	if isDateOnly(hi) {
		end = end.AddDate(0, 0, 1) // 结束日整天都算在内
	}
	return from, end, true
}

// isDateOnly 判断原始输入是不是纯日期（2006-01-02），没有带时刻。
func isDateOnly(s string) bool { return len(s) == len("2006-01-02") }

func parseTime(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02", "2006-01-02T15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// Filters 返回本次查询里"声明过且调用方填了值"的筛选条件，按字段名排序。
//
// 这是给 Source 用的主入口 —— 拿着算子直接拼条件，不用自己维护一份字段白名单：
//
//	for _, f := range q.Filters() {
//	    switch f.Op() {
//	    case oao.OpLike:    db = db.Where(f.Field()+" LIKE ?", "%"+f.Raw()+"%")
//	    case oao.OpIn:      db = db.Where(f.Field()+" IN ?", f.IntList())
//	    case oao.OpBetween: from, to, _ := f.TimeRange(); ...
//	    }
//	}
func (q Query) Filters() []FilterValue {
	out := make([]FilterValue, 0, len(q.filterSpecs))
	names := make([]string, 0, len(q.filterSpecs))
	for name := range q.filterSpecs {
		names = append(names, name)
	}
	sort.Strings(names) // 固定顺序，Source 拼出来的 SQL 稳定、方便排查
	for _, name := range names {
		spec := q.filterSpecs[name]
		raw := strings.TrimSpace(q.Filter[name])
		if raw == "" {
			continue
		}
		// 半截区间不算有效条件
		if spec.Op == OpBetween {
			if _, _, ok := (FilterValue{raw: raw}).Range(); !ok {
				continue
			}
		}
		out = append(out, FilterValue{spec: spec, raw: raw})
	}
	return out
}

// Get 按字段名取筛选值；未声明或未填写时返回空值（用 Empty() 判断）。
// 未声明的字段一律取不到 —— 筛选白名单在组件这一层就把住了。
func (q Query) Get(field string) FilterValue {
	spec, ok := q.filterSpecs[field]
	if !ok {
		return FilterValue{}
	}
	return FilterValue{spec: spec, raw: strings.TrimSpace(q.Filter[field])}
}

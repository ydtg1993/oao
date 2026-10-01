package oao

import (
	"testing"
	"time"
)

func testQuery(filters []Filter, raw map[string]string) Query {
	specs := make(map[string]FilterSpec, len(filters))
	for _, f := range filters {
		op := f.Op
		if op == "" {
			op = OpEq
		}
		kind := f.Kind
		if kind == "" {
			kind = KindString
		}
		specs[f.Field] = FilterSpec{Field: f.Field, Op: op, Kind: kind, Options: f.Options}
	}
	return Query{Page: 1, Size: 20, Filter: raw, filterSpecs: specs}
}

var specFilters = []Filter{
	{Field: "stage", Op: OpEq},
	{Field: "url", Op: OpLike},
	{Field: "status", Op: OpIn, Kind: KindNumber},
	{Field: "tag", Op: OpIn},
	{Field: "created_at", Op: OpBetween, Kind: KindTime},
	{Field: "amount", Op: OpBetween, Kind: KindNumber},
	{Field: "downloaded", Op: OpEq, Kind: KindBool},
}

func TestFilterValueDecoding(t *testing.T) {
	q := testQuery(specFilters, map[string]string{
		"stage":      "detail",
		"url":        "example.com",
		"status":     "1, 2 ,3",
		"tag":        "a,,b",
		"created_at": "2026-09-01..2026-09-10",
		"amount":     "10..99.5",
		"downloaded": "true",
	})

	if v := q.Get("stage"); v.Op() != OpEq || v.String() != "detail" {
		t.Fatalf("stage = %+v", v)
	}
	if v := q.Get("url"); v.Op() != OpLike || v.String() != "example.com" {
		t.Fatalf("url = %+v", v)
	}
	if got := q.Get("status").IntList(); len(got) != 3 || got[0] != 1 || got[2] != 3 {
		t.Fatalf("status IntList = %v（应跳过空白）", got)
	}
	if got := q.Get("tag").List(); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("tag List = %v", got)
	}
	from, to, ok := q.Get("created_at").TimeRange()
	if !ok || from.Format("2006-01-02") != "2026-09-01" || to.Format("2006-01-02") != "2026-09-10" {
		t.Fatalf("created_at TimeRange = %v %v %v", from, to, ok)
	}
	lo, hi, ok := q.Get("amount").Range()
	if !ok || lo != "10" || hi != "99.5" {
		t.Fatalf("amount Range = %q %q %v", lo, hi, ok)
	}
	if b, ok := q.Get("downloaded").Bool(); !ok || !b {
		t.Fatalf("downloaded Bool = %v %v", b, ok)
	}
}

// 未声明的字段取不到 —— 筛选白名单在这一层就把住了。
func TestFilterValueUnknownField(t *testing.T) {
	q := testQuery(specFilters, map[string]string{"injected": "1 OR 1=1"})
	if v := q.Get("injected"); !v.Empty() || v.Op() != "" {
		t.Fatalf("未声明字段应取不到：%+v", v)
	}
}

// 半截区间不算有效条件：前端只填了一半时不该带着残缺条件去查库。
func TestIncompleteRangeDropped(t *testing.T) {
	for _, raw := range []string{"2026-09-01..", "..2026-09-10", "..", "2026-09-01", ""} {
		q := testQuery(specFilters, map[string]string{"created_at": raw})
		if _, _, ok := q.Get("created_at").Range(); ok {
			t.Fatalf("raw=%q 不该被当成完整区间", raw)
		}
		for _, f := range q.Filters() {
			if f.Field() == "created_at" {
				t.Fatalf("raw=%q 不该出现在 Filters() 里", raw)
			}
		}
	}
}

// Filters() 只返回"声明过且填了值"的，顺序固定。
func TestFiltersOnlyDeclaredAndFilled(t *testing.T) {
	q := testQuery(specFilters, map[string]string{
		"stage":   "detail",
		"unknown": "x", // 没声明
		"url":     "",  // 空值
	})
	got := q.Filters()
	if len(got) != 1 || got[0].Field() != "stage" {
		t.Fatalf("Filters() = %v, want 只有 stage", got)
	}

	// 多个字段时按字段名排序，Source 拼出来的 SQL 才稳定
	q2 := testQuery(specFilters, map[string]string{"url": "a", "stage": "b", "status": "1"})
	names := []string{}
	for _, f := range q2.Filters() {
		names = append(names, f.Field())
	}
	want := []string{"stage", "status", "url"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("排序 = %v, want %v", names, want)
		}
	}
}

func TestFilterValueTypeHelpers(t *testing.T) {
	q := testQuery(specFilters, map[string]string{"stage": "42"})
	if n, ok := q.Get("stage").Int(); !ok || n != 42 {
		t.Fatalf("Int = %d %v", n, ok)
	}
	if f, ok := q.Get("stage").Float(); !ok || f != 42 {
		t.Fatalf("Float = %v %v", f, ok)
	}
	if _, ok := q.Get("stage").Bool(); ok {
		t.Fatal("42 不该解析成布尔")
	}
	if _, ok := q.Get("stage").Time(); ok {
		t.Fatal("42 不该解析成时间")
	}

	q2 := testQuery(specFilters, map[string]string{"stage": "2026-09-01"})
	if ts, ok := q2.Get("stage").Time(); !ok || ts.Day() != 1 {
		t.Fatalf("Time = %v %v", ts, ok)
	}
	q3 := testQuery(specFilters, map[string]string{"stage": "2026-09-01T10:30:00+08:00"})
	if ts, ok := q3.Get("stage").Time(); !ok || ts.Hour() != 10 {
		t.Fatalf("RFC3339 Time = %v %v", ts, ok)
	}
}

func TestFilterValueMetadata(t *testing.T) {
	q := testQuery(specFilters, map[string]string{"status": "1"})
	v := q.Get("status")
	if v.Field() != "status" || v.Kind() != KindNumber || v.Op() != OpIn {
		t.Fatalf("元数据 = %s/%s/%s", v.Field(), v.Kind(), v.Op())
	}
	if v.Raw() != "1" || v.Empty() {
		t.Fatalf("原始值 = %q empty=%v", v.Raw(), v.Empty())
	}

	// Options 要能透给 Source（比如把值翻成文案）
	q2 := testQuery([]Filter{{Field: "status", Op: OpIn, Options: map[string]string{"1": "待审"}}},
		map[string]string{"status": "1"})
	if q2.Get("status").Options()["1"] != "待审" {
		t.Fatal("Options 没透出来")
	}
}

func TestActionRequestHelpers(t *testing.T) {
	// 表单提交的是 JSON，数字一律 float64
	req := ActionRequest{
		ID: "42",
		Values: map[string]any{
			"amount": float64(99),
			"remark": "改一下",
			"notify": true,
			"ratio":  1.5,
			"strNum": "7",
		},
		Row: map[string]any{"updated_at": "2026-09-01T10:00:00Z", "id": float64(42)},
	}

	if req.String("remark") != "改一下" {
		t.Fatalf("String = %q", req.String("remark"))
	}
	if n, ok := req.Int("amount"); !ok || n != 99 {
		t.Fatalf("Int(float64) = %d %v", n, ok)
	}
	if n, ok := req.Int("strNum"); !ok || n != 7 {
		t.Fatalf("Int(string) = %d %v", n, ok)
	}
	if !req.Bool("notify") {
		t.Fatal("Bool = false")
	}
	if f, ok := req.Float("ratio"); !ok || f != 1.5 {
		t.Fatalf("Float = %v %v", f, ok)
	}
	if req.Bool("missing") {
		t.Fatal("缺字段的 Bool 应为 false")
	}
	if _, ok := req.Int("remark"); ok {
		t.Fatal("非数字的 Int 应返回 false")
	}
	if got := req.RowString("id"); got != "42" {
		t.Fatalf("RowString(float64) = %q", got)
	}
	if ts, err := time.Parse(time.RFC3339, req.RowString("updated_at")); err != nil || ts.IsZero() {
		t.Fatalf("RowString 时间 = %v %v", ts, err)
	}
}

func testSortQuery(sortable []string, sort string) Query {
	m := make(map[string]bool, len(sortable))
	for _, n := range sortable {
		m[n] = true
	}
	return Query{Sort: sort, sortable: m}
}

func TestSortFieldsSingle(t *testing.T) {
	q := testSortQuery([]string{"id", "status", "created_at"}, "-status")
	got := q.SortFields()
	if len(got) != 1 || got[0].Field != "status" || !got[0].Desc {
		t.Fatalf("SortFields = %+v", got)
	}
}

// 多字段排序：逗号分隔，顺序即优先级。
func TestSortFieldsMulti(t *testing.T) {
	q := testSortQuery([]string{"id", "status", "amount"}, "-status,amount,id")
	got := q.SortFields()
	want := []SortField{{"status", true}, {"amount", false}, {"id", false}}
	if len(got) != len(want) {
		t.Fatalf("SortFields = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 个 = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// 未声明 / 不可排序列混在里面时只丢掉它，不影响其它键的顺序。
func TestSortFieldsDropsUndeclared(t *testing.T) {
	q := testSortQuery([]string{"id", "status"}, "-status,injected,id")
	got := q.SortFields()
	if len(got) != 2 || got[0].Field != "status" || got[1].Field != "id" {
		t.Fatalf("SortFields = %+v, want 只剩 status/id", got)
	}

	// 全是未声明的 → 空切片（交给业务决定默认顺序）
	inj := testSortQuery([]string{"id"}, "nope,id; DROP TABLE t")
	if got := inj.SortFields(); len(got) != 0 {
		t.Fatalf("注入式排序应被全部丢掉，得到 %+v", got)
	}
}

func TestSortFieldsEdges(t *testing.T) {
	q := testSortQuery([]string{"id"}, " id , ,-id ,")
	got := q.SortFields()
	if len(got) != 2 {
		t.Fatalf("空白项应被跳过：%+v", got)
	}
	if got[0].Field != "id" || got[0].Desc || !got[1].Desc {
		t.Fatalf("解析 = %+v", got)
	}

	if n := len(testSortQuery([]string{"id"}, "").SortFields()); n != 0 {
		t.Fatalf("空排序应返回空切片，得到 %d 个", n)
	}
}

// 按天筛选最容易错的地方：结束日当天不能被漏掉。
func TestDateRangeHalfOpen(t *testing.T) {
	q := testQuery(specFilters, map[string]string{"created_at": "2026-09-01..2026-09-10"})
	v := q.Get("created_at")

	// 原样的 TimeRange：结束端是 9/10 00:00，直接 BETWEEN 会漏掉当天
	_, rawTo, _ := v.TimeRange()
	if rawTo.Day() != 10 || rawTo.Hour() != 0 {
		t.Fatalf("TimeRange 的 to = %v（本就是这个语义）", rawTo)
	}

	from, end, ok := v.DateRange()
	if !ok {
		t.Fatal("DateRange 应解析成功")
	}
	if from.Format("2006-01-02 15:04") != "2026-09-01 00:00" {
		t.Fatalf("from = %v, want 9/1 00:00", from)
	}
	if end.Format("2006-01-02 15:04") != "2026-09-11 00:00" {
		t.Fatalf("end = %v, want 9/11 00:00（结束日次日，半开）", end)
	}

	// 半开区间要能圈住 9/10 当天任意时刻
	mid := time.Date(2026, 9, 10, 23, 59, 59, 0, from.Location())
	if mid.Before(from) || !mid.Before(end) {
		t.Fatalf("9/10 23:59:59 应落在区间内：from=%v end=%v", from, end)
	}
	// 9/11 00:00 应在区间外
	next := time.Date(2026, 9, 11, 0, 0, 0, 0, from.Location())
	if next.Before(end) {
		t.Fatal("9/11 00:00 不该落进来")
	}
}

// 输入带时刻时按时刻处理，不做补天。
func TestDateRangeWithTime(t *testing.T) {
	q := testQuery(specFilters, map[string]string{"created_at": "2026-09-01T08:00:00Z..2026-09-10T18:30:00Z"})
	from, end, ok := q.Get("created_at").DateRange()
	if !ok {
		t.Fatal("DateRange 应解析成功")
	}
	if from.Hour() != 8 {
		t.Fatalf("from = %v, want 保留时刻", from)
	}
	if end.Day() != 10 || end.Hour() != 18 || end.Minute() != 30 {
		t.Fatalf("end = %v, want 原样（不补天）", end)
	}
}

func TestDateRangeIncomplete(t *testing.T) {
	for _, raw := range []string{"2026-09-01..", "..2026-09-10", "..", ""} {
		q := testQuery(specFilters, map[string]string{"created_at": raw})
		if _, _, ok := q.Get("created_at").DateRange(); ok {
			t.Fatalf("raw=%q 不该解析成完整区间", raw)
		}
	}
}

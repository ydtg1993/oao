package oao

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeSource 记录收到的 Query，并按预设返回 —— 组件不碰数据层，所以测试也不需要真库。
type fakeSource struct {
	gotQuery Query
	rows     []map[string]any
	total    int64
	err      error
	calls    int
}

func (f *fakeSource) List(_ context.Context, q Query) ([]map[string]any, int64, error) {
	f.calls++
	f.gotQuery = q
	return f.rows, f.total, f.err
}

func newTestServer(t *testing.T, tables ...Table) (*httptest.Server, *Oao) {
	t.Helper()
	o, err := New(Config{Tables: tables})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, o
}

func get(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
	}
	return resp.StatusCode, body
}

func TestNewValidatesTable(t *testing.T) {
	src := &fakeSource{}
	cases := []struct {
		name string
		cfg  Config
	}{
		{"没有表", Config{}},
		{"key 为空", Config{Tables: []Table{{Columns: []Column{{Field: "a"}}, Source: src}}}},
		{"缺少 Source", Config{Tables: []Table{{Key: "t", Columns: []Column{{Field: "a"}}}}}},
		{"没有列", Config{Tables: []Table{{Key: "t", Source: src}}}},
		{"列缺 Field", Config{Tables: []Table{{Key: "t", Source: src, Columns: []Column{{Label: "x"}}}}}},
		{"列重复", Config{Tables: []Table{{Key: "t", Source: src,
			Columns: []Column{{Field: "a"}, {Field: "a"}}}}}},
		{"enum 缺映射", Config{Tables: []Table{{Key: "t", Source: src,
			Columns: []Column{{Field: "a", Render: RenderEnum}}}}}},
		{"custom 缺 HTML", Config{Tables: []Table{{Key: "t", Source: src,
			Columns: []Column{{Field: "a", Render: RenderCustom}}}}}},
		{"DefaultSort 不是已声明的列", Config{Tables: []Table{{Key: "t", Source: src,
			Columns: []Column{{Field: "a"}}, DefaultSort: "-b"}}}},
		{"筛选缺 Field", Config{Tables: []Table{{Key: "t", Source: src,
			Columns: []Column{{Field: "a"}}, Filters: []Filter{{Label: "x"}}}}}},
	}
	for _, c := range cases {
		if _, err := New(c.cfg); err == nil {
			t.Fatalf("%s：应当报错", c.name)
		}
	}
}

// 声明的留空项要补成具体值，前端拿到的永远是具体值。
func TestResolveFillsDefaults(t *testing.T) {
	src := &fakeSource{}
	_, o := newTestServer(t, Table{
		Key: "t", Source: src,
		Columns: []Column{
			{Field: "order_no"},                   // 全默认
			{Field: "created_at", Kind: KindTime}, // 推断成 time 渲染
			{Field: "amount", Kind: KindNumber, NoSort: true},
			{Field: "cover", Render: RenderImage}, // size 该补成 64
		},
		Filters: []Filter{{Field: "order_no"}}, // 字符串 -> like/input
	})
	info, _ := o.Table("t")

	if info.Label != "t" || info.Group != "General" {
		t.Fatalf("label/group = %q/%q", info.Label, info.Group)
	}
	if info.PageSize != 20 || len(info.PageSizes) != 3 {
		t.Fatalf("分页默认 = %d/%v", info.PageSize, info.PageSizes)
	}

	c := info.Columns
	if c[0].Label != "Order No" || c[0].Render != RenderText || c[0].Kind != KindString {
		t.Fatalf("默认列 = %+v", c[0])
	}
	if c[1].Render != RenderTime {
		t.Fatalf("KindTime 应推断成 time 渲染，得到 %s", c[1].Render)
	}
	if c[2].Sortable {
		t.Fatal("NoSort 的列不应可排序")
	}
	if c[3].Size != 64 {
		t.Fatalf("image 列 size 默认 = %d, want 64", c[3].Size)
	}
	if f := info.Filters[0]; f.Op != OpLike || f.Widget != WidgetInput {
		t.Fatalf("筛选默认 = %s/%s", f.Op, f.Widget)
	}
}

func TestListPassesQueryToSource(t *testing.T) {
	src := &fakeSource{
		rows:  []map[string]any{{"order_no": "ORD-1"}},
		total: 42,
	}
	srv, _ := newTestServer(t, Table{
		Key: "order", Source: src, DefaultSort: "-id", PageSize: 20,
		Columns: []Column{{Field: "id", Kind: KindNumber}, {Field: "order_no"}},
		Filters: []Filter{{Field: "order_no", Op: OpLike}},
	})

	code, body := get(t, srv.URL+"/api/oao/order?page=3&size=50&search=abc&sort=-order_no&filter[order_no]=ORD")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}

	// 组件把 HTTP 参数规范成 Query 交给业务
	q := src.gotQuery
	if q.Page != 3 || q.Size != 50 || q.Search != "abc" || q.Sort != "-order_no" {
		t.Fatalf("query = %+v", q)
	}
	if q.Filter["order_no"] != "ORD" {
		t.Fatalf("filter = %v", q.Filter)
	}

	// 响应把业务数据 + 列/筛选元数据一起回给前端
	if body["total"].(float64) != 42 {
		t.Fatalf("total = %v, want 42", body["total"])
	}
	if len(body["columns"].([]any)) != 2 || len(body["filters"].([]any)) != 1 {
		t.Fatalf("columns/filters 元数据缺失：%v / %v", body["columns"], body["filters"])
	}
}

func TestListQueryDefaults(t *testing.T) {
	src := &fakeSource{}
	srv, _ := newTestServer(t, Table{
		Key: "order", Source: src, PageSize: 30,
		Columns: []Column{{Field: "id"}},
	})

	// 不传任何参数：page 回退 1，size 回退表的 PageSize
	if code, _ := get(t, srv.URL+"/api/oao/order"); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if src.gotQuery.Page != 1 || src.gotQuery.Size != 30 {
		t.Fatalf("默认分页 = %d/%d, want 1/30", src.gotQuery.Page, src.gotQuery.Size)
	}

	// 非法值与越界值都被纠正
	get(t, srv.URL+"/api/oao/order?page=0&size=99999")
	if src.gotQuery.Page != 1 {
		t.Fatalf("page = %d, want 1", src.gotQuery.Page)
	}
	if src.gotQuery.Size != maxPageSize {
		t.Fatalf("size = %d, want 上限 %d", src.gotQuery.Size, maxPageSize)
	}

	get(t, srv.URL+"/api/oao/order?page=abc&size=-5")
	if src.gotQuery.Page != 1 || src.gotQuery.Size != 30 {
		t.Fatalf("非法参数回退失败 = %+v", src.gotQuery)
	}
}

func TestListErrorsAndEdges(t *testing.T) {
	src := &fakeSource{err: errors.New("boom")}
	srv, _ := newTestServer(t, Table{Key: "order", Source: src, Columns: []Column{{Field: "id"}}})

	if code, _ := get(t, srv.URL+"/api/oao/nope"); code != http.StatusNotFound {
		t.Fatalf("未知表 status = %d, want 404", code)
	}
	if code, _ := get(t, srv.URL+"/api/oao/order"); code != http.StatusInternalServerError {
		t.Fatalf("Source 报错 status = %d, want 500", code)
	}

	// Source 返回 nil 行时要回落成空数组，而不是 JSON null
	ok := &fakeSource{rows: nil, total: 0}
	srv2, _ := newTestServer(t, Table{Key: "t", Source: ok, Columns: []Column{{Field: "id"}}})
	code, body := get(t, srv2.URL+"/api/oao/t")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if rows, isArr := body["rows"].([]any); !isArr || len(rows) != 0 {
		t.Fatalf("rows = %#v, want 空数组", body["rows"])
	}
}

func TestTablesEndpoint(t *testing.T) {
	src := &fakeSource{}
	srv, _ := newTestServer(t,
		Table{Key: "zebra", Source: src, Columns: []Column{{Field: "a"}}},
		Table{Key: "alpha", Source: src, Columns: []Column{{Field: "a"}}},
	)
	code, body := get(t, srv.URL+"/api/oao/tables")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	tables := body["tables"].([]any)
	if len(tables) != 2 {
		t.Fatalf("tables = %d, want 2", len(tables))
	}
	if tables[0].(map[string]any)["key"] != "alpha" {
		t.Fatalf("清单应按 key 排序，首项 = %v", tables[0].(map[string]any)["key"])
	}
}

func TestMethodNotAllowed(t *testing.T) {
	src := &fakeSource{}
	srv, _ := newTestServer(t, Table{Key: "t", Source: src, Columns: []Column{{Field: "id"}}})

	resp, err := http.Post(srv.URL+"/api/oao/t", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
	if src.calls != 0 {
		t.Fatalf("非法方法不应触达 Source，实际调用了 %d 次", src.calls)
	}
}

// 鉴权中间件由宿主注入，组件只负责套上去。
func TestAuthMiddlewareApplied(t *testing.T) {
	src := &fakeSource{}
	o, err := New(Config{
		Tables: []Table{{Key: "t", Source: src, Columns: []Column{{Field: "id"}}}},
		Auth: func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Key") != "secret" {
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
				next.ServeHTTP(w, r)
			})
		},
	})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	if code, _ := get(t, srv.URL+"/api/oao/t"); code != http.StatusUnauthorized {
		t.Fatalf("无密钥 status = %d, want 401", code)
	}

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/oao/t", nil)
	req.Header.Set("X-Key", "secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("带密钥 status = %d, want 200", resp.StatusCode)
	}
}

func TestParseFilterIgnoresMalformed(t *testing.T) {
	got := parseFilter(map[string][]string{
		"filter[order_no]": {"x"},
		"filter[]":         {"y"},
		"filter[bad":       {"z"},
		"other":            {"w"},
	})
	if len(got) != 1 || got["order_no"] != "x" {
		t.Fatalf("parseFilter = %v, want 只留 order_no", got)
	}
}

// 没有筛选的表格，filters 要序列化成 []，不能是 null —— 前端就不必判空。
func TestEmptyFiltersSerializeAsArray(t *testing.T) {
	_, o := newTestServer(t, Table{Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "id"}}})
	b, err := json.Marshal(o.Tables()[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"filters":[]`) {
		t.Fatalf("序列化结果 = %s, want filters 为空数组", b)
	}
}

// 新增的一批校验：key 保留字 / URL 安全 / 重复 key / Prefix
func TestNewValidatesKeysAndPrefix(t *testing.T) {
	src := &fakeSource{}
	col := []Column{{Field: "a"}}
	cases := []struct {
		name string
		cfg  Config
	}{
		{"key 为保留字 tables", Config{Tables: []Table{{Key: "tables", Source: src, Columns: col}}}},
		{"key 带斜杠", Config{Tables: []Table{{Key: "a/b", Source: src, Columns: col}}}},
		{"key 带空格", Config{Tables: []Table{{Key: "a b", Source: src, Columns: col}}}},
		{"key 带中文", Config{Tables: []Table{{Key: "订单", Source: src, Columns: col}}}},
		{"key 重复", Config{Tables: []Table{
			{Key: "dup", Source: src, Columns: col},
			{Key: "dup", Source: src, Columns: col},
		}}},
		{"Prefix 缺前导斜杠", Config{Prefix: "api/oao", Tables: []Table{{Key: "t", Source: src, Columns: col}}}},
		{"Prefix 多余结尾斜杠", Config{Prefix: "/api/oao/", Tables: []Table{{Key: "t", Source: src, Columns: col}}}},
	}
	for _, c := range cases {
		if _, err := New(c.cfg); err == nil {
			t.Fatalf("%s：应当报错", c.name)
		}
	}

	// 合法的仍要通过
	if _, err := New(Config{Tables: []Table{{Key: "order_2026-x", Source: src, Columns: col}}}); err != nil {
		t.Fatalf("合法的 key 不该被拒：%v", err)
	}
}

// 排序白名单必须在注册时建好。
// 之前 markSortable 定义了却没被调用，导致 SortFields() 恒为空 ——
// 排序静默失效（表头箭头照显示、请求照带 sort，服务端全丢），且分页会重复/漏行。
// 这个用例特意走 New() 而不是手搓 Query，就是为了盯住它。
func TestSortableSetBuiltFromDeclaration(t *testing.T) {
	o, err := New(Config{Tables: []Table{{
		Key: "order", Source: &fakeSource{},
		Columns: []Column{
			{Field: "id", Kind: KindNumber},
			{Field: "amount", Kind: KindNumber},
			{Field: "note", NoSort: true},
		},
	}}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	info, _ := o.Table("order")

	// 声明的可排序列要能通过
	for _, name := range []string{"id", "amount", "-amount", "-id"} {
		if q := (Query{Sort: name, sortable: info.sortableSet}); len(q.SortFields()) != 1 {
			t.Fatalf("Sort=%q 应被接受，SortFields()=%v", name, q.SortFields())
		}
	}
	// NoSort 的列与未声明的列要被挡掉
	for _, name := range []string{"note", "nope"} {
		if q := (Query{Sort: name, sortable: info.sortableSet}); len(q.SortFields()) != 0 {
			t.Fatalf("Sort=%q 不该被接受", name)
		}
	}
}

// 多字段排序在真实注册流程下也要通。
func TestSortFieldsThroughNew(t *testing.T) {
	o, _ := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{},
		Columns:     []Column{{Field: "status", Kind: KindNumber}, {Field: "id", Kind: KindNumber}},
		DefaultSort: "-status,id",
	}}})
	info, _ := o.Table("t")
	q := Query{Sort: info.DefaultSort, sortable: info.sortableSet}
	got := q.SortFields()
	if len(got) != 2 || got[0].Field != "status" || !got[0].Desc || got[1].Field != "id" {
		t.Fatalf("SortFields = %+v, want [-status, id]", got)
	}
}

// bool 列默认渲染成"是/否"的标签，而不是裸 true/false。
func TestBoolColumnDefaultEnum(t *testing.T) {
	o, err := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{},
		Columns: []Column{{Field: "downloaded", Kind: KindBool}, {Field: "shown", Kind: KindBool, Enum: map[string]string{"true": "已展示"}}},
	}}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	info, _ := o.Table("t")
	if got := info.Columns[0].Enum["true"]; got != "是" {
		t.Fatalf("bool 列应有默认映射，得到 %q", got)
	}
	// 显式给的不该被覆盖
	if got := info.Columns[1].Enum["true"]; got != "已展示" {
		t.Fatalf("显式 Enum 被覆盖了：%q", got)
	}
}

// 会进路由 / data-field / SQL 列名的标识符都要限制字符集。
func TestNameValidation(t *testing.T) {
	bad := []struct {
		name string
		page Table
	}{
		{"列 Field 带引号", Table{Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: `a"b`}}}},
		{"列 Field 带空格", Table{Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "a b"}}}},
		{"筛选 Field 带斜杠", Table{Key: "t", Source: &fakeSource{},
			Columns: []Column{{Field: "a"}}, Filters: []Filter{{Field: "a/b"}}}},
		{"动作 Key 带斜杠", Table{Key: "t", Source: &fakeSource{},
			Columns: []Column{{Field: "a"}},
			Actions: []Action{{Key: "a/b", Handler: func(context.Context, ActionRequest) error { return nil }}}}},
		{"表单项 Name 带引号", Table{Key: "t", Source: &fakeSource{},
			Columns: []Column{{Field: "a"}},
			Actions: []Action{{Key: "ok", Handler: func(context.Context, ActionRequest) error { return nil },
				Form: []Field{{Name: `x"y`}}}}}},
	}
	for _, c := range bad {
		if _, err := New(Config{Tables: []Table{c.page}}); err == nil {
			t.Fatalf("%s：应当报错", c.name)
		}
	}
}

// Tables()/Table() 返回副本：调用方改了不影响内部状态（那些字段服务端也在读）。
func TestTablesReturnsCopy(t *testing.T) {
	o, _ := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "a", Label: "原始"}},
	}}})
	got := o.Tables()
	got[0].Columns[0].Label = "被改了"
	got[0].Filters = append(got[0].Filters, FilterInfo{Name: "x"})

	fresh, _ := o.Table("t")
	if fresh.Columns[0].Label != "原始" {
		t.Fatalf("内部元数据被外部改动了：%q", fresh.Columns[0].Label)
	}
	if len(fresh.Filters) != 0 {
		t.Fatalf("内部 Filters 被外部改动了：%v", fresh.Filters)
	}
}

// 主键字段：默认 id、可改；声明了 Actions 时它必须是声明过的列（否则前端定位不到目标行）。
func TestIDFieldContract(t *testing.T) {
	src := &fakeSource{}

	// 默认 id
	_, o := newTestServer(t, Table{Key: "t", Source: src, Columns: []Column{{Field: "id"}}})
	if info, _ := o.Table("t"); info.IDField != "id" {
		t.Fatalf("IDField 默认 = %q, want id", info.IDField)
	}

	noop := func(context.Context, ActionRequest) error { return nil }

	// 显式指定；主键列用 Hidden 也算声明过
	_, o = newTestServer(t, Table{
		Key: "t", Source: src, IDField: "order_no",
		Columns: []Column{{Field: "order_no", Hidden: true}, {Field: "amount"}},
		Actions: []Action{{Key: "ok", Handler: noop}},
	})
	if info, _ := o.Table("t"); info.IDField != "order_no" {
		t.Fatalf("IDField = %q, want order_no", info.IDField)
	}

	// 声明了 Actions 但主键列不在 Columns 里 → 注册就报错
	if _, err := New(Config{Tables: []Table{{
		Key: "t", Source: src, IDField: "order_no",
		Columns: []Column{{Field: "amount"}},
		Actions: []Action{{Key: "ok", Handler: noop}},
	}}}); err == nil {
		t.Fatal("主键列未声明时应当报错")
	}

	// 只读表（没有 Actions）不要求主键列
	if _, err := New(Config{Tables: []Table{{
		Key: "t", Source: src, Columns: []Column{{Field: "amount"}},
	}}}); err != nil {
		t.Fatalf("只读表不该要求主键列: %v", err)
	}

	// 元数据要经 /tables 下发：前端就是读 id_field 定位目标行的
	srv, _ := newTestServer(t, Table{
		Key: "t", Source: src, IDField: "order_no",
		Columns: []Column{{Field: "order_no", Hidden: true}, {Field: "amount"}},
	})
	_, body := get(t, srv.URL+"/api/oao/tables")
	tables, _ := body["tables"].([]any)
	if len(tables) != 1 {
		t.Fatalf("tables = %v", body["tables"])
	}
	first, _ := tables[0].(map[string]any)
	if first["id_field"] != "order_no" {
		t.Fatalf("tables 响应里的 id_field = %v, want order_no", first["id_field"])
	}
}

// NewTab 与 OpPrefix 要透传到元数据。
func TestNewTabAndOpPrefix(t *testing.T) {
	_, o := newTestServer(t, Table{
		Key: "t", Source: &fakeSource{},
		Columns: []Column{
			{Field: "url", Render: RenderLink, Href: "{url}", NewTab: true},
			{Field: "plain", Render: RenderLink, Href: "{plain}"},
		},
		Filters: []Filter{{Field: "url", Op: OpPrefix}},
	})
	info, _ := o.Table("t")

	cols := info.Columns
	if !cols[0].NewTab || cols[1].NewTab {
		t.Fatalf("NewTab 透传 = %v/%v, want true/false", cols[0].NewTab, cols[1].NewTab)
	}
	if f := info.Filters[0]; f.Op != OpPrefix || f.Widget != WidgetInput {
		t.Fatalf("OpPrefix 筛选 = %s/%s, want prefix/input", f.Op, f.Widget)
	}
}

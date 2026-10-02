package oao

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// recordingHandler 记录收到的 ActionRequest，并按需返回错误。
type recordingHandler struct {
	got  ActionRequest
	err  error
	call int
}

func (h *recordingHandler) fn() ActionHandler {
	return func(_ context.Context, req ActionRequest) error {
		h.call++
		h.got = req
		return h.err
	}
}

func actionServer(t *testing.T, actions []Action, onAction func(ActionEvent)) (*httptest.Server, *Oao) {
	t.Helper()
	return actionServerWith(t, Table{
		Key: "order", Source: &fakeSource{}, Columns: []Column{{Field: "id"}, {Field: "status"}},
		Actions: actions,
	}, onAction)
}

func actionServerWith(t *testing.T, table Table, onAction func(ActionEvent)) (*httptest.Server, *Oao) {
	t.Helper()
	o, err := New(Config{Tables: []Table{table}, OnAction: onAction})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, o
}

func postAction(t *testing.T, url, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return resp.StatusCode, strings.TrimSpace(string(b))
}

func TestActionForwarding(t *testing.T) {
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{
		{Key: "approve", Label: "审核通过",
			Form:    []Field{{Name: "reason"}},
			Handler: h.fn()},
	}, nil)

	code, body := postAction(t, srv.URL+"/api/oao/order/action/approve",
		`{"id":"42","values":{"reason":"ok"},"row":{"id":42,"status":1}}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", code, body)
	}
	if h.call != 1 {
		t.Fatalf("handler 调用次数 = %d, want 1", h.call)
	}
	got := h.got
	if got.Table != "order" || got.Action != "approve" || got.ID != "42" {
		t.Fatalf("request = %+v", got)
	}
	if got.Values["reason"] != "ok" {
		t.Fatalf("values = %v", got.Values)
	}
	// 整行原样回传，业务可以做乐观锁比对
	if got.Row["status"].(float64) != 1 {
		t.Fatalf("row = %v", got.Row)
	}
	if got.Req == nil {
		t.Fatal("逃生舱 Req 不该是 nil")
	}
}

// 表单没声明的字段不能进到业务手里 —— 否则照 README 写 Updates(req.Values)
// 就会被客户端塞进任意字段（mass assignment）。
func TestActionValuesFilteredByForm(t *testing.T) {
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{
		{Key: "edit", Form: []Field{{Name: "remark"}}, Handler: h.fn()},
		{Key: "approve", Handler: h.fn()}, // 无表单
	}, nil)

	postAction(t, srv.URL+"/api/oao/order/action/edit",
		`{"id":"1","values":{"remark":"正常","status":9,"is_admin":true,"password":"x"}}`)
	if len(h.got.Values) != 1 || h.got.Values["remark"] != "正常" {
		t.Fatalf("只该留下 remark，实际收到 %v", h.got.Values)
	}

	// 无表单的动作，任何字段都不该透传
	postAction(t, srv.URL+"/api/oao/order/action/approve", `{"id":"1","values":{"is_admin":true}}`)
	if len(h.got.Values) != 0 {
		t.Fatalf("无表单的动作不该收到字段，实际 %v", h.got.Values)
	}
}

// 未声明的字段不下发给浏览器。
func TestListRowsTrimmedToColumns(t *testing.T) {
	src := &fakeSource{rows: []map[string]any{
		{"id": 1, "order_no": "A", "password_hash": "secret", "internal_note": "不该出去"},
	}, total: 1}
	srv, _ := actionServerWith(t, Table{
		Key: "order", Source: src,
		Columns: []Column{{Field: "id"}, {Field: "order_no"}, {Field: "updated_at", Hidden: true}},
	}, nil)

	code, body := get(t, srv.URL+"/api/oao/order")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	row := body["rows"].([]any)[0].(map[string]any)
	if _, ok := row["password_hash"]; ok {
		t.Fatalf("未声明字段不该下发：%v", row)
	}
	if _, ok := row["internal_note"]; ok {
		t.Fatalf("未声明字段不该下发：%v", row)
	}
	if row["order_no"] != "A" {
		t.Fatalf("声明字段应保留：%v", row)
	}
}

// 没声明的动作就是不存在 —— 表默认只读，不需要额外的开关。
func TestUndeclaredActionIs404(t *testing.T) {
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{{Key: "approve", Handler: h.fn()}}, nil)

	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/remove", `{}`); code != http.StatusNotFound {
		t.Fatalf("未声明动作 status = %d, want 404", code)
	}
	if code, _ := postAction(t, srv.URL+"/api/oao/nope/action/approve", `{}`); code != http.StatusNotFound {
		t.Fatalf("未知表 status = %d, want 404", code)
	}
	if h.call != 0 {
		t.Fatalf("不该触达 handler，实际调用 %d 次", h.call)
	}
}

// 只读表（没声明 Actions）不注册任何操作。
func TestReadOnlyTableHasNoActions(t *testing.T) {
	srv, o := actionServer(t, nil, nil)
	info, _ := o.Table("order")
	if len(info.Actions) != 0 {
		t.Fatalf("actions = %v, want 空", info.Actions)
	}
	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/edit", `{}`); code != http.StatusNotFound {
		t.Fatalf("只读表的操作 status = %d, want 404", code)
	}
	// 序列化成 []，不是 null
	b, _ := json.Marshal(info)
	if !strings.Contains(string(b), `"actions":[]`) {
		t.Fatalf("序列化 = %s, want actions 为空数组", b)
	}
}

// 业务用 oao.Fail 指定状态码与提示语，组件原样透给前端。
func TestActionErrorMapping(t *testing.T) {
	h := &recordingHandler{err: Fail(http.StatusConflict, "该行已被他人修改")}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}}, nil)

	code, body := postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"1"}`)
	if code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", code)
	}
	if body != "该行已被他人修改" {
		t.Fatalf("body = %q", body)
	}
}

func TestActionPlainErrorIs500(t *testing.T) {
	h := &recordingHandler{err: errors.New("boom")}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}}, nil)
	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"1"}`); code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", code)
	}
}

// 成功与失败都要回调 OnAction，宿主才能记全审计。
func TestOnActionCalledForBothOutcomes(t *testing.T) {
	var events []ActionEvent
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}},
		func(ev ActionEvent) { events = append(events, ev) })

	postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"7"}`)
	h.err = Fail(http.StatusBadRequest, "不行")
	postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"8"}`)

	if len(events) != 2 {
		t.Fatalf("回调次数 = %d, want 2", len(events))
	}
	if events[0].Err != nil || events[0].ID != "7" {
		t.Fatalf("成功事件 = %+v", events[0])
	}
	if events[1].Err == nil || events[1].ID != "8" {
		t.Fatalf("失败事件 = %+v", events[1])
	}
	if events[0].At.IsZero() {
		t.Fatal("事件应带时间戳")
	}
	// 事件要带上触发它的请求，宿主才能从上下文里取身份（审计记人）
	if events[0].Req == nil {
		t.Fatal("事件应带 Req")
	}
}

func TestActionRequestMethodAndBody(t *testing.T) {
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}}, nil)

	// 非 POST 不触达 handler
	resp, err := http.Get(srv.URL + "/api/oao/order/action/edit")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", resp.StatusCode)
	}
	if h.call != 0 {
		t.Fatal("非法方法不该触达 handler")
	}

	// 空 body 也允许（没有表单的确认型操作）
	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/edit", ""); code != http.StatusOK {
		t.Fatalf("空 body status = %d, want 200", code)
	}
	// 非法 JSON 返回 400
	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/edit", "{oops"); code != http.StatusBadRequest {
		t.Fatalf("坏 body status = %d, want 400", code)
	}
}

// 自动表单跳过只读展示列与标了 NoEdit 的列。
func TestEditActionDerivesForm(t *testing.T) {
	h := &recordingHandler{}
	_, o := func() (*Oao, *Oao) {
		o, err := New(Config{Tables: []Table{{
			Key: "order", Source: &fakeSource{},
			Columns: []Column{
				{Field: "id", Kind: KindNumber, NoEdit: true},
				{Field: "order_no"},
				{Field: "status", Kind: KindNumber, Render: RenderEnum, Enum: map[string]string{"1": "待审"}},
				{Field: "cover", Render: RenderImage},
				{Field: "payload", Kind: KindJSON},
				{Field: "created_at", Kind: KindTime, NoEdit: true},
			},
			Actions: []Action{EditAction(h.fn())},
		}}})
		if err != nil {
			t.Fatalf("new: %v", err)
		}
		return o, o
	}()

	info, _ := o.Table("order")
	form := info.Actions[0].Form
	names := make([]string, 0, len(form))
	for _, f := range form {
		names = append(names, f.Name)
	}
	want := []string{"order_no", "status"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("自动表单字段 = %v, want %v（id/created_at 标了 NoEdit，cover/payload 是只读展示）", names, want)
	}
	if form[1].Widget != WidgetSelect || form[1].Options["1"] != "待审" {
		t.Fatalf("枚举列该渲染成下拉：%+v", form[1])
	}
}

func TestActionValidation(t *testing.T) {
	cases := []struct {
		name string
		act  Action
	}{
		{"缺 Key", Action{Handler: func(context.Context, ActionRequest) error { return nil }}},
		{"缺 Handler", Action{Key: "x"}},
		{"表单项缺 Name", Action{Key: "x", Handler: func(context.Context, ActionRequest) error { return nil },
			Form: []Field{{Label: "无名字段"}}}},
	}
	for _, c := range cases {
		_, err := New(Config{Tables: []Table{{
			Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "id"}}, Actions: []Action{c.act},
		}}})
		if err == nil {
			t.Fatalf("%s：应当报错", c.name)
		}
	}

	// Key 重复
	noop := func(context.Context, ActionRequest) error { return nil }
	_, err := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "id"}},
		Actions: []Action{{Key: "dup", Handler: noop}, {Key: "dup", Handler: noop}},
	}}})
	if err == nil {
		t.Fatal("重复 Action Key 应当报错")
	}
}

// 审计回调自己 panic 不能连累业务操作。
func TestOnActionPanicIsolated(t *testing.T) {
	h := &recordingHandler{}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}},
		func(ev ActionEvent) { panic("审计实现有 bug") })

	code, _ := postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"1"}`)
	if code != http.StatusOK {
		t.Fatalf("审计 panic 不该影响操作结果，status = %d", code)
	}
	if h.call != 1 {
		t.Fatal("业务 handler 应已执行")
	}
}

// 非 Fail 的错误细节不回给前端。
func TestInternalErrorNotLeaked(t *testing.T) {
	h := &recordingHandler{err: errors.New("dial tcp 10.0.0.5:3306: connection refused")}
	srv, _ := actionServer(t, []Action{{Key: "edit", Handler: h.fn()}}, nil)

	code, body := postAction(t, srv.URL+"/api/oao/order/action/edit", `{"id":"1"}`)
	if code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", code)
	}
	if strings.Contains(body, "3306") || strings.Contains(body, "dial tcp") {
		t.Fatalf("内部错误细节不该外泄，实际 body = %q", body)
	}
}

// Fail 传 2xx 或越界值统一兜成 500，否则前端会判成成功。
func TestFailStatusClamped(t *testing.T) {
	for _, st := range []int{http.StatusOK, 0, 100, 302, 700} {
		h := &recordingHandler{err: Fail(st, "失败")}
		srv, _ := actionServer(t, []Action{{Key: "e", Handler: h.fn()}}, nil)
		code, _ := postAction(t, srv.URL+"/api/oao/order/action/e", `{"id":"1"}`)
		if st == 0 {
			if code != http.StatusBadRequest {
				t.Fatalf("Fail(0) 应兜成 400，得到 %d", code)
			}
			continue
		}
		if code < 400 {
			t.Fatalf("Fail(%d) 应兜成 5xx/4xx，得到 %d", st, code)
		}
	}
}

// 重复筛选项要在注册时报错（否则元数据里会出现两个同名控件）。
func TestDuplicateFilterRejected(t *testing.T) {
	_, err := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "a"}},
		Filters: []Filter{{Field: "a", Op: OpEq}, {Field: "a", Op: OpLike}},
	}}})
	if err == nil {
		t.Fatal("重复筛选字段应当报错")
	}
}

// DefaultSort 支持多字段。
func TestDefaultSortMultiField(t *testing.T) {
	o, err := New(Config{Tables: []Table{{
		Key: "t", Source: &fakeSource{},
		Columns:     []Column{{Field: "id", Kind: KindNumber}, {Field: "status", Kind: KindNumber}},
		DefaultSort: "-status,id",
	}}})
	if err != nil {
		t.Fatalf("多字段 DefaultSort 不该报错：%v", err)
	}
	info, _ := o.Table("t")
	if info.DefaultSort != "-status,id" {
		t.Fatalf("DefaultSort = %q", info.DefaultSort)
	}

	// 里面混了未声明的列要报错
	if _, err := New(Config{Tables: []Table{{
		Key: "t2", Source: &fakeSource{},
		Columns:     []Column{{Field: "id"}},
		DefaultSort: "id,nope",
	}}}); err == nil {
		t.Fatal("DefaultSort 里有未声明的列应当报错")
	}
}

// 宿主的鉴权中间件写进请求上下文的身份，必须能从 OnAction 的 ev.Req 里读回来 ——
// 这是「审计记人」依赖的那条链路（组件不解释身份，只把请求带出来）。
func TestOnActionEventCarriesRequestContext(t *testing.T) {
	type ctxKey struct{}
	var got string
	o, err := New(Config{
		Tables: []Table{{
			Key: "t", Source: &fakeSource{},
			Columns: []Column{{Field: "id", Kind: KindNumber}},
			Actions: []Action{{Key: "go", Handler: func(context.Context, ActionRequest) error { return nil }}},
		}},
		Auth: func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, "张三")))
			})
		},
		OnAction: func(ev ActionEvent) {
			if ev.Req != nil {
				got, _ = ev.Req.Context().Value(ctxKey{}).(string)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	postAction(t, srv.URL+"/api/oao/t/action/go", `{"id":"1"}`)
	if got != "张三" {
		t.Fatalf("从 ev.Req 的上下文里读到 %q, want 张三", got)
	}
}

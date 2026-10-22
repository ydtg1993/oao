package oao

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeLogger 记下组件打过的日志：出错时是静默还是留痕，是宿主排查问题的唯一线索。
type fakeLogger struct {
	infos  []string
	errors []string
}

func (l *fakeLogger) Infof(format string, args ...any) {
	l.infos = append(l.infos, fmt.Sprintf(format, args...))
}

func (l *fakeLogger) Errorf(format string, args ...any) {
	l.errors = append(l.errors, fmt.Sprintf(format, args...))
}

func contains(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func loggerServer(t *testing.T, logger Logger, tbl Table, onAction func(ActionEvent)) *httptest.Server {
	t.Helper()
	o, err := New(Config{Tables: []Table{tbl}, Logger: logger, OnAction: onAction})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// 挂了 Logger 就得留痕：注册、列表失败、操作失败各一条。
func TestLoggerRecordsFailures(t *testing.T) {
	log := &fakeLogger{}
	src := &fakeSource{err: errors.New("source 挂了")}
	srv := loggerServer(t, log, Table{
		Key: "order", Source: src, Columns: []Column{{Field: "id"}},
	}, nil)

	if !contains(log.infos, `table "order" registered`) {
		t.Fatalf("注册时没记日志：%v", log.infos)
	}

	if code, _ := get(t, srv.URL+"/api/oao/order"); code != http.StatusInternalServerError {
		t.Fatalf("列表失败 status = %d, want 500", code)
	}
	if !contains(log.errors, "source 挂了") {
		t.Fatalf("列表失败没记日志：%v", log.errors)
	}

	srv2 := loggerServer(t, log, Table{
		Key: "order2", Source: &fakeSource{}, Columns: []Column{{Field: "id"}},
		Actions: []Action{{Key: "remove", Handler: func(context.Context, ActionRequest) error {
			return errors.New("删不掉")
		}}},
	}, nil)
	if code, _ := postAction(t, srv2.URL+"/api/oao/order2/action/remove", `{"id":"1"}`); code != http.StatusInternalServerError {
		t.Fatalf("操作失败 status = %d, want 500", code)
	}
	if !contains(log.errors, "删不掉") {
		t.Fatalf("操作失败没记日志：%v", log.errors)
	}
}

// 审计回调自己 panic：业务操作照常成功，但日志里要留下这一笔。
func TestLoggerRecordsOnActionPanic(t *testing.T) {
	log := &fakeLogger{}
	srv := loggerServer(t, log, Table{
		Key: "order", Source: &fakeSource{}, Columns: []Column{{Field: "id"}},
		Actions: []Action{{Key: "ok", Handler: func(context.Context, ActionRequest) error { return nil }}},
	}, func(ActionEvent) { panic("审计实现有 bug") })

	if code, _ := postAction(t, srv.URL+"/api/oao/order/action/ok", `{"id":"1"}`); code != http.StatusOK {
		t.Fatalf("status = %d, want 200", code)
	}
	if !contains(log.errors, "OnAction panic") {
		t.Fatalf("审计 panic 没记日志：%v", log.errors)
	}
}

// 动作的 StateFunc 按行计算文案/禁用/隐藏，组件把它们挂到每行的 __oao_actions 下。
func TestListAttachesRowActionStates(t *testing.T) {
	src := &fakeSource{rows: []map[string]any{
		{"id": 1, "status": "a"},
		{"id": 2, "status": "b"},
	}}
	srv, _ := newTestServer(t, Table{
		Key: "t", Source: src,
		Columns: []Column{{Field: "id", Kind: KindNumber}, {Field: "status"}},
		Actions: []Action{{
			Key: "go", Label: "走",
			Handler: func(context.Context, ActionRequest) error { return nil },
			StateFunc: func(row map[string]any) ActionState {
				if row["status"] == "a" {
					return ActionState{Label: "甲", Disabled: true}
				}
				return ActionState{Hidden: true}
			},
		}},
	})

	code, body := get(t, srv.URL+"/api/oao/t")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	rows, ok := body["rows"].([]any)
	if !ok || len(rows) != 2 {
		t.Fatalf("rows = %#v", body["rows"])
	}
	first := rows[0].(map[string]any)
	states, ok := first["__oao_actions"].(map[string]any)
	if !ok {
		t.Fatalf("first row actions = %#v", first["__oao_actions"])
	}
	state, ok := states["go"].(map[string]any)
	if !ok || state["label"] != "甲" || state["disabled"] != true {
		t.Fatalf("first go state = %#v", states["go"])
	}
	second := rows[1].(map[string]any)
	secondStates, ok := second["__oao_actions"].(map[string]any)
	if !ok || secondStates["go"].(map[string]any)["hidden"] != true {
		t.Fatalf("second row should hide the action: %#v", second["__oao_actions"])
	}
}

// StateFunc 返回零值时回退表级默认，不给行挂多余字段。
func TestListOmitsDefaultRowActionStates(t *testing.T) {
	src := &fakeSource{rows: []map[string]any{{"id": 1}}}
	srv, _ := newTestServer(t, Table{
		Key: "t", Source: src, Columns: []Column{{Field: "id", Kind: KindNumber}},
		Actions: []Action{{
			Key: "go", Label: "走",
			Handler:   func(context.Context, ActionRequest) error { return nil },
			StateFunc: func(map[string]any) ActionState { return ActionState{} },
		}},
	})
	_, body := get(t, srv.URL+"/api/oao/t")
	row := body["rows"].([]any)[0].(map[string]any)
	if _, exists := row["__oao_actions"]; exists {
		t.Fatalf("default state should be omitted: %#v", row["__oao_actions"])
	}
}

// /tables 是给侧边栏菜单读的，只认 GET。
func TestTablesEndpointRejectsNonGET(t *testing.T) {
	o, err := New(Config{Tables: []Table{{Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "a"}}}}})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	mux := http.NewServeMux()
	o.Mount(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/oao/tables", strings.NewReader("{}")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

// clientIP 拿到的是直连来源：带端口要剥掉端口，剥不动就原样返回，不留空 IP。
func TestClientIP(t *testing.T) {
	cases := map[string]string{
		"192.0.2.7:51000":   "192.0.2.7",
		"[2001:db8::1]:443": "2001:db8::1",
		"192.0.2.7":         "192.0.2.7",
		"":                  "",
	}
	for in, want := range cases {
		if got := clientIP(&http.Request{RemoteAddr: in}); got != want {
			t.Fatalf("clientIP(%q) = %q, want %q", in, got, want)
		}
	}
}

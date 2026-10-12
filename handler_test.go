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

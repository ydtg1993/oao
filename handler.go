package oao

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

// maxPageSize 单页最大条数，防止前端传个巨大 size 让业务 Source 一次捞全表。
const maxPageSize = 200

// Mount 把组件的 API 挂到宿主的 mux 上，并套上宿主注入的鉴权中间件。
// 静态资源不在这里挂 —— 宿主自己把 StaticFS 挂到想要的路径。
func (o *Oao) Mount(mux *http.ServeMux) {
	routes := []struct {
		path    string
		handler http.HandlerFunc
	}{
		{o.cfg.Prefix + "/tables", o.handleTables},
		{o.cfg.Prefix + "/{table}", o.handleList},
	}
	for _, r := range routes {
		h := http.Handler(r.handler)
		if o.cfg.Auth != nil {
			h = o.cfg.Auth(h)
		}
		mux.Handle(r.path, h)
	}
}

// handleTables 返回表格清单（侧边栏菜单用）。
func (o *Oao) handleTables(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, map[string]any{"tables": o.tables})
}

// handleList 解析查询参数后转给业务的 Source，再把结果按列声明回给前端。
func (o *Oao) handleList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.PathValue("table")
	table, ok := o.byKey[key]
	if !ok {
		http.Error(w, "unknown table", http.StatusNotFound)
		return
	}

	q := parseQuery(r, table)
	rows, total, err := table.source.List(r.Context(), q)
	if err != nil {
		if o.cfg.Logger != nil {
			o.cfg.Logger.Errorf("oao: list %s: %s", key, err.Error())
		}
		http.Error(w, "query failed", http.StatusInternalServerError)
		return
	}
	if rows == nil {
		rows = []map[string]any{}
	}

	writeJSON(w, map[string]any{
		"total":   total,
		"page":    q.Page,
		"size":    q.Size,
		"columns": table.Columns,
		"filters": table.Filters,
		"rows":    rows,
	})
}

// parseQuery 把 HTTP 参数解析成规范查询条件。
// 非法值一律回退到默认值，不把错误留给 Source 去判断。
func parseQuery(r *http.Request, table *TableInfo) Query {
	qs := r.URL.Query()
	size := atoiDefault(qs.Get("size"), table.PageSize)
	if size < 1 {
		size = table.PageSize
	}
	if size > maxPageSize {
		size = maxPageSize
	}
	page := atoiDefault(qs.Get("page"), 1)
	if page < 1 {
		page = 1
	}
	return Query{
		Page:   page,
		Size:   size,
		Search: qs.Get("search"),
		Sort:   qs.Get("sort"),
		Filter: parseFilter(qs),
	}
}

func parseFilter(qs map[string][]string) map[string]string {
	const prefix = "filter["
	out := map[string]string{}
	for k, vs := range qs {
		if len(vs) == 0 || !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, "]") {
			continue
		}
		col := k[len(prefix) : len(k)-1]
		if col != "" {
			out[col] = vs[0]
		}
	}
	return out
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

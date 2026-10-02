package oao

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// maxPageSize 单页最大条数，防止前端传个巨大 size 让业务 Source 一次捞全表。
const maxPageSize = 200

// maxActionBody 操作请求体上限（Row 会带上整行，给宽一点但要有边界）。
const maxActionBody = 1 << 20 // 1 MiB

// Mount 把组件的 API 挂到宿主的 mux 上，并套上宿主注入的鉴权中间件。
// 静态资源不在这里挂 —— 宿主自己把 StaticFS 挂到想要的路径。
func (o *Oao) Mount(mux *http.ServeMux) {
	routes := []struct {
		path    string
		handler http.HandlerFunc
	}{
		{o.cfg.Prefix + "/tables", o.handleTables},
		{o.cfg.Prefix + "/{table}", o.handleList},
		{o.cfg.Prefix + "/{table}/action/{key}", o.handleAction},
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

// handleAction 把前端操作请求转发给业务注册的 Handler。
// 组件只做三件事：找不到表/动作返回 404、解析请求体、把结果映射成状态码。
func (o *Oao) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	key := r.PathValue("table")
	table, ok := o.byKey[key]
	if !ok {
		http.Error(w, "unknown table", http.StatusNotFound)
		return
	}
	actionKey := r.PathValue("key")
	handler, ok := table.actionByName[actionKey]
	if !ok {
		// 没声明的动作就是不存在 —— 表默认只读，不需要额外的开关
		http.Error(w, "unknown action", http.StatusNotFound)
		return
	}

	var body struct {
		ID     string         `json:"id"`
		Values map[string]any `json:"values"`
		Row    map[string]any `json:"row"`
	}
	if r.Body != nil {
		// 限制请求体：Row 是整行回传，没有上限的话一个畸形请求就能吃光内存
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxActionBody))
		if err := dec.Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
	}

	req := ActionRequest{
		Table: key, Action: actionKey, ID: body.ID,
		Values: declaredValues(body.Values, table.actionFields[actionKey]),
		Row:    body.Row, Req: r,
	}
	err := handler(r.Context(), req)

	if o.cfg.OnAction != nil {
		o.safeOnAction(ActionEvent{
			Table: key, Action: actionKey, ID: body.ID, Values: req.Values,
			Err: err, IP: clientIP(r), At: time.Now(),
			Req: r, // 宿主可从它取上下文里的身份（组件不解释）
		})
	}

	if err != nil {
		status, msg := asActionError(err)
		if status >= http.StatusInternalServerError && o.cfg.Logger != nil {
			o.cfg.Logger.Errorf("oao: action %s/%s id=%s: %s", key, actionKey, body.ID, err.Error())
		}
		http.Error(w, msg, status)
		return
	}
	writeJSON(w, map[string]any{"status": "ok"})
}

// safeOnAction 调用宿主的审计回调，并隔离它的 panic ——
// 记审计是旁路，不该因为它自己出问题就让业务操作看起来失败。
func (o *Oao) safeOnAction(ev ActionEvent) {
	defer func() {
		if r := recover(); r != nil && o.cfg.Logger != nil {
			o.cfg.Logger.Errorf("oao: OnAction panic: %v", r)
		}
	}()
	o.cfg.OnAction(ev)
}

// clientIP 取直连来源 IP（不信任 X-Forwarded-For，可被伪造）。
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
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
	rows = trimRows(rows, table.Columns)

	writeJSON(w, map[string]any{
		"total":   total,
		"page":    q.Page,
		"size":    q.Size,
		"columns": table.Columns,
		"filters": table.Filters,
		"actions": table.Actions,
		"rows":    rows,
	})
}

// trimRows 按列声明裁剪每一行。
// Source 常常是 SELECT *，不裁的话没声明的字段（密码哈希、大 JSON）会一路发到浏览器 ——
// 既是信息暴露，也是白传的流量。想下发但不显示，把列声明成 Hidden。
func trimRows(rows []map[string]any, cols []ColumnInfo) []map[string]any {
	keep := make(map[string]bool, len(cols))
	for _, c := range cols {
		keep[c.Name] = true
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		trimmed := make(map[string]any, len(cols))
		for k, v := range row {
			if keep[k] {
				trimmed[k] = v
			}
		}
		out = append(out, trimmed)
	}
	return out
}

// declaredValues 只留下动作 Form 里声明过的字段。
// 不做这层过滤，客户端多塞的字段会一路进到业务的 Updates —— mass assignment。
func declaredValues(raw map[string]any, declared map[string]bool) map[string]any {
	out := make(map[string]any, len(declared))
	for k, v := range raw {
		if declared[k] {
			out[k] = v
		}
	}
	return out
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
		Page:        page,
		Size:        size,
		Search:      qs.Get("search"),
		Sort:        qs.Get("sort"),
		Filter:      declaredOnly(parseFilter(qs), table.filterSpecs),
		filterSpecs: table.filterSpecs,
		sortable:    table.sortableSet,
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

// declaredOnly 丢掉没声明过的筛选字段。
// 白名单在组件这一层就要把住 —— 让未声明的参数流到 Source 手里是个坑。
func declaredOnly(raw map[string]string, declared map[string]FilterSpec) map[string]string {
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		if _, ok := declared[k]; ok {
			out[k] = v
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

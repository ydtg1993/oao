// 独立 demo：不依赖任何外部库，用内存假数据把 oao 组件跑起来看效果。
//
//	go run ./cmd/demo          # 默认 :8090
//	浏览器打开 http://localhost:8090
//
// 这里的 orderSource 同时充当"业务层怎么实现 oao.Source"的参考实现 ——
// 组件本身不碰数据，筛选/排序/分页都由业务自己决定怎么落到存储上。
package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ydtg1993/oao"
)

//go:embed web
var webFS embed.FS

// Order 演示数据。真实项目里这就是一个 GORM 模型。
type Order struct {
	ID        int
	OrderNo   string
	Status    int
	Amount    float64
	Cover     string
	Remark    string
	Payload   string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func main() {
	src := &orderSource{rows: seed()}

	o, err := oao.New(oao.Config{
		Logger: stdLogger{},
		Tables: []oao.Table{
			{
				Key: "order", Label: "订单管理", Group: "业务",
				Source: src,
				Columns: []oao.Column{
					{Field: "id", Label: "ID", Kind: oao.KindNumber, Width: "70px"},
					{Field: "order_no", Label: "订单号"},
					{Field: "status", Label: "状态", Kind: oao.KindNumber, Render: oao.RenderEnum,
						Enum: map[string]string{"1": "待审", "2": "通过", "3": "驳回"},
						Tone: map[string]string{"1": "warn", "2": "ok", "3": "err"}},
					{Field: "amount", Label: "金额", Kind: oao.KindNumber},
					{Field: "cover", Label: "封面", Render: oao.RenderImage, Size: 56},
					{Field: "remark", Label: "备注", Render: oao.RenderInput, MaxLen: 30},
					{Field: "payload", Label: "附加数据", Kind: oao.KindJSON},
					{Field: "created_at", Label: "创建时间", Kind: oao.KindTime},
				},
				Filters: []oao.Filter{
					{Field: "order_no", Label: "订单号", Op: oao.OpLike},
					{Field: "status", Label: "状态", Kind: oao.KindNumber, Op: oao.OpIn,
						Options: map[string]string{"1": "待审", "2": "通过", "3": "驳回"}},
					{Field: "created_at", Label: "创建时间", Kind: oao.KindTime, Op: oao.OpBetween},
				},
				DefaultSort: "-id",
				PageSize:    20,
			},
			{
				// 极简声明：只给列名，其余全自动推断
				Key: "order_simple", Label: "订单（极简声明）", Group: "业务",
				Source: src,
				Columns: []oao.Column{
					{Field: "id"}, {Field: "order_no"}, {Field: "status"},
					{Field: "amount"}, {Field: "remark"},
				},
				DefaultSort: "id",
			},
		},
	})
	if err != nil {
		log.Fatalf("new oao: %v", err)
	}

	mux := http.NewServeMux()
	o.Mount(mux)

	static, err := o.StaticFS()
	if err != nil {
		log.Fatalf("static fs: %v", err)
	}
	mux.Handle("/static/oao/", http.StripPrefix("/static/oao/", http.FileServer(http.FS(static))))

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("web fs: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(web)))

	log.Println("oao demo: http://localhost:8090")
	log.Fatal(http.ListenAndServe(":8090", mux))
}

// orderSource 内存数据源 —— 组件不碰数据，这些全在"业务层"。
type orderSource struct{ rows []Order }

// List 实现 oao.Source：过滤 → 排序 → 分页 → 转成行。
func (s *orderSource) List(_ context.Context, q oao.Query) ([]map[string]any, int64, error) {
	rows := make([]Order, 0, len(s.rows))
	for _, r := range s.rows {
		if match(r, q) {
			rows = append(rows, r)
		}
	}
	sortRows(rows, q.Sort)

	total := int64(len(rows))
	from := (q.Page - 1) * q.Size
	if from > len(rows) {
		from = len(rows)
	}
	to := from + q.Size
	if to > len(rows) {
		to = len(rows)
	}

	out := make([]map[string]any, 0, to-from)
	for _, r := range rows[from:to] {
		out = append(out, map[string]any{
			"id": r.ID, "order_no": r.OrderNo, "status": r.Status, "amount": r.Amount,
			"cover": r.Cover, "remark": r.Remark, "payload": r.Payload,
			"created_at": r.CreatedAt, "updated_at": r.UpdatedAt,
		})
	}
	return out, total, nil
}

// match 按 oao.Query 里的筛选条件与搜索词判断一行是否命中。
// 算子语义由业务自己解释 —— 组件只透传。
func match(r Order, q oao.Query) bool {
	if kw := strings.TrimSpace(q.Search); kw != "" {
		if !strings.Contains(r.OrderNo, kw) && !strings.Contains(r.Remark, kw) {
			return false
		}
	}
	for name, val := range q.Filter {
		if val == "" {
			continue
		}
		switch name {
		case "order_no":
			if !strings.Contains(r.OrderNo, val) {
				return false
			}
		case "status":
			hit := false
			for _, part := range strings.Split(val, ",") {
				if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n == r.Status {
					hit = true
				}
			}
			if !hit {
				return false
			}
		case "created_at":
			lo, hi, ok := strings.Cut(val, "..")
			if !ok {
				continue
			}
			if t, err := time.ParseInLocation("2006-01-02", lo, time.Local); err == nil && r.CreatedAt.Before(t) {
				return false
			}
			if t, err := time.ParseInLocation("2006-01-02", hi, time.Local); err == nil && r.CreatedAt.After(t.AddDate(0, 0, 1)) {
				return false
			}
		}
	}
	return true
}

func sortRows(rows []Order, sortKey string) {
	if sortKey == "" {
		return
	}
	desc := strings.HasPrefix(sortKey, "-")
	name := strings.TrimPrefix(sortKey, "-")
	less := func(i, j int) bool {
		switch name {
		case "order_no":
			return rows[i].OrderNo < rows[j].OrderNo
		case "status":
			return rows[i].Status < rows[j].Status
		case "amount":
			return rows[i].Amount < rows[j].Amount
		case "created_at":
			return rows[i].CreatedAt.Before(rows[j].CreatedAt)
		default:
			return rows[i].ID < rows[j].ID
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if desc {
			return less(j, i)
		}
		return less(i, j)
	})
}

// seed 造 60 条覆盖各种取值形态的假数据。
func seed() []Order {
	statuses := []int{1, 2, 3}
	rows := make([]Order, 0, 60)
	for i := 1; i <= 60; i++ {
		rows = append(rows, Order{
			ID:        i,
			OrderNo:   fmt.Sprintf("ORD-2026-%04d", i),
			Status:    statuses[i%3],
			Amount:    float64(i) * 13.5,
			Cover:     fmt.Sprintf("https://picsum.photos/seed/%d/120/120", i),
			Remark:    fmt.Sprintf("第 %d 单：客户备注可能非常长，用来验证只读输入框的横向滚动展示效果，内容一直写下去看看会不会撑破表格布局。", i),
			Payload:   fmt.Sprintf(`{"source":"hg2","batch":%d,"tags":["tv","%d"]}`, i%5, i),
			CreatedAt: time.Now().AddDate(0, 0, -i),
			UpdatedAt: time.Now(),
		})
	}
	return rows
}

// stdLogger 把组件日志接到标准输出。
type stdLogger struct{}

func (stdLogger) Infof(format string, args ...any)  { log.Printf(format, args...) }
func (stdLogger) Errorf(format string, args ...any) { log.Printf(format, args...) }

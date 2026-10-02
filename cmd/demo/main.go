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
		OnAction: func(ev oao.ActionEvent) {
			// 宿主可以在这里记审计；组件自己什么都不落
			log.Printf("action %s/%s id=%s err=%v", ev.Table, ev.Action, ev.ID, ev.Err)
		},
		Tables: []oao.Table{
			{
				Key: "order", Label: "订单管理", Group: "业务",
				Source: src,
				Columns: []oao.Column{
					{Field: "id", Label: "ID", Kind: oao.KindNumber, Width: "70px", NoEdit: true},
					{Field: "order_no", Label: "订单号"},
					{Field: "status", Label: "状态", Kind: oao.KindNumber, Render: oao.RenderEnum,
						Enum: map[string]string{"1": "待审", "2": "通过", "3": "驳回"},
						Tone: map[string]string{"1": "warn", "2": "ok", "3": "err"}},
					{Field: "amount", Label: "金额", Kind: oao.KindNumber},
					{Field: "cover", Label: "封面", Render: oao.RenderImage, Size: 56},
					{Field: "remark", Label: "备注", Render: oao.RenderInput, MaxLen: 30},
					{Field: "payload", Label: "附加数据", Kind: oao.KindJSON},
					{Field: "created_at", Label: "创建时间", Kind: oao.KindTime, NoEdit: true},
					// 不显示，但会下发 —— 操作列用它做乐观锁比对
					{Field: "updated_at", Label: "更新时间", Kind: oao.KindTime, Hidden: true},
				},
				Filters: []oao.Filter{
					{Field: "order_no", Label: "订单号", Op: oao.OpLike},
					{Field: "status", Label: "状态", Kind: oao.KindNumber, Op: oao.OpIn,
						Options: map[string]string{"1": "待审", "2": "通过", "3": "驳回"}},
					{Field: "created_at", Label: "创建时间", Kind: oao.KindTime, Op: oao.OpBetween},
				},
				DefaultSort: "-id",
				PageSize:    20,
				Actions: []oao.Action{
					// 编辑：表单由列声明推导
					oao.EditAction(func(ctx context.Context, req oao.ActionRequest) error {
						return src.update(req.ID, req.Values)
					}),
					// 删除：二次确认
					oao.RemoveAction(func(ctx context.Context, req oao.ActionRequest) error {
						return src.remove(req.ID)
					}),
					// 自定义动作：指定表单字段
					{
						Key: "approve", Label: "审核通过", Tone: oao.ToneOK,
						Confirm: "确认通过该订单？",
						Handler: func(ctx context.Context, req oao.ActionRequest) error {
							// 乐观锁：updated_at 是隐藏列（不显示但会下发，操作时原样带回）。
							// 注意 Row 是**客户端回传**的，不能拿它当真相 —— 必须把版本条件
							// 写进更新语句本身。SQL 里就是：
							//   UPDATE orders SET status=2, updated_at=NOW()
							//   WHERE id=? AND updated_at=?  并检查 RowsAffected==1
							return src.approveIfUnchanged(req.ID, req.RowString("updated_at"))
						},
					},
					// 演示业务校验失败：金额为负时用 oao.Fail 指定状态码
					{
						Key: "reject", Label: "驳回", Tone: oao.ToneWarn,
						Form: []oao.Field{
							{Name: "reason", Label: "驳回原因", Widget: oao.WidgetTextarea, Required: true,
								Help: "必填，会记进备注"},
							{Name: "notify", Label: "通知客户", Kind: oao.KindBool},
						},
						Handler: func(ctx context.Context, req oao.ActionRequest) error {
							reason, _ := req.Values["reason"].(string)
							if strings.TrimSpace(reason) == "" {
								return oao.Fail(http.StatusBadRequest, "驳回原因不能为空")
							}
							return src.update(req.ID, map[string]any{"status": 3, "remark": reason})
						},
					},
				},
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
			// q.Get 拿到带算子的值，DateRange 直接给出半开区间，不用自己补一天
			from, end, ok := q.Get("created_at").DateRange()
			if !ok {
				continue
			}
			if r.CreatedAt.Before(from) || !r.CreatedAt.Before(end) {
				return false
			}
		}
	}
	return true
}

func sortRows(rows []Order, sortKey string) {
	parts := strings.Split(sortKey, ",")
	// 从优先级最低的键开始排：稳定排序保证后一轮不打乱前一轮的结果
	for i := len(parts) - 1; i >= 0; i-- {
		key := strings.TrimSpace(parts[i])
		if key == "" {
			continue
		}
		desc := strings.HasPrefix(key, "-")
		name := strings.TrimPrefix(key, "-")
		sort.SliceStable(rows, func(a, b int) bool {
			c := compareBy(rows[a], rows[b], name)
			if desc {
				return c > 0
			}
			return c < 0
		})
	}
}

// compareBy 按字段名比大小；演示用，真项目里这活交给数据库。
func compareBy(a, b Order, name string) int {
	switch name {
	case "order_no":
		return strings.Compare(a.OrderNo, b.OrderNo)
	case "status":
		return a.Status - b.Status
	case "amount":
		switch {
		case a.Amount < b.Amount:
			return -1
		case a.Amount > b.Amount:
			return 1
		}
		return 0
	case "created_at":
		switch {
		case a.CreatedAt.Before(b.CreatedAt):
			return -1
		case a.CreatedAt.After(b.CreatedAt):
			return 1
		}
		return 0
	default:
		return a.ID - b.ID
	}
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

// update 按字段名改一行（演示用，真项目里换成 UPDATE 语句）。
func (s *orderSource) update(id string, values map[string]any) error {
	n, err := strconv.Atoi(id)
	if err != nil {
		return oao.Fail(http.StatusBadRequest, "非法的主键：%s", id)
	}
	for i := range s.rows {
		if s.rows[i].ID != n {
			continue
		}
		for name, v := range values {
			switch name {
			case "remark":
				if str, ok := v.(string); ok {
					s.rows[i].Remark = str
				}
			case "status":
				switch x := v.(type) {
				case float64: // JSON 数字
					s.rows[i].Status = int(x)
				case int:
					s.rows[i].Status = x
				}
			case "amount":
				if f, ok := v.(float64); ok && f < 0 {
					return oao.Fail(http.StatusBadRequest, "金额不能为负")
				}
				if f, ok := v.(float64); ok {
					s.rows[i].Amount = f
				}
			case "order_no":
				if str, ok := v.(string); ok {
					s.rows[i].OrderNo = str
				}
			}
		}
		s.rows[i].UpdatedAt = time.Now()
		return nil
	}
	return oao.Fail(http.StatusNotFound, "订单 %s 不存在", id)
}

// approveIfUnchanged 带版本条件地通过订单：比对与写入在同一步完成，
// 避免"先查再写"之间的窗口（真项目里就是 UPDATE ... WHERE updated_at=? + RowsAffected）。
func (s *orderSource) approveIfUnchanged(id, was string) error {
	if was == "" {
		return oao.Fail(http.StatusBadRequest, "缺少 updated_at，无法做乐观锁")
	}
	n, err := strconv.Atoi(id)
	if err != nil {
		return oao.Fail(http.StatusBadRequest, "非法的主键：%s", id)
	}
	for i := range s.rows {
		if s.rows[i].ID != n {
			continue
		}
		if s.rows[i].UpdatedAt.Format(time.RFC3339Nano) != was {
			return oao.Fail(http.StatusConflict, "该行已被他人修改，请刷新后重试")
		}
		s.rows[i].Status = 2
		s.rows[i].UpdatedAt = time.Now()
		return nil
	}
	return oao.Fail(http.StatusNotFound, "订单 %s 不存在", id)
}

// remove 删一行。
func (s *orderSource) remove(id string) error {
	n, err := strconv.Atoi(id)
	if err != nil {
		return oao.Fail(http.StatusBadRequest, "非法的主键：%s", id)
	}
	for i := range s.rows {
		if s.rows[i].ID == n {
			s.rows = append(s.rows[:i], s.rows[i+1:]...)
			return nil
		}
	}
	return oao.Fail(http.StatusNotFound, "订单 %s 不存在", id)
}

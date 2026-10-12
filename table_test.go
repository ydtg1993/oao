package oao

import (
	"strings"
	"testing"
)

// defaultOp / defaultWidget 是筛选控件推断的兜底：声明得少一点也要给出合理控件。
func TestDefaultOpAndWidgetInference(t *testing.T) {
	if got := defaultOp(KindString); got != OpLike {
		t.Fatalf("字符串默认算子 = %s, want like", got)
	}
	if got := defaultOp(KindNumber); got != OpEq {
		t.Fatalf("非字符串默认算子 = %s, want eq", got)
	}

	cases := []struct {
		name    string
		op      Op
		kind    Kind
		options map[string]string
		want    Widget
	}{
		{"In 一律下拉", OpIn, KindString, nil, WidgetSelect},
		{"Between 一律日期区间", OpBetween, KindTime, nil, WidgetDateRange},
		{"有选项就给下拉", OpEq, KindString, map[string]string{"1": "待审"}, WidgetSelect},
		{"时间字段给日期控件", OpEq, KindTime, nil, WidgetDate},
		{"其余给文本框", OpEq, KindNumber, nil, WidgetInput},
	}
	for _, c := range cases {
		if got := defaultWidget(c.op, c.kind, c.options); got != c.want {
			t.Fatalf("%s: defaultWidget = %s, want %s", c.name, got, c.want)
		}
	}
}

// humanize 要跳过连续下划线切出来的空词 —— 空串上取 w[:1] 会 panic。
func TestHumanizeSkipsEmptyWords(t *testing.T) {
	cases := map[string]string{
		"created_at": "Created At",
		"id":         "Id",
		"a__b":       "A  B",
		"_x_":        " X ",
		"":           "",
	}
	for in, want := range cases {
		if got := humanize(in); got != want {
			t.Fatalf("humanize(%q) = %q, want %q", in, got, want)
		}
	}
}

// PageSize / PageSizes 越界要在注册时报错：服务端会把 size 夹到上限，
// 声明一个更大的值会让分页器算出的页数和实际取到的条数对不上。
func TestResolveRejectsPageSizeOutOfRange(t *testing.T) {
	src := &fakeSource{}
	col := []Column{{Field: "id"}}
	cases := []struct {
		name string
		tbl  Table
		want string // 报错要说清是哪个字段越界，宿主才知道改哪儿
	}{
		{"PageSize 超上限", Table{Key: "t", Source: src, Columns: col, PageSize: maxPageSize + 1}, "PageSize"},
		{"PageSizes 含 0", Table{Key: "t", Source: src, Columns: col, PageSizes: []int{0}}, "PageSizes"},
		{"PageSizes 含负数", Table{Key: "t", Source: src, Columns: col, PageSizes: []int{-5}}, "PageSizes"},
		{"PageSizes 超上限", Table{Key: "t", Source: src, Columns: col, PageSizes: []int{20, maxPageSize + 1}}, "PageSizes"},
	}
	for _, c := range cases {
		_, err := New(Config{Tables: []Table{c.tbl}})
		if err == nil {
			t.Fatalf("%s：应当报错", c.name)
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s：报错没点名 %q：%v", c.name, c.want, err)
		}
	}

	// 边界值本身合法
	if _, err := New(Config{Tables: []Table{{Key: "t", Source: src, Columns: col,
		PageSize: maxPageSize, PageSizes: []int{1, maxPageSize}}}}); err != nil {
		t.Fatalf("边界值不该被拒：%v", err)
	}
}

// 筛选控件的推断要真的经 resolve() 下发到元数据里（前端就是照它渲染工具栏的）。
func TestResolveInfersFilterWidgets(t *testing.T) {
	_, o := newTestServer(t, Table{
		Key: "t", Source: &fakeSource{}, Columns: []Column{{Field: "id"}},
		Filters: []Filter{
			{Field: "created_at", Op: OpBetween, Kind: KindTime},
			{Field: "status", Op: OpEq, Options: map[string]string{"1": "待审"}},
			{Field: "day", Op: OpEq, Kind: KindTime},
		},
	})
	info, _ := o.Table("t")
	want := []Widget{WidgetDateRange, WidgetSelect, WidgetDate}
	for i, w := range want {
		if got := info.Filters[i].Widget; got != w {
			t.Fatalf("filters[%d] widget = %s, want %s", i, got, w)
		}
	}
}

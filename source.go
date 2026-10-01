package oao

import (
	"context"
	"strings"
)

// Query 组件把 HTTP 参数解析成的规范查询条件，交给业务 Source。
//
// 组件不解释 Filter 的语义，只做归一化：In 用 "a,b,c"，Between 用 "a..b"。
// 具体怎么落到 SQL / 接口 / 内存过滤，由 Source 自己决定。
type Query struct {
	Page   int               // 页码，1 起
	Size   int               // 每页条数
	Search string            // 全局搜索关键词
	Sort   string            // 排序：单字段 "col" / "-col"，多字段逗号分隔 "-status,id"（按先后定优先级）
	Filter map[string]string // 列名 -> 原始值（In: "a,b,c"；Between: "a..b"）

	// filterSpecs / sortable 是这张表声明的规则，用来把参数解码、并挡住没声明的字段。
	// 用 Filters() / Get() / SortFields() 取，别直接读。
	filterSpecs map[string]FilterSpec
	sortable    map[string]bool
}

// SortField 一个排序键。
type SortField struct {
	Field string
	Desc  bool
}

// SortFields 解析排序参数，逐个校验是不是声明过的可排序列，未声明的丢掉。
// 返回顺序即优先级顺序。没配排序时返回空切片（由业务决定默认顺序）。
//
//	for _, s := range q.SortFields() {
//	    dir := "ASC"; if s.Desc { dir = "DESC" }
//	    db = db.Order(s.Field + " " + dir)
//	}
func (q Query) SortFields() []SortField {
	out := make([]SortField, 0, 2)
	for _, part := range strings.Split(q.Sort, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		desc := strings.HasPrefix(part, "-")
		name := strings.TrimPrefix(part, "-")
		if name == "" || !q.sortable[name] {
			continue
		}
		out = append(out, SortField{Field: name, Desc: desc})
	}
	return out
}

// Source 数据来源，由业务层实现 —— 组件不碰数据层。
//
// rows 的 key 用列声明的 Field 名即可；组件只按列声明取用，多出来的键会被忽略。
// total 是满足条件的总条数（不是本页条数），用于分页器。
//
// 用 GORM 实现的话大致是：
//
//	func (s *orderSource) List(ctx context.Context, q oao.Query) ([]map[string]any, int64, error) {
//	    db := s.db.Model(&models.Order{})
//	    for name, val := range q.Filter { /* 按 q 里声明的算子拼条件 */ }
//	    var total int64
//	    db.Count(&total)
//	    var rows []map[string]any
//	    err := db.Offset((q.Page-1)*q.Size).Limit(q.Size).Find(&rows).Error
//	    return rows, total, err
//	}
type Source interface {
	List(ctx context.Context, q Query) (rows []map[string]any, total int64, err error)
}

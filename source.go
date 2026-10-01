package oao

import "context"

// Query 组件把 HTTP 参数解析成的规范查询条件，交给业务 Source。
//
// 组件不解释 Filter 的语义，只做归一化：In 用 "a,b,c"，Between 用 "a..b"。
// 具体怎么落到 SQL / 接口 / 内存过滤，由 Source 自己决定。
type Query struct {
	Page   int               // 页码，1 起
	Size   int               // 每页条数
	Search string            // 全局搜索关键词
	Sort   string            // "col" 升序 / "-col" 降序
	Filter map[string]string // 列名 -> 值
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

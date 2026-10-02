# oao

一个**表格组件**：把业务给的数据，按声明渲染成后台的表格页。

**它只做声明 + 透传，不碰数据层**——不发 SQL、不认识你的模型、不懂业务语义。
数据由业务实现 `Source` 提供，前端发来的操作由组件转发给业务的 `Handler`。

- **零外部依赖**（纯标准库），只吃宿主提供的 CSS 设计 token
- 前端可脱离任何框架单独跑：`go run ./cmd/demo`

```bash
go get github.com/ydtg1993/oao
```

---

## 快速开始

```go
o, err := oao.New(oao.Config{
    Tables: []oao.Table{
        {
            Key: "order", Label: "订单管理", Group: "业务",
            Source: myOrderSource,              // 业务实现，必填

            Columns: []oao.Column{
                {Field: "id", Kind: oao.KindNumber, Width: "70px", NoEdit: true},
                {Field: "order_no", Label: "订单号"},
                {Field: "status", Kind: oao.KindNumber, Render: oao.RenderEnum,
                 Enum: map[string]string{"1": "待审", "2": "通过"},
                 Tone: map[string]string{"1": "warn", "2": "ok"}},
            },
            DefaultSort: "-id",
        },
    },
})
if err != nil { log.Fatal(err) }

o.Mount(mux)   // 路由：GET /api/oao/tables、GET /api/oao/{table}、POST /api/oao/{table}/action/{key}
```

前端加载 `oao.js` / `oao.css`，然后：

```js
Oao.init({ base: '/api/oao' });
Oao.render(document.getElementById('app'), 'order');   // 只画表格
// 或者
Oao.mount(document.getElementById('app'), { ... });     // 连外壳一起搭，见「布局」
```

跑起来看效果：

```bash
go run ./cmd/demo      # http://localhost:8090
```

---

## 核心概念

| | 谁写 | 职责 |
| --- | --- | --- |
| `Table` / `Column` / `Filter` / `Action` | 业务 | **声明**显示什么、怎么显示 |
| `Source` | 业务 | **取数**：怎么过滤、怎么排序、查库还是调接口 |
| `ActionHandler` | 业务 | **响应操作**：改哪个库、做什么校验 |
| 组件 | — | 把声明变成页面、把请求规范化后转发、把结果映射成响应 |

组件与业务之间只有两个契约：**`Query`（进）** 和 **`ActionRequest`（进）**。

### 组件的职责边界

**它是展示层组件，不是数据层，也不是业务层。** 哪些事不要指望它：

| 组件负责 | 组件不管（由宿主自己决定） |
| --- | --- |
| 把声明渲染成页面与操作列 | 鉴权与凭据：只提供 `Auth` / `headers` / `onUnauthorized` 三个挂钩，认不认、怎么认由宿主定 |
| 把 HTTP 参数规范化成 `Query` | 审计：只回调 `OnAction`；记不记、记到哪由宿主定（组件不落任何存储） |
| 未声明的列 / 筛选 / 动作一律挡掉 | 数据的正确性与一致性：取数、写数、事务都在宿主的数据层 |
| 弹窗、校验、Toast、刷新等前端交互 | **并发与幂等**：同一操作被触发多次（双击、两人同时点、重试）时的去重，必须由宿主在自己的数据层做——组件不保证任何时序 |
| 把业务错误按状态码回给前端 | 业务语义与状态维护：什么状态允许哪个动作、记录怎么流转，全由宿主定义 |

最后两条尤其要说清楚：`ActionRequest.Row` 是**客户端回传的、不可信的**展示快照，组件只负责原样带过来。
要防重复与并发覆盖，宿主必须把前置条件写进**自己的写语句**里并检查影响行数，做法见下面的
「在 Handler 里取值」。

### Source

```go
type Source interface {
    List(ctx context.Context, q oao.Query) (rows []map[string]any, total int64, err error)
}
```

- `rows` 的 key 用列声明的 `Field`（多余的键会被忽略）
- `total` 是**满足条件的总条数**，不是本页条数

---

## 列怎么显示

```go
Columns: []oao.Column{
    {Field: "order_no", Label: "订单号"},                            // 全默认
    {Field: "status", Render: oao.RenderEnum,
     Enum: map[string]string{"1": "待审"}, Tone: map[string]string{"1": "warn"}},
    {Field: "cover", Render: oao.RenderImage, Size: 56},
    {Field: "remark", Render: oao.RenderInput, MaxLen: 30},
    {Field: "created_at", Kind: oao.KindTime},
}
```

| `Render` | 效果 | 参数 |
| --- | --- | --- |
| `RenderAuto`（默认） | 按 `Kind` 推断 | — |
| `RenderText` | 纯文本，过长省略号 + 悬停看全文 | — |
| `RenderInput` | **只读**输入框：长度可控、横向滚动逐字看完（**不是编辑**） | `MaxLen` |
| `RenderLink` | 可点击跳转 | `Href`（支持 `{字段名}` 占位）/ `NewTab`（新标签页打开） |
| `RenderImage` | 缩略图 | `Size`（默认 64） |
| `RenderEnum` | 取值映射成彩色标签 | `Enum` / `Tone` |
| `RenderTime` | 时间格式化 | `Format: "date"` 只显示日期 |
| `RenderJSON` | 折叠查看 | — |
| `RenderCustom` | 逃生舱：HTML 片段（受信任内容，组件不转义） | `HTML` |

其它字段：`Kind`（`string`/`number`/`bool`/`time`/`json`，决定默认渲染与取值方式）、
`Width`、`NoSort`（该列不可排序）、`NoEdit`（不进自动生成的编辑表单——主键、创建时间这类）、
`Hidden`（**声明但不显示**：数据仍会下发，供操作列的乐观锁比对等用，只是不渲染这一列）。

**留空即推断**：`Label` 由 `Field` 生成（`order_no` → `Order No`），`Kind` 默认字符串，`Render` 按 `Kind` 推。

---

## 怎么筛

```go
Filters: []oao.Filter{
    {Field: "order_no",   Op: oao.OpLike},                        // 模糊   → 输入框
    {Field: "stage",      Op: oao.OpEq},                          // 等于   → 输入框
    {Field: "status", Kind: oao.KindNumber, Op: oao.OpIn,
     Options: map[string]string{"1": "待审", "2": "通过"}},         // 多选   → Checkbox 组
    {Field: "created_at", Kind: oao.KindTime, Op: oao.OpBetween},  // 时间段 → 日期区间
    {Field: "amount",     Kind: oao.KindNumber, Op: oao.OpGt},     // 大于   → 数字输入
}
```

| `Op` | 语义 | 默认控件 |
| --- | --- | --- |
| `OpEq` | 等于 | 输入框 / 下拉 |
| `OpLike` | 模糊 | 输入框 |
| `OpIn` | 多选 | 多选 Checkbox |
| `OpBetween` | 区间 | 日期区间 |
| `OpPrefix` | 前缀匹配（只有后通配，能走索引） | 输入框 |
| `OpGt` / `OpLt` | 大于 / 小于 | 输入框 |

`Widget` 可显式指定：`input` / `number` / `textarea` / `select` / `switch` / `date` / `daterange`；留空按 `Op` + `Kind` 推。

**未声明的字段不可筛**——筛选白名单在组件这一层就把住了（未声明的 `filter[...]` 根本不会进 `Query.Filter`），业务不用自己防注入。
**不声明 `Filters` 就不显示筛选栏**（全局搜索与排序仍在）。
**多个筛选条件可以同时生效**，前端把所有筛选控件的值一起发过来。

### 在 Source 里取值

组件把筛选值规范成字符串传来，并把**每个字段的算子与类型**一并给你，不用自己猜：

```go
func (s *Source) List(ctx context.Context, q oao.Query) ([]map[string]any, int64, error) {
    db := s.db.WithContext(ctx).Model(&models.Order{})

    for _, f := range q.Filters() {       // 只有"声明过且填了值"的字段
        switch f.Op() {
        case oao.OpLike:
            db = db.Where(f.Field()+" LIKE ?", "%"+f.Raw()+"%")
        case oao.OpIn:
            db = db.Where(f.Field()+" IN ?", f.IntList())     // 数字字段；字符串用 f.List()
        case oao.OpBetween:
            if f.Kind() == oao.KindTime {
                // 日期控件：用半开区间，否则会漏掉结束日当天
                from, end, _ := f.DateRange()
                db = db.Where(f.Field()+" >= ? AND "+f.Field()+" < ?", from, end)
            } else {
                lo, hi, _ := f.Range()                        // 数字等：闭区间
                db = db.Where(f.Field()+" BETWEEN ? AND ?", lo, hi)
            }
        case oao.OpEq:
            db = db.Where(f.Field()+" = ?", f.Raw())
        }
    }
    // ... Count / Order / Offset / Limit
}
```

也可以按字段名单独取：

```go
if v := q.Get("created_at"); !v.Empty() {
    from, to, ok := v.TimeRange()
    ...
}
```

`FilterValue` 的取值助手：

| 方法 | 用途 |
| --- | --- |
| `Op()` / `Kind()` / `Field()` / `Options()` | 声明里的元数据 |
| `Raw()` | 原始字符串（In: `"1,2,3"`；Between: `"a..b"`） |
| `Empty()` | 调用方没填 |
| `String()` | 字符串值 |
| `Int()` / `Float()` / `Bool()` | 转对应类型，第二个返回值表示成功与否 |
| `List()` / `IntList()` | 多选值（In 用） |
| `Range()` | 区间两端字符串（Between 用），不完整时 `ok=false` |
| `Time()` | 单个时间值 |
| `DateRange()` | **按天筛选用这个**：半开区间 `[from, end)`，`end` 是结束日的次日零点 |
| `TimeRange()` | 时间区间，两端**按输入原样解析**（见下） |

> 半截区间（只填了一头）在前端就不会发过来，`Filters()` 也会跳过——业务拿到的永远是完整条件。

**`DateRange()` 与 `TimeRange()` 的区别**（这条容易踩）：

选 `2026-09-01 ~ 2026-09-10` 时，日期控件给的是两个 `2006-01-02`。

| | `from` | 结束端 | 直接 `BETWEEN` 的后果 |
| --- | --- | --- | --- |
| `TimeRange()` | 9/1 00:00 | **9/10 00:00** | **9/10 当天全被漏掉** |
| `DateRange()` | 9/1 00:00 | 9/11 00:00（次日） | 配合 `>= AND <` 正好圈住两天 |

所以按天筛选一律用 `DateRange()` + `>= from AND < end`；输入里带了时刻时它按时刻处理，不补天。

---

## 排序

点表头排序，**Shift + 点击**追加第二个排序键（表头会标上优先级序号 `▲1` `▼2`）。

```go
// 在 Source 里取：
for _, s := range q.SortFields() {        // 已校验是声明过的可排序列，顺序即优先级
    dir := "ASC"
    if s.Desc {
        dir = "DESC"
    }
    db = db.Order(s.Field + " " + dir)
}
```

| | |
| --- | --- |
| `Query.Sort` | 原始参数：`"col"` 升序、`"-col"` 降序、多字段逗号分隔 `"-status,amount"` |
| `Query.SortFields()` | **推荐入口**：解析成 `[]SortField{{Field, Desc}}`，未声明/不可排序列自动丢掉 |
| `Table.DefaultSort` | 默认排序，同样支持逗号分隔的多字段 |

列的 `NoSort: true` 表示不参与排序（表头也不可点）。

---

## 操作列

```go
Actions: []oao.Action{
    // 表单字段由列声明推导（跳过图片/JSON/链接，以及标了 NoEdit 的列）
    oao.EditAction(func(ctx context.Context, req oao.ActionRequest) error {
        return db.Model(&models.Order{}).Where("id = ?", req.ID).
            Updates(req.Values).Error
    }),

    // 先弹二次确认
    oao.RemoveAction(func(ctx context.Context, req oao.ActionRequest) error {
        return db.Delete(&models.Order{}, req.ID).Error
    }),

    // 自定义动作
    {Key: "approve", Label: "审核通过", Tone: oao.ToneOK,
     Confirm: "确认通过该订单？",
     Handler: func(ctx context.Context, req oao.ActionRequest) error {
         return db.Model(&models.Order{}).Where("id = ?", req.ID).
             Update("status", 2).Error
     }},

    // 带表单的自定义动作
    {Key: "reject", Label: "驳回", Tone: oao.ToneWarn,
     Form: []oao.Field{
         {Name: "reason", Label: "驳回原因", Widget: oao.WidgetTextarea, Required: true},
         {Name: "notify", Label: "通知客户", Kind: oao.KindBool},
     },
     Handler: rejectOrder},
}
```

| `Action` 字段 | 说明 |
| --- | --- |
| `Key` / `Label` / `Tone` | 标识、按钮文案、语义色（`ok`/`warn`/`err`/`info`） |
| `Confirm` | 非空：点完先弹确认框，内容即文案 |
| `Form` | 非空：点完先弹表单 |
| `DeriveForm` | `true` 时忽略 `Form`，由列声明推导（`EditAction` 用的就是它） |
| `Handler` | 必填，业务处理逻辑 |

**表不声明 `Actions` 就是只读的**——不注册任何写路由，未声明的动作一律 404。

**操作靠什么定位到那一行**：前端取行里由 `Table.IDField` 指定的字段（默认 `id`）作为主键回传，
所以它**必须是 `Columns` 里声明过的列**——列表下发时只保留声明过的列，没声明的话前端根本拿不到这个值
（点按钮只会弹「这一行没有 id 字段」）。不想显示这一列就用 `Hidden: true`，它仍会下发。
`oao.New` 会在注册时校验这件事，声明不一致直接报错，不用等运维点按钮才发现。

`oao.Field` 的字段：

| 字段 | 说明 |
| --- | --- |
| `Name` | 字段名，也是 `Values` 里的 key（限字母数字下划线连字符） |
| `Label` | 展示名，留空按 `Name` 生成 |
| `Kind` | `string` / `number` / `bool` / `time` / `json`，决定默认控件 |
| `Widget` | `input` / `number` / `textarea` / `select` / `switch` / `date`，留空按 `Kind` 推 |
| `Options` | 下拉的选项：值 → 文案 |
| `Required` | 必填，空值会被前端拦下、弹窗不关 |
| `Help` | 字段下方的说明 |
| `Rows` | 多行文本框行数，默认 3 |
| `Placeholder` | 下拉未选择时触发器上的提示，默认「请选择」 |

> 提交上来的 `Values` **只包含这里声明过的字段**（无论客户端多塞了什么）。

### 在 Handler 里取值

前端提交的是 JSON，**数字一律是 `float64`**，用助手取更省事：

```go
func approve(ctx context.Context, req oao.ActionRequest) error {
    reason := req.String("reason")
    if reason == "" {
        return oao.Fail(http.StatusBadRequest, "驳回原因不能为空")
    }
    if req.Bool("notify") { ... }
    if n, ok := req.Int("amount"); ok { ... }

    // 乐观锁：Row 是客户端展示时那一行的原始数据
    was := req.RowString("updated_at")
    ...
}
```

> **`Row` 是客户端回传的，不能当真相。** 它只是"用户看到的那一行的快照"，
> 客户端可以伪造，中间也隔着一段网络时间。真要防并发覆盖，必须把版本条件写进**更新语句本身**
> 并检查影响行数：
>
> ```sql
> UPDATE orders SET status=2, updated_at=NOW()
>  WHERE id=? AND updated_at=?     -- 影响行数为 0 就是别人改过了
> ```
>
> 只做"先查再写"（TOCTOU）等于没有锁。参考实现见 `cmd/demo` 的 `approveIfUnchanged`。

| `ActionRequest` 字段 | 说明 |
| --- | --- |
| `Table` / `Action` | 表 key / 动作 key |
| `ID` | 目标行主键（字符串；取 `Table.IDField` 指定的字段，默认 `id`） |
| `Values` | 表单提交的字段值 |
| `Row` | 客户端展示时那一行的原始数据（**乐观锁比对用，见下**） |
| `Req` | 逃生舱：要读请求头/鉴权信息时用 |

助手：`String(name)` / `Int(name) (int,bool)` / `Float(name) (float64,bool)` / `Bool(name)` / `RowString(name)`。

### 错误怎么返回给前端

```go
return oao.Fail(http.StatusConflict, "该行已被他人修改")   // 前端 Toast 显示这句话
return errors.New("boom")                                  // 统一 500，前端显示 "HTTP 500"
```

`Fail` 的状态码会原样返回给前端，消息即提示语。
传 2xx 或越界值会被兜成 500 —— 否则前端 `resp.ok` 会把失败判成成功。

### 审计钩子

```go
oao.New(oao.Config{
    OnAction: func(ev oao.ActionEvent) {
        // 每次转发结束都会调，成功与失败都调
        log.Printf("%s/%s id=%s err=%v from=%s", ev.Table, ev.Action, ev.ID, ev.Err, ev.IP)
    },
})
```

**组件自己不落任何存储**——要不要记审计、记到哪，由宿主决定。

---

## 布局（可选）

自己已有页面框架的宿主，只用 `Oao.render(container, key)` 就够了。
想要"一行起一个完整后台页"的，用 `Oao.mount`：

```js
Oao.init({ base: '/api/oao' });

Oao.mount(document.getElementById('app'), {
    title: 'PAPA MONITOR',

    // 右上角插槽：HTML 字符串，或 (el, api) => void 自己挂事件
    headerRight: '<span class="badge info">demo</span><span class="avatar">Y</span>',

    // 侧边栏底部插槽（主题切换、状态点之类）
    sidebarFooter: '<button id="theme">☾ 深色</button>',

    // 宿主自己的页面，跟 oao 表格一起进菜单
    pages: [
        { key: 'dashboard', label: 'Dashboard', group: '概览',
          render: function (el, api) {
              el.innerHTML = '...';
              api.setTitle('Dashboard');
          } },
    ],

    onReady: function (api) { /* api.open('order') / api.reload() */ },
});
```

**菜单怎么来**：`pages[].group` 与表格的 `Table.Group` 合并，按**首次出现的顺序**分组。

**布局**：外壳按视口高度撑满（`var(--oao-shell-height, 100dvh)`），**整页不滚动**。
滚动条默认透明，鼠标移到容器上才显形（能拖，但不占视觉）。

**表格区域自己滚**：表格**超长纵向滚、超宽横向滚**，都不会把内容区撑长 ——
筛选栏和分页器始终留在视野里，**表头吸顶**（`position: sticky`），滚多少行都看得见列名。

| token | 说明 |
| --- | --- |
| `--oao-shell-height` | 外壳高度，默认 `100dvh`。嵌进已有页面的子区域时改它 |
| `--oao-table-max-height` | 表格滚动区的硬上限（默认 `none`）。**只 render 不进 mount** 时，宿主容器没有确定高度，用它兜底 |

宿主自己的页面（`pages[].render`）会被包在 `.oao-page` 里，自己滚，不挤占表格页的布局。

**插槽**：`headerRight` / `sidebarFooter` 收 HTML 字符串或 `(el, api) => void`。
宿主自己的样式（头像、徽章之类）由宿主补——组件只负责把它放进正确的位置。

**api**：`open(key)` 切页、`reload()` 重载当前页、`setTitle(t)` 改标题、`current()` 当前 key、`content()` 内容容器。

> `mount` 会给容器加上 `oao-host` 类接管布局（撑满父级且允许被压窄）。
> 不想要就用 `render`，自己搭壳。

---

## 挂载与鉴权

```go
o, _ := oao.New(oao.Config{
    Tables: tables,
    Prefix: "/api/oao",                    // 默认值
    Auth:   mon.Auth,                      // func(http.Handler) http.Handler
    Logger: logger,                        // 可选：Infof / Errorf
})
o.Mount(mux)

static, _ := o.StaticFS()                  // 静态资源交给宿主挂（方法，不是包级函数）
mux.Handle("/static/oao/", http.StripPrefix("/static/oao/", http.FileServer(http.FS(static))))
```

### 前端鉴权入口

组件自己不认 token，只提供两个回调，业务把凭据塞进去：

```js
Oao.init({
    base: '/api/oao',

    // 每次请求都会回调一次 —— token 轮换也能跟上
    headers: function () {
        return { 'Authorization': 'Bearer ' + myToken() };
    },

    // 收到 401 时问一次；返回 true 表示已换好凭据，组件带新 header 重试一次
    onUnauthorized: async function () {
        var t = await askUserForToken();
        if (!t) return false;
        saveToken(t);
        return true;
    },
});
```

**所有请求（列表、表格清单、操作提交）都走同一个出口**，不会有哪条路径漏掉鉴权头。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `{prefix}/tables` | 表格清单与元数据（列 / 筛选 / 操作），菜单用 |
| GET | `{prefix}/{table}` | 分页数据 |
| POST | `{prefix}/{table}/action/{key}` | 转发操作给业务 Handler |

查询参数：`page`、`size`（默认取表声明，上限 200）、`search`、`sort`（`col` / `-col`，多字段逗号分隔）、`filter[列名]=值`（可多个同时生效）。

---

## 透传契约速查

### 组件 → 业务（`Query`）

| 字段 | 说明 |
| --- | --- |
| `Page` / `Size` | 页码（1 起）/ 每页条数，已做默认值与上限校正 |
| `Search` | 全局搜索关键词（**搜哪些字段由业务决定**，组件不知道） |
| `Sort` | 原始排序参数：`"col"` / `"-col"`，多字段逗号分隔 |
| `SortFields()` | **推荐入口**：`[]SortField{Field, Desc}`，已校验且去掉未声明的列 |
| `Filter` | 列名 → 原始值。`In` 用 `"a,b,c"`，`Between` 用 `"a..b"`；**只含声明过的字段** |
| `Filters()` | **推荐入口**：只返回"声明过且填了值"的条件，带算子与类型，顺序固定 |
| `Get(field)` | 按字段取单个条件（未声明字段取不到） |

### 业务 → 组件（返回）

| | 说明 |
| --- | --- |
| `rows []map[string]any` | key 用列声明的 `Field`；值按 `Kind` 给（时间给 `time.Time` 或 RFC3339 字符串都行） |
| `total int64` | 满足条件的总条数 |
| `error` | 返回给前端 500；建议包一层带上上下文 |

### 前端 → 组件（操作请求体）

```json
{
  "id": "42",
  "values": { "reason": "内容违规", "notify": true },
  "row": { "id": 42, "status": 1, "updated_at": "2026-09-01T10:00:00Z" }
}
```

### 组件 → 前端（`/tables`）

`TableInfo` 含 `key` / `label` / `group` / `columns[]` / `filters[]` / `actions[]` / `id_field` / `default_sort` / `page_size` / `page_sizes`，
所有留空项在注册时已补成具体值——前端拿到的永远是可直接用的形态。

---

## 设计约定

- **样式**：`oao.css` **自带表格基础样式**（边框、斑马纹、徽章、横向滚动容器等），
  全部作用域收在 `.oao-view` 下，宿主什么都不补也能看。它只向宿主索取一组设计 token：

  ```
  --background --foreground --card --muted-fill --muted-foreground
  --border-color --shadow-color --zebra --destructive
  --primary --secondary --secondary-fg
  --green --orange --blue --purple
  --font-display --font-body --font-mono
  ```

  宿主可以覆盖 `.oao-view` 下的任何规则来贴合自己的视觉；不想覆盖就自己声明这套 token
  （最小示例见 `cmd/demo/web/preview.css`）。
  另外组件会用 `data-tip` 属性做"悬停看全文"，样式由宿主提供 —— 忘了补也不影响功能。
- **嵌入已有页面**：`mount` 默认占满视口。要嵌进页面的某个子区域，用 `--oao-shell-height`
  覆盖高度（比如 `--oao-shell-height: 600px` 或 `100%`），并保证该容器自己有确定高度。
- **圆角**：默认 0（直角）。想跟 neobrutalism 组件库一样带轻微圆角，声明 `--oao-radius: 4px` 即可。
- **表单控件**：输入框 / 下拉都按组件库的 `Field` 规格（label 在上、控件在下），
  下拉是自带的下拉面板（不是原生 `<select>`）：单选点一下就选、**多选带 checkbox 且面板不关**，
  支持键盘上下移动、Enter 选中、Esc 关闭、点外部关闭。
- **依赖**：`go.mod` 无外部依赖。
- **安全**：列名、筛选字段、排序字段全部走声明白名单，HTTP 参数无法注入；未声明的动作返回 404。
  表 key / 列 Field / 筛选 Field / 动作 key / 表单项 Name 都限制为字母数字下划线连字符 ——
  它们会进 URL 路由和 `data-*` 属性。操作请求体上限 1 MiB。
- **无障碍**：表头带 `aria-sort`，横向滚动容器带 `role="region"` / `tabindex="0"` / `aria-label`
  （溢出时键盘也能滚），下拉触发器带 `aria-haspopup="listbox"` 与 `aria-expanded`。
  另外三处**字段级白名单**也由组件把住，业务不用自己防：
  1. **列表下发**：`rows` 只保留列声明过的字段。Source 里的 `SELECT *` 不会把未声明的列（密码哈希、
     大 JSON）带到浏览器。想下发但不显示，声明成 `Hidden`。
  2. **表单提交**：`ActionRequest.Values` 只保留该动作 `Form` 里声明过的字段。
     客户端多塞的字段进不到 `Updates(req.Values)`。
  3. **筛选参数**：未声明的 `filter[...]` 不会进 `Query.Filter`。

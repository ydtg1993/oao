# oao

一组**后台展示组件**：把宿主提供的声明和数据渲染成表格、SVG 图表，以及可选的页面外壳与动效。

**不碰数据层**：不发 SQL、不认识业务模型、不推断指标口径。
表格数据由业务实现 `Source` 提供，前端操作转发给业务的 `Handler`；图表只消费宿主传入的数据，不请求接口、不存储历史。

- **零外部运行依赖**：Go 使用标准库，浏览器组件使用原生 JS/CSS/SVG
- 延续宿主 CSS 设计 token；图表也提供独立使用时的默认颜色与字体
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
// 也可以带着**预置筛选**打开（第三个参数，见「怎么筛」）：
// Oao.render(document.getElementById('app'), 'order', { filter: { status: '2' } });
// 或者
Oao.mount(document.getElementById('app'), { ... });     // 连外壳一起搭，见「布局」
```

跑起来看效果：

```bash
go run ./cmd/demo                  # http://127.0.0.1:8090
go run ./cmd/demo -port 18094      # 可选回环端口，避免占用其它本地服务
```

demo 的“图表与动效”页包含四类图表、更新样本、主题切换与减弱动效。数据为本地合成样本。

## 前端模块与生命周期

表格与外壳仍只需 `oao.js` / `oao.css`。需要图表或统一动效时，再加载相应独立模块；使用完整组件时按以下顺序加载：

```html
<link rel="stylesheet" href="/static/oao/oao.css">
<link rel="stylesheet" href="/static/oao/oao-charts.css">
<link rel="stylesheet" href="/static/oao/oao-motion.css">
<script src="/static/oao/oao.js"></script>
<script src="/static/oao/oao-motion.js"></script>
<script src="/static/oao/oao-charts.js"></script>
```

路径取决于宿主挂载的 `StaticFS()`。图表可单独加载 `oao-charts.js/css`；如果同时使用 `oao.js`，须先加载它，避免重新初始化 `Oao` 覆盖扩展。

### 表格实例

```js
await Oao.render(left, 'order', { filter: { status: '1' } });
await Oao.render(right, 'order', { filter: { status: '2' } });
await Oao.refreshInstance(left);        // 只刷新这个容器的当前表格
const results = await Oao.refresh('order'); // 刷新该 key 的所有活跃视图
Oao.destroy(left);                     // 中止 GET、关闭所属弹层、清理状态和 DOM
```

| API | 返回与语义 |
| --- | --- |
| `Oao.render(container, key, opts?)` | `Promise<void>`；每次进入第一页，保留本容器该表已有的其它查询条件；传入 `opts.filter` 时整体替换筛选 |
| `Oao.refresh(key)` | 返回 `Promise.allSettled` 结果数组；每个活跃同 key 视图独立刷新，某个失败不阻止其它视图 |
| `Oao.refreshInstance(container)` | `Promise<void>`；保留当前查询条件；无活跃表时直接完成，加载失败时拒绝并在视图显示错误 |
| `Oao.destroy(container)` | 销毁该容器内的表格或由 `mount` 创建的外壳；重复调用安全 |

查询状态按“容器 + 表 key”保存，同表多容器互不覆盖。同容器重复 `render`、切表或销毁会使前一次表格生命周期失效，并中止前一 GET；响应还会经过实例/序号检查。即使后来回到同一 key，旧响应也不能重新挂载或刷新新页面。`refresh` / `refreshInstance` 保留当前生命周期。刷新会尝试恢复已有筛选、分页、排序及行操作控件的焦点，行操作按主键匹配；焦点已转到另一个视图或弹窗时不抢回。

行操作 POST 绑定发起它的表格生命周期。生命周期失效后，迟到成功或失败不会显示 Toast、触发列表刷新，也不会在异步换凭据完成后重试旧 POST。**这不等于撤销已经发送的服务端写入**；请求可能已在服务端成功，业务幂等、状态查询和必要的补偿由宿主负责。

`Oao.render` 的加载错误会显示在表格内；需要从调用端检查刷新结果时，使用 `refreshInstance` 的拒绝或 `refresh` 的 settled 结果。它们不是业务写入的幂等或一致性保证。

### SVG 图表

```js
const target = document.getElementById('trend');
const options = {
    type: 'line', title: '本次页面观测', unit: '项', xType: 'time',
    description: '空点表示未取得观测值。',
    series: [{
        key: 'queue', label: '排队',
        points: [{ x: 1760000000000, y: 3 },
                 { x: 1760000005000, y: null },
                 { x: 1760000015000, y: 0 }]
    }]
};
const chart = Oao.charts.create(target, options);
chart.update({ ...options, series: nextSeries }); // 完整替换 options，不做增量合并
chart.resize();                                 // 隐藏容器重新显示时也可主动调用
chart.destroy();                                // 离页时释放观察器、监听器和动画
```

`create(container, options)` 同步返回 `{ update(options), resize(), destroy() }`。同一容器再次 `create` 会先销毁旧图表；每个实例独立。销毁后的 `update` / `resize` 不起作用。容器必须是 DOM 元素，否则抛出 `TypeError`；数据不合法时显示明确错误态。用 `chart.destroy()` 清理图表，不能只清空宿主 DOM，也不能用表格的 `Oao.destroy()` 代替。

| option | 说明 |
| --- | --- |
| `type` | 必填：`line`、`bar`、`donut`、`sparkline` |
| `title` / `unit` / `description` | 标题、显示单位与口径说明；组件不换算单位，所有文本均按纯文本渲染 |
| `series` | 折线/迷你图：`[{ key, label, color?, points: [{ x, y }] }]` |
| `data` | 柱形/环形：`[{ key, label, value }]` |
| `horizontal` | 柱形图为 `true` 时横向排列；默认纵向 |
| `xType` | `number`（默认）或 `time`；时间 x 为有效的毫秒时间戳，标签使用浏览器本地时间 |
| `emptyText` | 空态文案，默认“暂无可用数据” |
| `error` | 非空错误文本；直接显示错误态，下一次完整 update 可恢复正常数据 |

```js
const categories = [
    { key: 'done', label: '完成', value: 18 },
    { key: 'failed', label: '失败', value: 2 }
];
Oao.charts.create(barTarget, { type: 'bar', horizontal: true, data: categories });
Oao.charts.create(donutTarget, { type: 'donut', unit: '项', data: categories });
Oao.charts.create(sparkTarget, { ...options, type: 'sparkline' });
```

数据规则：

- 每个系列和每个分类须提供稳定、非空字符串 `key`，同一列表内不能重复；`label` 留空时使用 key。
- 每图最多 8 系列、每系列最多 300 点；柱形最多 50 分类，环形最多 12 分类。无效项、稀疏数组与超限会显示错误，不截断数据。
- x、y、value 必须是有限的 JS 数字，只有 y 允许 `null`。每个系列内 x 必须严格递增，重复或乱序会报错，组件不自动排序。
- 折线/迷你图按真实数值 x 间距绘制；`null` 形成断线，数据表显示“无观测”。正常 0 不当成缺失。单点可显示，所有点都缺失时显示空态。
- 折线、迷你图与柱形支持负值并绘制零基线；环形只接受非负 value，总和为 0 时显示空态，总和超出有限数值范围时报错。
- `series[].color` 可选，支持十六进制、命名色、rgb/hsl 或单个 `var(--token)`；默认配色兼容深浅主题。标签与标题不接受 HTML。

键盘：Tab 进入图表入口，方向键逐个查看数值，Home/End 到首尾，Escape 回入口；悬停同样显示数值。每图提供“查看数据表”，长分类名称、窄屏省略标签及完整数值可在这里读取。轴/图例允许缩短数值，数据表和可访问数值标签保留数值精度。

刷新保留点位（系列 key + x）或分类 key 对应的焦点，以及数据表展开状态；选中项消失时焦点回入口。展开的数据表在轮询或 resize 后保留滚动容器焦点及横纵滚动位置，短暂错误后也恢复滚动位置；焦点已到外部控件时不抢回。更新后表变短、滚动容器无法原生聚焦时，焦点回图表入口。相同完整配置不会重建 DOM 或重复播放动效，普通轮询不进入 live region。宿主提供历史窗口、断网缺口与刷新节奏；组件不会推断业务上的断点。

图表消费 `--card`、`--foreground`、`--muted-foreground`、`--border-color`、`--muted-fill`、`--primary` 与字体 token，并有独立可读默认值。宿主可在 `.oao-chart` 覆盖 `--oao-chart-color-0` 至 `--oao-chart-color-7`。支持祖先的 `data-theme="dark"` / `.dark`，未指定主题时提供系统深色回退。

图表数据表的表头、首列和 hover 状态统一按图表主题 token 设置文字与底色，同时明确字号、边框和换行规则，隔离宿主全局表格样式。本轮修复了 Papa 浅主题下表头白字浅底、正文首列黑底，以及全局 hover、边框和 nowrap 规则造成的显示冲突。

### 动效偏好

```js
Oao.motion.get();                  // 'system' 或 'reduced'，返回用户偏好
Oao.motion.set('reduced');         // 或 'system'；其它值会抛错
Oao.motion.reduced();              // 综合系统偏好后的实际布尔结果
Oao.motion.animate(panel, 'enter'); // 220ms 淡入/轻微位移
Oao.motion.animate(panel);         // 160ms 数据变化淡入，实际数值立即更新
Oao.motion.cancel(panel);
Oao.motion.cancelAll();
```

偏好保存于当前浏览器的 `localStorage['oao-motion']`，存储不可用时仍在内存生效；跟随系统与跨页签存储变化。系统请求减弱动效时，不提供强制开启动画的选项。页面隐藏或 `pagehide` 会取消运行中的动效；不支持 Web Animations API 时不播放动画。

`oao-motion.css` 提供 `--oao-motion-fast`（120ms）、`--oao-motion-normal`（180ms）、`--oao-motion-enter`（220ms）与 `--oao-motion-ease`。减弱规则覆盖当前文档的动画、过渡和平滑滚动；图表独立 CSS 也遵守 `prefers-reduced-motion`。图表会在有数据变化时调用可选的 motion API，重绘、隐藏或销毁时取消；不加载 motion 模块也能正常使用图表。

---

## 核心概念

| | 谁写 | 职责 |
| --- | --- | --- |
| `Table` / `Column` / `Filter` / `Action` | 业务 | **声明**显示什么、怎么显示 |
| `Source` | 业务 | **取数**：怎么过滤、怎么排序、查库还是调接口 |
| `ActionHandler` | 业务 | **响应操作**：改哪个库、做什么校验 |
| 组件 | — | 把声明变成页面、把请求规范化后转发、把结果映射成响应 |

表格 HTTP 层向业务传入两个契约：**`Query`（进）** 和 **`ActionRequest`（进）**。图表的前端数据契约见上节。

### 组件的职责边界

**它是展示层组件，不是数据层，也不是业务层。** 哪些事不要指望它：

| 组件负责 | 组件不管（由宿主自己决定） |
| --- | --- |
| 把声明渲染成页面与操作列 | 鉴权与凭据：只提供 `Auth` / `headers` / `onUnauthorized` 三个挂钩，认不认、怎么认由宿主定 |
| 把 HTTP 参数规范化成 `Query` | **「你是谁」**：组件不认身份、也不解析凭据 —— 只把请求原样交给宿主（`ActionRequest.Req` / `ActionEvent.Req`），身份由宿主从请求头或自己注入的上下文里取 |
| 未声明的列 / 筛选 / 动作一律挡掉 | 审计：只回调 `OnAction`；记不记、记到哪由宿主定（组件不落任何存储） |
| 弹窗、校验、Toast、刷新等前端交互 | 数据的正确性与一致性：取数、写数、事务都在宿主的数据层 |
| 把业务错误按状态码回给前端 | **并发与幂等**：同一操作被触发多次（双击、两人同时点、重试）时的去重，必须由宿主在自己的数据层做——组件不保证任何时序 |
| — | 业务语义与状态维护：什么状态允许哪个动作、记录怎么流转，全由宿主定义 |

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

### 宿主预置筛选（`opts.filter`）

想"带着上下文打开某张表"（比如后台按站点 Tab 打开任务表，只看这一个站的任务），
给 `render` / `open` 传第三个参数：

```js
Oao.render(document.getElementById('app'), 'task', { filter: { site: 'huangguo' } });   // 自己画
api.open('task', { filter: { site: 'huangguo' } });                                    // 用 mount 的外壳
```

- 它就是**筛选项**，不是锁：筛选栏里会把这些条件**填好显示出来**，用户照样能改能清。
- **整体替换**而不是合并：给的就是这次要看的那一组条件 —— 不传则保持上一次的（与老行为一致）。
  要从"看某站"切回"看全部"，传 `{ filter: {} }`。
- 列名必须在该表的 `Filters` 里声明过，否则服务端不会放行（白名单在组件与服务端两层）。
- 空值表达不了"某列等于空"（`filter[site]=` 这种空值会被跳过）：需要筛"未归属"那档就另想别的表达
  （比如加一个显式的标记列）。
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

点表头排序，也可 Tab 到表头按钮后按 Enter / 空格。**Shift + 点击或键盘激活**追加第二个排序键（表头会标上优先级序号 `▲1` `▼2`）。

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
| `StateFunc` | 可选，按行计算 `{Label, Disabled, Hidden}`；nil = 表级默认 |

**按行改动作（`StateFunc`）**：同一个表级动作可以在不同行显示不同文案 / 禁用 / 隐藏：

```go
{
    Key: "push", Label: "推送 / 更新",
    StateFunc: func(row map[string]any) oao.ActionState {
        switch row["push_state"] {
        case "0":
            return oao.ActionState{Label: "未开始", Disabled: true}
        case "1":
            return oao.ActionState{Hidden: true} // 这一行改由「预处理」动作接手
        case "3":
            return oao.ActionState{Label: "推送"}
        case "4":
            return oao.ActionState{Label: "重推送"}
        case "6":
            return oao.ActionState{Hidden: true}
        }
        return oao.ActionState{}
    },
    Handler: push,
},
```

组件在列表响应的每行里加一个保留字段 `__oao_actions`（按动作 key 索引），前端按行渲染；返回零值表示用表级默认。
隐藏动作不参与 `MAX_FLAT_ACTIONS` 计数。`StateFunc` 的 `row` 是已按列声明裁剪过的只读行数据，所以用于判断的字段要声明成列（不想显示用 `Hidden: true`）。
业务行不要声明 `__oao_actions` 同名列。

**动作超过 3 个会自动收起**：前两个平铺，其余进「更多 ▾」的下拉面板（面板复用筛选下拉那一套：点外部/Esc 关、↑↓ 选、Enter 确认）——行内不会被一堆按钮淹掉。隐藏动作会在计数前先过滤。

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

### 防重复提交

组件自己挡一道：**同一「表 + 动作 + 行主键」在上一次请求结束前再次触发，会被直接忽略**
（`runAction` 里的 `inFlightActions`），请求根本不会发出去。

挡的不只是手快双击 —— 二次确认框还开着时再点一下、以及宿主将来自己调 `runAction`
的路径，都在这层里。用「表 + 动作 + 主键」而不是「按钮」当键，是因为同一个动作可能有
多个入口（行内平铺按钮、「更多 ▾」面板里的项），按按钮去重只挡得住其中一个。
确认框取消、表单取消、请求成功或失败，都会放行下一次。

**这只是省掉一次多余请求，不是幂等的替代品。** 服务端仍必须自己防重：两个人同时点、
浏览器重放、以及绕过前端直接打接口，组件都拦不住。做法见下节的 `oao.Fail` +
条件更新（把版本条件写进 `WHERE`，而不是"先查再写"）。

这两条行为都有测试：`testdata/` 下的脚本用一块最小假 DOM（共用的假件在 `testdata/fake_dom.js`）
驱动真实的 `static/oao.js`。零依赖，`node` 直接跑：

```bash
node testdata/oao_guard_test.js  static/oao.js   # 连点 3 次只发 1 个请求、上一轮结束后放行下一次
node testdata/oao_render_test.js static/oao.js   # 预置筛选进了请求与筛选栏，且不带 opts 重渲染时保持
```

（放在 `testdata/` 是因为 `oao.go` 是 `//go:embed static` —— 测试文件放进 `static/`
会被打进二进制并对外提供。）

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
| `Req` | 逃生舱：要读请求头/鉴权信息时用（`ActionEvent` 上也有同名同义的字段） |

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

`ActionEvent` 的字段：`Table` / `Action` / `ID` / `Values`（表单提交值）/ `Err` / `IP` / `At`，
以及 **`Req *http.Request`** —— 与 `ActionRequest.Req` 同一套逃生舱约定：组件不解释它，
宿主自己读。典型用途是**取鉴权中间件写进请求上下文里的「操作人」**，审计才能记下是谁干的：

```go
OnAction: func(ev oao.ActionEvent) {
    operator := myAuth.OperatorFrom(ev.Req.Context())   // 你的中间件放进去的身份
    audit.Write(ev.Table, ev.Action, ev.ID, operator, ev.Err)
},
```

`Req` 只读，别在回调里写响应；它也可能为 nil（宿主自己构造事件时），取身份前先判空。

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

分页器支持在「跳至」输入页码，按回车或点击「跳转」直接翻页，保留当前筛选、搜索、排序和每页条数。空值、非整数或超出总页数时提示错误，不发起跳页请求。

| token | 说明 |
| --- | --- |
| `--oao-shell-height` | 外壳高度，默认 `100dvh`。嵌进已有页面的子区域时改它 |
| `--oao-table-max-height` | 表格滚动区的硬上限（默认 `none`）。**只 render 不进 mount** 时，宿主容器没有确定高度，用它兜底 |

宿主自己的页面（`pages[].render`）会被包在 `.oao-page` 里，自己滚，不挤占表格页的布局。

**插槽**：`headerRight` / `sidebarFooter` 收 HTML 字符串或 `(el, api) => void`。
宿主自己的样式（头像、徽章之类）由宿主补——组件只负责把它放进正确的位置。

`Oao.mount(container, opts)` 返回 `Promise<api>`。**api**：`open(key, opts?)` 切页并支持表格预置筛选、`select(key)` 切页、`reload()` 重选当前页、`setTitle(t)` 改标题、`current()` 当前 key、`content()` 内容容器、`destroy()` 销毁外壳。表格页 `reload()` 会回到第一页；保留页码的刷新使用 `Oao.refreshInstance(api.content())`。

`pages[].render(el, page)` 的第二参数包含这些方法以及本次页面生命周期的 `page.signal`。它可以**同步返回清理函数或 `{ destroy() {} }`**；切页、reload 和销毁时先中止 signal，再调用一次清理。异步请求需要自行使用 signal，定时器、图表和其它资源由清理函数释放：

```js
render: function (el, page) {
    const chart = Oao.charts.create(el, { type: 'line', title: '宿主指标', series: [] });
    // /api/my-chart 是宿主自有接口，返回上述图表 options。
    fetch('/api/my-chart', { signal: page.signal })
        .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then(function (options) { if (!page.signal.aborted) chart.update(options); })
        .catch(function (error) {
            if (!page.signal.aborted) chart.update({ type: 'line', title: '宿主指标', error: error.message });
        });
    return function () { chart.destroy(); };
}
```

不要用 `async render()` 返回清理函数：Promise 的解析结果不会被当作生命周期钩子。renderer 同步抛错或返回的 Promise 拒绝时，组件中止该页的 `signal` 并显示错误；迟到失败不会覆盖后续页面。宿主直接改 DOM 的异步代码仍须检查 signal。

页面失效后，旧 `page.open/select/reload/setTitle/destroy` 不再作用于当前外壳；其中 `open/select/reload` 仍返回已完成的 `Promise<void>`，可继续使用 `await` 或 `.then()`。清理或 abort 回调触发新导航时，以新导航为准；清理内销毁或重新 mount 也不会被旧流程覆盖。插槽 `headerRight/sidebarFooter` 仍只接收字符串或填充函数，不具有页面的清理钩子。

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
  下拉支持 Enter 打开、方向键选择、Enter 确认和 Escape 关闭；排序使用原生按钮。
  弹窗提供可访问名称、Tab 焦点约束和关闭后的焦点恢复；Toast 使用 polite 状态播报，图表常规刷新不播报。
  另外三处**字段级白名单**也由组件把住，业务不用自己防：
  1. **列表下发**：`rows` 只保留列声明过的字段。Source 里的 `SELECT *` 不会把未声明的列（密码哈希、
     大 JSON）带到浏览器。想下发但不显示，声明成 `Hidden`。
  2. **表单提交**：`ActionRequest.Values` 只保留该动作 `Form` 里声明过的字段。
     客户端多塞的字段进不到 `Updates(req.Values)`。
  3. **筛选参数**：未声明的 `filter[...]` 不会进 `Query.Filter`。

## 开发验证

以下 Node 脚本加载真实生产 JS，通过最小 DOM 假件验证行为，不需要 npm 依赖：

```bash
node testdata/oao_guard_test.js static/oao.js
node testdata/oao_render_test.js static/oao.js
node testdata/oao_pager_test.js static/oao.js
node testdata/oao_a11y_test.js static/oao.js
node testdata/oao_lifecycle_test.js static/oao.js
node testdata/oao_lifecycle_race_test.js static/oao.js
node testdata/oao_charts_test.js static/oao-charts.js
node testdata/oao_motion_test.js static/oao-motion.js
go test ./...
go vet ./...
go build ./...
go test -race ./...
```

当前共八个 Node 脚本；`oao_lifecycle_race_test.js` 含 15 条生产 JS 行为回归，覆盖迟到 POST、凭据重试、mount 清理重入、renderer 失败和弹窗表单快照。`oao_a11y_test.js` 另覆盖单选标签即时更新、焦点恢复重入后旧弹窗正确结算；`oao_charts_test.js` 共 24 项（23 组生产 JS 行为与 1 组 CSS 隔离守卫），包含展开数据表的焦点、滚动位置与宿主表格样式隔离回归。

race 需要平台支持及可用的 C 工具链。Node 假件验证不替代真实浏览器的 SVG 布局、主题对比、窄屏和辅助技术验收。首批变更、已执行验证及发布顺序见 [2026-11-07 可视化交付记录](docs/2026-11-07-visuals-release.md)。

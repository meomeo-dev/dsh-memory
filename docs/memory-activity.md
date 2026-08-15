# 记忆活动大表设计(memory-activity)

状态页顶部(Team 状态卡之后、统计指标块之上)新增**记忆活动大表**:最近 24 小时、每 1 小时一格,X 轴为时间、Y 轴为 rules/lessons × domain 组合轴,格子显示该窗口内新写入的记忆条目数。一眼看出「哪类记忆、哪个领域、什么时候」在增长。

## 用户故事

1. 作为用户,我想在状态页顶部看到最近 24 小时记忆写入的时空分布:哪个 1 小时窗口、哪个 type × domain 组合写入了多少条,以观察抽取活动的节奏与热点。
2. 作为用户,格子数值要紧凑:最多 3 个字符——≤999 显示原值,≥1000 显示量级封顶 `99K` / `99M` / `99G` / `99B` / `99T`(爆表标记,精确值在悬停 tooltip)。
3. 作为用户,表是「实时」视图:打开页面即当前 24 小时窗口,且页面按 60s 自动刷新。

## 机制(host 端聚合,纯计算)

- 数据源 = **已存在的事实,不加新日志**:host 级注册表视图(内置层 + registry 全部仍存在的根)的全部 `.remember.jsonl` 条目,按其 `createdAt` 落桶。
- 窗口 = [now−24h, now),每桶 1 小时 → 24 桶;窗口外条目忽略。v1 旧条目由迁移回填的 createdAt(文件名日期当天本地零点)也按事实落桶。
- `src/memory-activity.ts` 纯函数 `aggregateEntryActivity(dirs, now, windowMs, bucketMs)`:
  - 扫描各目录 jsonl(读即迁移,复用 `loadDir`);
  - 每桶 `counts: Record<string, number>`,键 = `type/domain`(如 `rules/Style`),只含非零项;
  - 返回 `{ windowStart, windowEnd, bucketMinutes, buckets }`。
- DTO 挂 `dashboard.activity`;与 totals/costs 同为「每次 dashboard-get 实时计算、不落盘」。

## 展示(面板)

- **位置**:Team 状态卡之后、统计指标块(metric-grid)之上;单独一张全宽卡,标题「记忆活动 (近 24 小时,每 1 小时一格)」。
- **X 轴**:24 列(固定格宽,容器横向滚动);顶部刻度行按小时标注(每桶一格、一桶一小时,本地 `HH` 时间);刻度跨距由 DTO `bucketMinutes` 派生(桶宽变化时自动跟随,非硬编码)。
- **Y 轴**:42 行 = `rules` 段 21 域 + `lessons` 段 21 域(与 DISPLAY 枚举同序),标签列 `r/Domain` / `l/Domain`(sticky 左侧)。标签列宽随内容伸缩(128px 下限、176px 上限),超限裁剪 + ellipsis(悬停 title 显示全名)——文字永不绘制越界重叠格子区。
- **格子**:3 字符规则(≤999 原值;≥1e3 → `99K`,≥1e6 → `99M`,≥1e9 → `99G`,≥1e12 → `99B`,≥1e15 → `99T`);底色按数量 5 档强度(复用热力图 `--heat-0..4`);悬停 title 显示窗口时间、组合与精确数量。
- **实时**:状态页加 60s 自动轮询(与手动「刷新」并存;节点页 5s 轮询先例)。
- 样式在 `status.css`;组件 `pages/ActivityTable.tsx`。

## 验收标准(AC)

- **桶语义**:24 桶、1 小时粒度、[now−24h, now) 窗口;窗口外与未来时间戳条目忽略(单测锁定边界)。
- **计数正确**:条目按 `createdAt` 落桶,counts 键 `type/domain`;多根聚合(host 级)。
- **3 字符规则**:0→`0`、999→`999`、1000→`99K`、1_234_567→`99M`、1e9→`99G`、1e12→`99B`、1e15→`99T`(xbrowser fixture 断言 + 面板函数镜像)。
- **布局**:全宽卡、横向滚动、sticky 标签列;42 行 × 24 格恒渲染(空窗口全 0)。
- **标签无重叠**:全部标签 `scrollWidth ≤ clientWidth + 1` 且 `overflow: hidden`——标签文字不侵入首个格子(xbrowser 锁定)。
- **契约与视觉**:DTO 镜像;chromium / firefox / webkit 三引擎通过(零 console 错误)。

## 非目标

- 不新增持久化日志(复用条目 createdAt)。
- 不做缩放/拖动/筛选(固定窗口)。
- 不做跨 host 聚合(与 usage.jsonl 同口径,host 级)。

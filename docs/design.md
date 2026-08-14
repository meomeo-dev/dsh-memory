# 设计文档:长期记忆(Long-Term Memory)插件

> **已确认决策(阶段 0/1 拍板)**
> 1. **文件名 type 维度** = `rules` / `lessons`,**不是** layer(Global/User/Project)、不是 domain;`<partition>` 是可选自由分片前缀(见 concept.md §7)。
> 2. **记忆节点实现** = 直接 `ctx.llm.stream({ model: 'deepseek-v4-flash' })` 轻量调用,不走完整 `ctx.subagents` 子代理。
> 3. **预热** = 提前把 `llm` 调用器 + 记忆文件组装成「就绪的节点 team」;进程不退且未 stop,后续 recall 直接 fan-out,不再等待组装 / 重读磁盘。
> 4. **节点容量可配置**:每节点 ≤600Kb(默认,经 slash command 改,单位 Kb);一个节点可装载多个记忆文件。

## 1. 背景与目标

DeepSeek Harness 已有 `session-reference`(整段历史会话的有界引用),但缺一个「提炼的、跨会话累积的语义事实」层——模型在一个会话里学到的用户偏好、踩过的坑、项目约定,换一个会话就丢了。

本插件(`dsh-memory`)补上这一层:

- 模型通过 `remember` / `recall` / `forget` 工具**主动**读写长期记忆;
- 长期记忆只含 `rules` / `lessons` 两类,存 `.remember.jsonl`(真相源),渲染为 `.remember.md`(人/agent 阅读);
- 召回用**多 `deepseek-v4-flash` 记忆节点 team**,预热后 fan-out;
- system prompt 注入「已知记忆」摘要,让模型开新会话就知道「该记住什么」。

## 2. 接缝设计(阶段 0 判定)

| 接缝 | 用途 | 关键决策 |
|---|---|---|
| `ctx.tools.register` | `remember` / `recall` / `forget` 工具 | 模型在 headless 里主动调用 → **headless 可验证**(区别于 dsh-alias 的斜杠命令空转) |
| `ctx.llm.stream` | 召回用 `v4-flash` 记忆节点 team | 直接以 `deepseek-v4-flash` 发模型调用,做节点召回(不走完整 subagent 生命周期) |
| 数据文件驱动(自建) | `.remember.jsonl`(真相源)+ `.remember.md`(渲染投影) | JSONL 逐行 schema 校验;MD 只渲染、不解析 |
| `ctx.systemPrompt.section` | 注入已知记忆摘要 | `order: 10`;只注入「摘要」,不注入整段历史 |
| `ctx.commands.register` | `/lmemory` 管理命令 | 人查看 team 状态 / 操作 team / 查询记忆 / 改配置 |

工具走 `@deepseek-ai/dsh-tools` 的 `defineTool`;JSONL 记录用 schemastery 逐行校验;MD 渲染是纯函数,渲染后跑 Markdown 静态检查。配置存 `ctx.settings`。

## 3. 与 session-reference 的边界(关键决策)

这是本插件「不重复造轮子」的核心依据:

| 能力 | 记什么 | 本插件是否要做 |
|---|---|---|
| `session-reference` | 整段历史会话快照 | ❌ **明确非目标**,那是 dsh 内置的活 |
| `dsh-memory` | 提炼的语义事实(rules/lessons 两类) | ✅ 只做这个 |

**决策**:memory 的 `recall` 只检索「提炼过的条目」,**不做**「整段会话全文检索」——那会让它退化成 session-reference 的重复实现。

## 4. 目录发现与分层

复用 dsh-voice 的 `.dsh` / `.agents` 双根约定,按层覆盖:

```
内置(包内 memory/) < 用户 ~/.agents/memory/ < 用户 ~/.dsh/memory/
  < 项目 <repo>/.agents/memory/ < 项目 <repo>/.dsh/memory/
```

- 每个层级目录下,记忆按命名规范(见 concept.md §7)分文件:`YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`。
- 项目根由 `.git` 标记向上探测。
- 文件按「日期 + 分区 + 类型」天然可分片,正是记忆节点分区的依据。

**写根**:`remember` 按 `layer` 参数决定写 `~/.dsh/memory/`(user)或 `<repo>/.dsh/memory/`(project)。`scope`(影响范围)是自由文本,不决定落点。

## 5. 数据模型

一条记忆 = JSONL 的一行(见 concept.md §6):

```ts
interface MemoryEntry {
  id: MemoryId                       // 全局唯一编号(m- + 10 位 base36),见 memory-review.md §2
  type: 'rules' | 'lessons'          // 长期记忆只含两类,不含 state/todo
  domain: DomainId                   // 21 个 closed 枚举之一,见 concept.md §3
  scope: string                      // 影响范围:具体子系统 / 模块(自由文本);与 domain 正交成对
  layer: 'global' | 'user' | 'project'   // 落点层(存储元数据,不参与语义定位)
  entry: string                      // 一句话条目
  entryPoint: string                 // file path 或 '-'
  references: string                 // file path 或 '-'
}
```

**契约常量**(单一真相源,工具校验与文件校验共用):
- `MEMORY_TYPES = ['rules', 'lessons']`(不含 state/todo)
- `DOMAINS = [21 个 domain id]`(与 concept.md §3 一一对应)
- `TABLE_HEADER`(8 列表头:首列 `id` + 上述 7 字段)、`TABLE_SEPARATOR`(8 列分隔行)
- 文件名正则:`/^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9-]+)?\.(rules|lessons)\.remember\.(jsonl|md)$/`

## 6. 存储与渲染

- **真相源 JSONL**:`remember` = 追加一行(校验 schema;`rules` 重复 `entry` 拒绝、`lessons` 单条 ≤300 字);`forget` = 删除匹配行;lessons 合并 = 替换该行(**无自动主题合并**,由 agent 按 `id` 改写条目,见 memory-review.md)。所有写都改 `.remember.jsonl`。
- **渲染投影 MD**:每次写 jsonl 后,用纯函数 `renderMd(entries)` 重新生成同名 `.remember.md`(8 列表格:首列 `id` + 7 字段),再跑 `checkMarkdown(md)` 静态检查(列数一致、`|` 转义、表格闭合)。
- MD 永不解析、只生成——写逻辑只碰 JSONL,避免手写 md 表格解析器的脆弱性。
- **forget 跨文件定位(盲点修正)**:条目按命名(日期+分区)分散在多个文件里,不在「当天文件」。`forget` 因此**遍历全部可见的 `.remember.jsonl`**,对受影响的文件重写 jsonl + 重渲染 md,而非只改当天文件。
- **空表语义(盲点修正)**:`forget` 删空某文件后,仍写出「表头 + 分隔行」的空表格(保留文件骨架),**不删除文件**——保持「.md 与 .jsonl 一一对应」的命名不变量。

### 6.1 纯逻辑模块(不 import cordis,阶段 2 最先实现并单测)

这是全插件最稳、最不依赖 `v4-flash` 实时调用的部分,开发顺序上最先做。三个纯函数模块:

**`schema.ts` — JSONL 逐行 schema 校验**
- 用 schemastery 定义 `MemoryEntry` 的 schema(`type` ∈ rules/lessons、`domain` ∈ 21 枚举、`scope` 非空自由文本、`layer` ∈ global/user/project、`entry` 非空、`entryPoint`/`references` 缺省 `-`、`id` 缺省时自动生成)。
- 契约常量:`MEMORY_TYPES` / `DOMAINS` / `TABLE_HEADER` / `TABLE_SEPARATOR` / `FILE_NAME_RE`。
- 导出 `parseEntry(line: string): MemoryEntry`(非法行抛带行号的清晰错误)与 `validateEntry(entry): MemoryEntry`。
- schemastery 两坑照走:`Schema<T>` 断言 `as unknown as T`;常量显式标注 `: Schema<T>`。

**`render.ts` — JSONL → Markdown 投影(纯函数)**
- `renderMd(entries): string` 生成 8 列表格(首列 `id` + 7 字段):表头 + 分隔行 + 每行一 entry。
- 单元格内的 `|` 转义为 `\|`;`entry` 文本按列对齐的静态表格格式输出。
- `renderSummary(entries): string` 生成 system prompt 注入用的「已知记忆摘要」(非整段,只列条目文本)。

**`check.ts` — Markdown 静态检查**
- `checkMarkdown(md): string[]` 返回错误列表(空 = 通过)。
- 检查项:表头 8 列、分隔行 8 列、数据行每行列数与表头一致、无未闭合表格、单元格内 `|` 已转义。
- 用于「写 jsonl 后重渲染 MD」的最终守卫——渲染产物不通过静态检查则拒绝写盘。

### 6.2 测试与验证

- 三个纯函数模块各自单测(schema 校验边界、渲染转义、静态检查告警),无 cordis 依赖,`vitest run` 直接跑。
- 集成验证:`remember` 写一条 → jsonl 追加 + md 生成 + `checkMarkdown` 通过(AC 1/4/5)。

## 7. 召回:多 v4-flash 记忆节点 team

### 记忆节点(node)

- 每节点 = 一个 `v4-flash` 模型调用器 + 它负责的记忆文本(≤ `maxNodeKb`,默认 600Kb)。
- 一个节点可装载多个记忆文件:文件按「日期+分区+类型」分配到节点,直到累计接近容量上限。
- 节点数 = `ceil(总记忆大小 / maxNodeKb)`(实现为贪心装箱近似:文件源累加到接近上限即封口;单个超容量源独占一个节点,允许该节点超容量)。

### 预热(warm-up)与 team 生命周期

- **预热** = 读入各节点分配的记忆文件 + 绑定 v4-flash 调用器,组装成一个就绪的节点 team。
- **生命周期**:`start`(组装 team)/ `stop`(释放 team)/ `restart`(重新组装)——经 slash command 控制;`warmupOnStart` 为真时插件启动自动预热。
- 预热后、未 stop 时,recall 直接 fan-out,不再等待组装 / 重读磁盘。
- **预热键与惰性语义(盲点修正)**:预热要读项目级记忆文件,而插件启动时没有 agent/cwd。故 team 按 **project root 分键缓存**;`warmupOnStart` 只预热用户级(无 cwd)team,项目级 team 在**首次 recall 时惰性预热**。`ensureTeam(cwd)` 命中缓存即复用,未命中才组装。
- **实现取舍(纯逻辑注入)**:v4-flash 调用器(`recallFn` / `rerank`)在 recall 时经函数参数注入,而非预热时绑定到 team——`team.ts` 因此不 import cordis / dsh-llm,分区与聚合可在单测里无 API key 验证。可观察契约不变:预热后 recall 不重读磁盘、不重组装。

### 召回流程

1. **fan-out**:recall 把 query 并发派给 team 的每个节点;每节点在其记忆文本上挑出相关条目,返回候选项。
2. **聚合(aggregate)**:汇总候选 → 去重(按 entry 精确匹配)→ 按相关度重排序(`rerankPrompt` 可配)→ 截断到 `recallTopK` → 返回。

## 8. 工具 + 命令设计

### 模型工具(模型主动调用,headless 可验证)

| 工具 | 参数 | 行为 |
|---|---|---|
| `remember` | `type` / `domain` / `scope`(影响范围)/ `layer`(落点层)/ `entry` / `entryPoint?` / `references?` | 校验枚举 → 追加 JSONL 行 → 重渲染 MD;`rules` 只增不减 |
| `recall` | `query` | fan-out 到记忆节点 team → 聚合返回相关条目 |
| `forget` | `entry`(精确匹配)/ `type?` / `confirm?` | **遍历全部可见文件**按 entry 匹配删除(条目可能不在当天文件)→ 重写受影响 jsonl+md;`rules` 删除须 `confirm: true`,`type` 可限定类型 |

**提取原则由模型执行**:`remember` 的 description 写入「只记 rules/lessons 两类,禁止流水账/思考过程/代码实现/凭据」(来自 concept.md §4)。

### `/lmemory` 管理命令(人操作)

| 子命令 | 行为 |
|---|---|
| `/lmemory status` | 查看记忆节点 team 状态(节点数、每节点大小、预热状态) |
| `/lmemory team start` / `stop` / `restart` | 组装 / 释放 / 重新组装 team |
| `/lmemory query <text>` | 人主动查询长期记忆(fan-out 同 recall) |
| `/lmemory config get` / `set <key> <value>` | 读写配置项(见 §9) |

> `/lmemory review`(质检,注入主会话)与 `/lmemory catalog rebuild`(重建 catalog)属独立扩展,见 [memory-review.md](memory-review.md) §5 / §3。

命令 handler 收 `invocation.rawInput`,自行解析子命令;返回 `{kind:'success'|'error', text}`。命令是「人操作面」,工具是「模型操作面」,两者共享同一 team 与存储。

## 9. 配置项(存 `ctx.settings`,slash command 读写)

| 配置项 | 默认 | 含义 |
|---|---|---|
| `maxNodeKb` | `600`(Kb) | 每记忆节点最多负责的记忆文本大小 |
| `recallTopK` | `10` | recall 返回的最大条目数 |
| `rerankPrompt` | 见下 | 聚合阶段重排序候选的提示词模板 |
| `warmupOnStart` | `true` | 插件启动时是否自动预热用户级 team |
| `provider` | `deepseek-official` | 召回调用的 LLM provider(`ctx.llm.stream` 的 `GenerateOptions` **强制要求 provider**) |
| `model` | `deepseek-v4-flash` | 召回节点与重排序所用的模型 |

**`rerankPrompt` 默认模板**(通用重排序提示词,聚合阶段对去重后的候选做相关度排序):

```
你是记忆召回的重排序器。给定用户的查询与若干候选记忆条目,请按与查询的相关度从高到低排序,并仅输出排序后的条目文本(一行一条),不输出任何解释。若两条相关度相同,保持原顺序。请勿编造条目,只使用给定候选。
```

> 这是「设计起点的合理集」,开发时按需增删(召回模型、节点并发度等)。
>
> 扩展文档另增配置键(同样存 `ctx.settings`,经 `/lmemory config set` 读写):auto-extraction.md §7 增 `autoExtract` / `extractMode` / `extractInterval` / `signalWords` / `extractRulesPrompt` / `extractLessonsPrompt`;memory-review.md §7 增 `reviewModel`。

## 10. 验收标准(AC)

1. `remember` 写一条记忆 → 追加到对应 `.remember.jsonl`,并生成同名 `.remember.md`(8 列:首列 `id`,通过静态检查)。
2. `recall` 经记忆节点 team 召回相关条目;预热后、未 stop 时不重读磁盘、不重组装。
3. `forget` 删除 JSONL 行并重渲染 MD;`rules` 删除需确认。
4. JSONL 每行 schema 校验:type 非法、domain 非法、列缺失 → 拒绝并报清晰错误。
5. MD 渲染后通过 Markdown 静态检查(`|` 转义、列数一致)。
6. `rules` 只增不减(重复 entry 拒绝);`lessons` 单条 ≤300 字(自动主题合并不做,见 §6)。
7. `/lmemory status` / `team start|stop|restart` / `config get|set` / `query <text>` 均可操作。
8. `maxNodeKb` 可经 `/lmemory config set` 修改;变更时自动释放已预热 team,下次 recall 按新容量重分区(无需手动 restart)。
9. system prompt 注入已知记忆摘要(非整段历史)。
10. **headless 验证**:第一次任务 `remember` 一条偏好 → 第二次任务 `recall` 能召回。

## 11. 非目标

- ❌ 整段会话全文检索(那是 `session-reference` 的活,§3)。
- ❌ 向量化 / embedding 检索(先做 v4-flash 节点召回)。
- ❌ 会话结束自动提取记忆(先做工具触发,模型提取;自动提取的三形态见 §12)。
- ❌ Web UI 记忆管理界面(先做 `/lmemory` 命令)。
- ❌ state/todo 进长期记忆文件(它们是短期上下文,concept.md §4)。
- ❌ 完整 `ctx.subagents` 子代理节点(先做 `ctx.llm.stream` 轻量调用,见顶部决策 2)。

## 12. 独立扩展设计(是否实现各是独立决策)

两个独立文档承载「主动记忆路径之外」的扩展能力,不动本文件的核心设计:

- **自动提取(三种触发形态)** → [auto-extraction.md](auto-extraction.md):信号词 / 计数器 / 事件+计数器 三形态、dsh 事件落点、抽取窗口(与主会话上下文一致)、配置项与「model-visible ⟺ logged」约束。
- **记忆寻址、目录与质检(Review)** → [memory-review.md](memory-review.md):唯一编号 id、catalog、切 `deepseek-v4-pro` 的 review 质检、`/lmemory review` 闭环、按 id 的 query/update/delete 工具。
- **数据契约与演进式数据设计** → [data-contract.md](data-contract.md):ER/3NF、`schema/*.schema.yaml` 单一真相源 + codegen、记录级 `schemaVersion`、`migrations/` 迁移引擎(Data + Schema + Migrate 三件套)。
- **健壮性设计** → [robustness.md](robustness.md):节点容错(per-node 降级)、LLM 停机语义(依赖 LLM fail-fast、纯文件不受影响)、停机只影响 dsh-memory 自身不入侵 dsh。

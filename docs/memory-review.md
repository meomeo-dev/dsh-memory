# 记忆寻址、目录与质检(Review)

本文档定义 dsh-memory 从「只召回」升级为「召回 + 质检」所需的一组互相咬合的新机制:**唯一编号(id)** 让单条记忆可寻址、**目录(catalog)** 让记忆文件可定位、**质检(review)** 用 `deepseek-v4-pro` 发现记忆的缺陷、**记忆操作工具** 让主 agent 能按 id 修复。四者递进:id + catalog 是寻址基础,工具是操作面,review 是质检闭环。

它是设计文档([design.md](design.md))与概念文档([concept.md](concept.md))的补充;是否实现是独立决策,不影响已完成的主动记忆路径。

## 1. 问题:现在的记忆「看得见、够不着」

现有记忆由三个工具维护(`remember` 写、`recall` 召回、`forget` 删),但缺「精确操作单条」的能力:

- **无唯一编号**:`recall` 是语义召回、`forget` 按 `entry` 文本精确匹配——都不能「指着某一条」说改它、删它。两条 `entry` 文本相同的记忆无法区分。
- **无目录**:记忆按「日期 + 分区 + 类型」分散在多层目录的多个文件里。`forget` 靠「遍历全部可见 `.remember.jsonl`」定位(design.md §6 的盲点修正),每次操作都要全量扫描。
- **无质检**:记忆只会累积、不会自省。矛盾的偏好(「用 pnpm」vs「用 npm」)、重复条目、被新事实推翻的旧结论、与当前项目背离的旧状态,都会一直躺在记忆里误导后续召回。

本节到 §6 逐一补上。

## 2. 唯一编号(MemoryId)

每条记忆一个全局唯一、可引用的 id。给 `MemoryEntry`(concept.md §6)加必填字段:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

type MemoryId = Branded<string, 'MemoryId'>   // 形如 "m-3k9f2x8q1a"

interface MemoryEntry {
  id: MemoryId                              // 新增:全局唯一编号
  type: 'rules' | 'lessons'
  domain: DomainId
  scope: string                             // 影响范围:具体子系统 / 模块(自由文本)
  layer: 'global' | 'user' | 'project'      // 落点层(存储元数据)
  entry: string
  entryPoint: string
  references: string
}
```

**生成**:`m-` + 10 位 base36(crypto 随机)。用随机而非全局递增,是因为记忆跨「global/user/project」三层**落点层(layer)**分散写,递增编号需要跨层协调一个全局计数器(引入分布式状态);随机 id 全局唯一、无需协调、短且可引用。

**稳定性**:id 随记忆一生不变。`update` / `delete` / review 发现 / `forget` 都以 id 定位;文件重写、重渲染、跨分区迁移都不改 id。它是 catalog 的主键、review 报告的引用、工具操作的句柄。

**落盘**:id 写入 `.remember.jsonl` 的每行(真相源),MD 表格加一列「id」或保持 7 列而 id 只存 jsonl。建议 MD 仍 7 列(给人看),id 是 jsonl 的机器字段——但这会让「.md 与 .jsonl 一一对应」的列数对齐被打破,故**MD 也加 id 列**,`TABLE_HEADER`/`TABLE_SEPARATOR` 同步改(见 §3 与 design.md §6.1 的 `checkMarkdown` 列数检查)。

## 3. 目录(Catalog)

**catalog 是派生的索引,不是真相源**:真相源仍是 `.remember.jsonl`,catalog 由 jsonl 扫描重建,记录「每条记忆 id → 所在文件」。

**存储**:每层 `lmemory/` 目录一个 `catalog.json`,全量重写(非追加)。它是可重建的派生数据,增删改就重写整份,无 tombstone、无 compaction 问题。

```json
{
  "version": 1,
  "entries": [
    {
      "id": "m-3k9f2x8q1a",
      "file": "2026-08-13.rules.remember.jsonl",
      "type": "rules",
      "domain": "DurablePrefs",
      "scope": "全项目",
      "layer": "project",
      "entry": "用户偏好使用 pnpm 而不是 npm 来管理依赖。"
    }
  ]
}
```

- `file` 是相对本层 `lmemory/` 目录的路径,指向具体 `.remember.jsonl`。
- **分层**:与记忆文件同层分布(design.md §4),每层一个 `catalog.json`(各自独立,不做跨层合并)。查询/操作按「就近覆盖」合并可见层(内置 < 用户 < 项目,同级 `.dsh` > `.agents`)扫描定位,不读 catalog(见下方「定位方式」)。

**维护(程序自动)**:每次写操作(`remember` / `update` / `delete` / `forget`)改完 `.remember.jsonl` 后,同步更新对应层的 `catalog.json`(增 / 改 / 删条目,全量重写)。

> **定位方式(实现决策)**:`find` / `update` / `remove` / `forget` 定位记忆时**扫描可见文件 + 惰性迁移**,不读 catalog——catalog 仍被写盘维护,但 store 不依赖它定位。这是对「改查 catalog 定位、不再全量扫描」字面目标的**有意偏离**:jsonl 是真相源,扫描 + 迁移是「总是正确」的路径,不会把 catalog 的滞后(手动编辑 jsonl 后未 rebuild)带进定位;catalog 的职责收缩为「派生索引 + rebuild 一键对齐」,不承担定位职责。因此 design.md §6「forget 遍历全部文件」的盲点修正仍保留,实现改为「扫描 + 迁移」而非「查 catalog」。

**重建兜底**:`/lmemory catalog rebuild` 扫描所有可见 `.remember.jsonl`,重建全部 catalog(手动编辑 jsonl 后的一键对齐;不一致时以 jsonl 为准)。

## 4. 质检(Review)——切 `deepseek-v4-pro`

记忆节点 team 现有**召回模式**(`deepseek-v4-flash` 节点 fan-out)。新增**质检模式**:同一 team 骨架,节点模型切 `deepseek-v4-pro`(更强推理),提示词换成「批判性审查」。

**四类缺陷**:

| 缺陷 | 含义 | 例 | 建议动作 |
|---|---|---|---|
| `contradiction` 矛盾 | 两条记忆互相冲突 | 「用 pnpm」vs「用 npm」 | 保留较新/较权威一条,`update` 或 `delete` 另一条 |
| `duplicate` 重复 | 同义记忆多条 | 两条「提交用 Conventional Commits」 | `merge` 成一条(`update` 一条,`delete` 其余) |
| `outdated` 过时 | 被新事实推翻 | 「某 API 已废弃」的旧结论 | `update` 改 entry 或 `delete` |
| `divergence` 背离 | 与项目实际/当前意图背离 | 记忆停在旧的项目状态 | `update` 纠正或 `delete` |

**流程**(复用 team 的分区 + fan-out + 聚合骨架):

1. **fan-out**:把全部记忆按节点分区,每节点用 `deepseek-v4-pro` 在其记忆文本上做质检,返回「本节点内的缺陷发现」(单节点内可判矛盾/重复/过时/背离)。
2. **聚合(aggregate)**:汇总各节点发现,**跨节点**再判一次矛盾/重复(两条同义/冲突记忆可能分在不同节点),去重合并成最终报告。

**报告结构**(结构化,供主 agent 行动):

```
每条发现 = {
  id: MemoryId              // 目标记忆(merge 时是保留的那条)
  problem: 'contradiction' | 'duplicate' | 'outdated' | 'divergence'
  related: MemoryId[]       // 关联的其它记忆(矛盾/重复的对方)
  note: string              // 一句话描述问题
  suggest: 'update' | 'delete' | 'merge'
  suggestedEntry?: string   // update 时的建议新 entry 文本
}
```

review **只发现、不自动改**——修正由主 agent 决策后调工具执行(见 §6)。这与「记忆是用户意图的长期沉淀,不可静默改写」的原则一致。

## 5. review 闭环:slash command → 主会话 → 工具修复

**触发**:`/lmemory review [layer|domain]`(人操作面,可选限定 layer/domain 缩小质检范围)。

**关键机制——命令结果不进模型表面**:dsh 的命令执行落 `command/run`/`command/done` 事件(durable),但它们是 **log-only、never model surface**。命令的返回文本不会自动让主 agent 看到。因此 review 命令分两步:

1. **执行 review**(v4-pro fan-out + 聚合),得到报告;
2. **把报告注入主会话**,唤醒主 agent 处理。

**注入用 `agent.followup(message)`**(`@deepseek-ai/dsh-agent`):它「queue an ordinary follow-up turn and wake the driver」「becomes the sole ordinary message of its own turn」。命令 handler 已持有 `CommandInvocation.agent`,直接:

```ts
ctx.commands.register({
  name: 'lmemory',
  handler: async (invocation) => {
    // …解析子命令为 review…
    const report = await runReview(invocation.agent.session, { layer })   // v4-pro 质检
    invocation.agent.followup(createUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: `记忆质检:发现 ${report.length} 处缺陷` },
      content: [{ type: 'text', text: renderReport(report) }],
    }))
    return { kind: 'success', text: `review 完成,发现 ${report.length} 处,报告已注入会话` }
  },
})
```

> **合成 source(实现决策)**:示例里的 `{ kind: 'memory-review' }` 未采用——`MessageSourceMap` 是 merge-extensible 的 sum type,新增 kind 需 declaration merging;实现改用现成的 `{ kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary }`(插件合成消息的标准 source)。`form: 'notice'` + `summary` 让注入的报告在转录里以折叠行呈现。

注入的报告以「缺陷清单 + 每条记忆的 id + 建议动作」形式进入模型,主 agent 据此自主调 `memory-update` / `memory-delete` 工具修复(见 §6),修复后回写记忆文件 + catalog。

**为什么用 `followup` 而非 `inject`**:`inject` 只排队不唤醒(「without waking the driver」),要等下一次自然 follow-up/steer 才被消费;`followup` 立即成为新 turn 唤醒 driver,让 review 结果被即时处理。

## 6. 记忆操作工具(查询 / 更新 / 删除)

为让主 agent 能按 id 修复 review 发现的问题,新增「按 id 精确操作」的工具集。查询/更新/删除三个动作,按单一职责拆为三个工具:

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory-find` | `id`(精确查一条)/ `type?` `domain?` `scope?`(影响范围)/ `layer?`(过滤列多条) | 扫描可见文件按 id/条件过滤,返回记忆条目(含 id / file / 完整字段);catalog 不参与定位(见 §3) |
| `memory-update` | `id`(必填)+ 要改的字段(`entry?` `domain?` `scope?` `entryPoint?` `references?`) | 按 id 定位文件,改写该行 jsonl → 重渲染 MD → 更新 catalog;`id` 与 `layer` 不可改 |
| `memory-delete` | `id`(必填)+ `confirm?` | 按 id 定位文件,删除该行 → 重渲染 MD → 更新 catalog;`rules` 删除须 `confirm: true` |

**与现有工具的关系**:

- `recall`(语义召回)与 `memory-find`(按 id/条件精确查)互补:recall 回答「和 query 相关的有什么」,memory-find 回答「这条 id 具体是什么、在哪」。
- `forget`(按 `entry` 文本精确匹配)与 `memory-delete`(按 id)并存:forget 是「不知道 id 时的宽泛删除入口」,memory-delete 是「按 id 的精确删除」。review 修复走 memory-delete(报告带 id)。
- `remember`(写新)改为同时生成 id 并写 catalog。

> 注:用户需求描述为「2 个工具」,但列出的动作是查询/更新/删除三项。本设计按单一职责拆 3 个;若需压缩为 2 个,可将 `memory-update` + `memory-delete` 合并为一个 `memory-mutate`(带 `operation: 'update' | 'delete'` 枚举),查询仍单列。

## 7. 配置项(存 `ctx.settings`,经 `/lmemory config set`)

| 配置项 | 默认 | 含义 |
|---|---|---|
| `reviewModel` | `deepseek-v4-pro` | 质检模式所用的模型(召回仍用 `model`,见 design.md §9) |

> `reviewLayer` 与 `catalogVersion` 不设为用户配置:`reviewLayer`(review 默认质检范围)由 `/lmemory review [layer|domain]` 的调用参数限定(§5),不做持久化默认;`catalogVersion` 是写死在 store 的格式常量(`CATALOG_VERSION = 1`),格式变更时由代码递增,不开放覆盖。

## 8. 验收标准(AC)

1. `remember` 写新记忆 → 生成唯一 id,写 jsonl + 重渲染 MD(id 列)+ 更新 catalog。
2. `memory-find --id <id>` 定位文件,返回该条完整记忆(含所在文件);catalog 不参与定位(见 §3)。
3. `memory-update --id <id> --entry …` 改该行 jsonl → 重渲染 MD → 更新 catalog;id 不变。
4. `memory-delete --id <id>` 删该行 → 重渲染 MD → 更新 catalog;`rules` 删除需确认。
5. `/lmemory review` 触发 v4-pro 质检 → 报告经 `agent.followup` 注入主会话 → 主 agent 能按报告 id 调工具修复。
6. `/lmemory catalog rebuild` 从全部 jsonl 重建 catalog,与 jsonl 对齐。
7. catalog 与 jsonl 不一致时,rebuild 以 jsonl 为准恢复。
8. 质检四类缺陷(矛盾/重复/过时/背离)均能被 review 报告识别并带 id 输出。

## 9. 非目标

- ❌ review 自动改记忆(质检只发现,修正由主 agent 决策,§4)。
- ❌ 向量化 / embedding 判重复(先做 v4-pro 语义判重,§4)。
- ❌ catalog 成为真相源(catalog 是派生索引,真相源仍是 jsonl,§3)。
- ❌ 记忆的版本历史/undo(先做 id 精确改删,不做审计日志)。
- ❌ review 定时自动运行(先做 slash command 手动触发,§5)。

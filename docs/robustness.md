# 健壮性设计:节点容错与停机语义

本文定义 dsh-memory 在「LLM 节点失败 / LLM 不可用」时的健壮性行为。它是 data-contract.md(数据治理)与 design.md(技术设计)在**故障面**的补充。

## 0. 硬约束:停机只影响 dsh-memory 自身

**dsh-memory 的停机边界 = 插件自身,绝不入侵 dsh。** 所有失败必须：

1. **干净地报给 dsh-memory 自己的调用方**,不产生 unhandled rejection、不让 dsh 的 loop / 其它插件崩溃:
   - 模型工具(recall / review / extract)失败 → `execute` 抛错,由 `defineTool` 框架转成 **tool error 返回给模型**(模型决定下一步);
   - `/lmemory` 命令失败 → `handleCommand` 的 catch 返回 `{kind:'error', text}`(已是现状);
   - 自动提取失败 → `scheduleExtraction` 的 `void runExtraction().catch(logger.warn)`(已是现状,fire-and-forget 吞错)。
2. **不触碰 dsh 的 provider / adapter / retry 配置**——LLM 不可用是 dsh 的 llm 层问题,dsh-memory 只读取失败信号做自身降级,不改 dsh 的注册、不改 dsh 的 retry policy。
3. **不阻塞 dsh 的 turn**——`agent/turn-stopping` 是 serial 事件,抽取监听器同步返回 void,真正抽取后台 fire-and-forget(已是现状),绝不在 turn 边界 await LLM。

## 1. 现状:三个 fan-out 都无 per-node 容错

| 位置 | 现状 | 单节点失败后果 |
|---|---|---|
| `team.ts:recall` | `Promise.all(team.nodes.map(recallFn))` | 整个 recall 抛异常 |
| `review.ts:runReview` | `Promise.all(team.nodes.map(nodeReviewFn))` | 整个 review 抛异常 |
| `extract.ts:extractBoth` | `Promise.all([rulesFn, lessonsFn])` | 整个抽取抛异常 |

任何单节点失败(该节点模型调用超时 / 报错)都会让**整个 fan-out 失败**,丢掉其它健康节点的结果。这是要修的缺陷。

## 2. 节点容错(问题 3):per-node 降级

**原则**:单节点失败不拖垮全队,降级为「跳过该节点、返回其余节点结果」;**全部节点失败**才 fail-fast(衔接 §3 停机语义)。

### 2.1 recall(`team.ts`)

```ts
// 现状:Promise.all → 任一失败整体 reject
// 目标:Promise.allSettled,单节点失败跳过 + 记录,其余节点结果照常聚合
const settled = await Promise.allSettled(team.nodes.map(n => recallFn(n, query)))
const candidates = settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
// 全部失败(无任何 fulfilled)→ 抛错(LLM 完全不可用)
if (settled.every(r => r.status === 'rejected') && team.nodes.length > 0) throw ...
```

- **部分失败**:健康节点结果正常去重 + rerank + 截断。
- **全部失败**:抛「memory recall: all nodes failed」,衔接停机语义。
- **空 team(0 节点)**:`warmUp([], maxNodeKb)` 得 0 节点,recall 直接返回空(已有语义,不抛错)。

### 2.2 review(`review.ts:runReview`)

```ts
const settled = await Promise.allSettled(team.nodes.map(nodeReviewFn))
const intra = settled.flatMap(r => r.status === 'fulfilled' ? r.value : [])
// 跨节点判矛盾/重复(健康节点仍可判)照常;全失败则抛
```

- review 的跨节点判(`crossNodeReviewFn`)是**第二类调用**,若它也失败 → 降级为「只用节点内发现」(intra 结果仍返回),不因跨节点失败丢 intra。

### 2.3 extract(`extract.ts:extractBoth`)

```ts
const [rules, lessons] = await Promise.allSettled([rulesFn(t), lessonsFn(t)])
// 单类型失败 → 该类型返回空候选,另一类型照常
// 两类型都失败 → 抛(LLM 完全不可用)
```

- rules / lessons 是**两个独立职责节点**,一个失败不拖垮另一个。

### 2.4 统一：部分失败要可观测

降级不是静默吞错。每次「跳过失败节点」都要 `logger.warn` 记录(哪个节点 / 什么错),让运维可观测,但**不中断流程**。

## 3. 停机语义(问题 4):LLM 不可用

### 3.1 dsh 侧提供的停机信号

`ctx.llm.stream` 失败时抛的 LlmError 有 `code`,是停机语义的判据(来自 `dsh-llm` / `dsh-llm-deepseek`):

| code | 含义 |
|---|---|
| `NO_ADAPTER` | provider 未注册(deepseek-official 无 adapter) |
| `MISSING_CREDENTIAL` | 无 `DEEPSEEK_API_KEY` |
| `TRANSPORT` | 网络失败 |
| stream idle timeout | 流 5 分钟无数据 |

dsh-memory 只**读取**这些失败信号做自身降级,不改 dsh 的 provider/adapter/retry(§0 硬约束)。

### 3.2 能力分级:依赖 LLM vs 纯文件

| 能力 | 依赖 LLM | LLM 不可用时 |
|---|---|---|
| `recall`(召回) | ✅ v4-flash | **不可用** → fail-fast 报错(模型看到 tool error) |
| `review`(质检) | ✅ v4-pro | **不可用** → fail-fast 报错 |
| `extract`(自动提取) | ✅ v4-flash | **不可用** → 抽取失败,logger.warn(不阻塞 turn) |
| `remember` / `forget` / `find` / `update` / `delete` | ❌ 纯文件 | **仍可用**(不受 LLM 影响) |
| system prompt 摘要 | ❌ 纯文件 | **仍可用** |
| `/lmemory status` / `team` / `catalog` / `config` | ❌ 纯文件 | **仍可用** |

**关键**:停机只砍「依赖 LLM 的能力」,纯文件能力(dsh-memory 的记忆读写在 LLM 挂了时)照常——这保证 dsh 整体不因 dsh-memory 的 LLM 依赖而退化。

### 3.3 fail-fast 的落点

- **工具路径**:`recall` / `review`(工具化的 review 将来如有)execute 抛错 → defineTool 转 tool error → 模型自主决定(重试 / 告诉用户 / 跳过)。
- **命令路径**:`/lmemory query`(recall)、`/lmemory review` 的 catch 返回 `{kind:'error', text}`(已是现状)。
- **自动提取路径**:`scheduleExtraction` 的 catch + logger.warn(已是现状)。
- **绝不让错误逃逸到 dsh 的 loop**:所有 LLM 失败都被上述三路捕获,不产生 unhandled rejection。

## 4. 记忆为空的兜底(问题 2 的澄清)

「几类 team 都至少 1 节点 warmup」是伪需求。正确语义:

| 记忆状态 | recall team | 行为 |
|---|---|---|
| 空(0 条记忆) | 0 节点 | recall 返回空(无记忆可召回),**不报错、不凑空节点** |
| 非空 | ≥1 节点(按容量分区) | 正常 fan-out |

「几类 team」实际只有 **recall 有预热 team 语义**;review / extract 是 on-demand 临时构建,无预热概念。预热覆盖范围已正确:用户级 `warmupOnStart` + 项目级首次 recall 惰性预热(design.md §7)。无漏。

## 5. 验收标准(AC)

1. recall 单节点失败 → 其余节点结果正常返回(不整体失败);全节点失败 → 抛「all nodes failed」。
2. review 单节点失败 → 其余节点缺陷照常;跨节点判失败 → 仍返回节点内发现。
3. extract 单类型节点失败 → 该类型空候选、另一类型照常;两类型全失败 → 抛。
4. 每次「跳过失败节点」都 logger.warn(可观测)。
5. LLM 不可用(`NO_ADAPTER`/`MISSING_CREDENTIAL`/`TRANSPORT`)时:recall/review 工具报 tool error,`/lmemory query`/`review` 返回 error,自动提取 warn;remember/forget/find/update/delete/system prompt 摘要仍可用。
6. 记忆为空 → recall 返回空,不报错、不凑节点。
7. 无 unhandled rejection;dsh 的 loop 与其它插件不受 dsh-memory 停机影响。

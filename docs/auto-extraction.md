# 自动提取设计:三种触发形态

本文档是 dsh-memory 的**独立扩展设计**——把「主动记忆」升级为「自动提取记忆」的可选形态。它描述三种触发机制,是设计文档([design.md](design.md))的补充;是否实现、实现哪种,是独立决策,不影响已完成的主动记忆路径。

## 1. 背景:主动 vs 自动

当前 dsh-memory 是**主动记忆(active)**:模型在会话中自己决定调 `remember` 工具写一条记忆。已真实验证(headless「记住偏好 → recall 召回」全通)。

主动记忆的局限:

- 依赖模型「自觉」,模型未必会在该记的时候调 `remember`;
- 用户说「下次用 X」这类偏好时,模型可能只是口头应下,不落记忆。

自动提取(automatic extraction)补上这一层:**在会话进行中,由触发器决定「何时该抽一次记忆」,抽取动作由 v4-flash 完成,复用主动记忆的共享存储层写盘**(不经过模型面工具,见 §5.5)。

## 2. dsh 事件全景(触发设计的真相源)

自动提取必须挂在 dsh 的扩展点上。可用事件分三类:

**Agent 事件**(`agent/*`,live,携带 Agent,可拦截/观察):

| 事件 | mode | 语义 |
|---|---|---|
| `agent/created` / `disposed` | emit | 生命周期 |
| `agent/session-start` | emit | 会话开始 |
| `agent/pre-step` | waterfall | 每步前,决定模型看什么 |
| `agent/request` | waterfall | 每个模型请求 |
| `agent/request-error` | waterfall | 请求出错 |
| `agent/status` | emit | 生命周期状态转换 |
| `agent/turn-stopping` | **serial** | **turn 结束前**,可 steering 下一步 |
| `agent/error` | emit | 出错 |

**Session 事件**(`session/event`,durable,入 log,可持久/可回放):

```
turn/start → step/start → user/message → assistant/chunk* → assistant/message
→ tool/call* → tool/result* → step/end → ... → turn/end
```

**选型原则**:

- 要「每 turn 边界做一次判断」→ 用 `turn/end`(session 事件,durable)或 `agent/turn-stopping`(serial,可安全读状态)。
- 要「观察消息内容是否含信号词」→ 用 `session/event` 的 `user/message` / `assistant/message`。
- 要「拦截/改写」→ 用 waterfall(本设计**不需要**拦截,只需观察,故用 emit/serial 即可)。
- 要用「agent 事件本身的语义触发」(出错、会话开始)→ 用 `agent/error` / `agent/session-start`(emit,可纯观察)。

## 3. 三种触发形态

按「成本递增、准确性递增」排序。

### 形态 1:信号词(signal word)

**触发**:监听 `session/event`,当 `user/message` 或 `assistant/message` 的文本命中信号词时触发。

**信号词集**(中英,可配置):

```
记住 / 下次 / 以后 / 偏好 / 习惯 / 约定 / 规则 / 常 / 总是 / 从不
remember / preference / always / never / habit / rule
```

**落点**:

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return
  if (!containsSignalWord(textOf(event))) return
  scheduleExtract(session)   // 把「抽取本 turn 对话」排入队列
})
```

**逻辑**:命中信号词 → 把「该消息 + 上下文」喂给一个 v4-flash 调用,提示词要求「从对话中抽取 rules/lessons 记忆;无值得记的则返回空」→ 非空结果走 `remember` 写盘。

**代价**:每次命中一次 v4-flash 调用;误报靠提示词约束「无记忆返回空」。

**优点**:贴近主动记忆,把「谁发起」从模型自发觉变成信号词定向;成本可控。
**缺点**:纯关键词会漏判(「记得…」是陈述不是要记)、误判(命中信号词但无记忆价值)。

### 形态 2:计数器(counter)

**触发**:监听 `turn/end`,累计轮次,每 N 轮抽一次。

**落点**:

```ts
let turnsSinceLastExtract = 0
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  turnsSinceLastExtract += 1
  if (turnsSinceLastExtract >= extractInterval) {
    void extract(session)          // 抽最近 N 轮对话
    turnsSinceLastExtract = 0
  }
})
```

**逻辑**:`turn/end` +1;到阈值 `extractInterval`(默认 5)触发一次 v4-flash「从最近 N 轮对话抽取值得长期记住的 rules/lessons」,重置计数器。

**代价**:每 N 轮一次 v4-flash 调用;`extractInterval` 可配置(`/lmemory config set extractInterval 5`)。

**优点**:成本可预测(1/N 轮次);与信号词无关,不会漏。
**缺点**:纯粹按轮次,可能抽空(浪费一次调用)、或错过关键一轮(偏好正好落在间隔内)。

### 形态 3:事件 + 计数器(event + counter)—— 推荐

**触发**:两个正交维度——**agent 事件(语义信号)+ 计数器(退火抑制高频)**。「事件」指 **agent 事件**(`agent/*`),以事件本身的语义作为抽取信号,既不是消息内容(形态 1)、也不是纯频率(形态 2)。

**「事件」= agent 事件**(emit/serial,可纯观察):

| agent 事件 | mode | 触发语义 |
|---|---|---|
| `agent/error` | emit | 出错 = 强信号「记 lesson」 |
| `agent/session-start` | emit | 会话开始 = 回顾上次会话未沉淀的尾部 |
| `agent/turn-stopping` | serial | turn 关闭前 = 常规检查点(每 turn 一次,高频) |

**「计数器」= 退火/冷却(annealing)**:事件本身可能高频触发——`agent/turn-stopping` 每 turn 一次、连续出错会反复触发 `agent/error`。计数器维护「距上次抽取的 turn 数」作为**冷却期**,冷却期内抑制一切事件抽取,把实际频率降到「每 N turn 最多一次」。它**不是**兜底(不主动触发抽取),而是**抑制器**(事件是唯一触发源,计数器决定放行与否)。

**落点**:

```ts
let turnsSinceLastExtract = 0        // 距上次抽取的 turn 数(冷却计时)

// 退火门槛:冷却期内抑制,防止事件触发太频繁
function cool(session: Session): void {
  if (turnsSinceLastExtract < cooldownTurns) return   // 冷却中,退火抑制
  void extract(session)                                // 从主会话上下文抽取
  turnsSinceLastExtract = 0
}

// 高频检查点:每 turn 触发一次,退火降到每 N turn 最多一次
ctx.on('agent/turn-stopping', ({ agent }) => {
  turnsSinceLastExtract += 1                          // 先计时
  cool(agent.session)
})

// 强语义事件:出错即抽,退火同样防连续 error 高频触发
ctx.on('agent/error', ({ agent }) => cool(agent.session))

// 会话开始:新会话冷启动,直接抽(冷却计数器随新会话自然归零)
ctx.on('agent/session-start', ({ agent }) => {
  void extract(agent.session)
  turnsSinceLastExtract = 0
})
```

`extract(agent.session)` 拿 session 调 `deriveMessages()`(见 §4)得到主会话此刻上下文。

**代价**:事件触发是高频的,但退火冷却把真实抽取次数压到「每 N turn 最多一次」;强语义事件(出错、会话开始)在冷却期外即时响应。成本可预测且不随事件频率失控。

**优点**:事件语义(出错→lesson、会话开始→回顾)精准;退火保证事件再频繁也不超频。
**缺点**:逻辑较复杂,要维护一个冷却计数器 + 三个事件监听。

## 4. 抽取窗口:与主会话上下文保持一致

触发形态决定「何时抽」;本节回答「抽什么范围」。结论一句话:**抽取器的输入 = 主会话此刻模型能看到的上下文,不自己维护独立窗口 / 游标 / 压缩**。

### 4.1 真相源:`session.deriveMessages()`

dsh 的 session 暴露 `deriveMessages(): Message[]`(`packages/core/session/src/index.ts:726`)——「派生 LLM 消息历史」的公开 API,它就是主会话模型上下文的单一真相源:

- **已经反映 compaction**:compaction 的 `replace` 删除被阴影(shadowed)的节点,`deriveMessages()` 返回的正是压缩后的**有界**上下文;
- **cached、O(新增节点)**:每次调用只投影新节点,自动提取每次触发直接拿它,无额外组装、无额外读盘;
- **deep-frozen、model-visible ⟺ logged**:返回冻结快照,与「任何进入模型请求的内容都能从 log 重建」的铁律天然一致。

### 4.2 为什么不用增量窗口 / 滚动窗口

之前设计的两个方案各有硬伤,正是「自己维护窗口」带来的:

- **增量窗口(水位线)会记忆漂移**:水位线是独立于主会话的游标。主会话经 compaction 切断旧上下文后,抽取器若只按「新增 turn」独立抽取,就失去主会话已维护好的上下文——抽取出的记忆与模型实际理解不一致 = **记忆漂移**。
- **滚动窗口要自己管压缩**:自己维护滑动窗口,就必须自己管理上下文压缩,重复造轮子(compaction 已存在)。

两者在 `deriveMessages()` 面前同时消失:它随主会话的 compaction 一起收缩,抽取器**永远看到模型此刻看到的上下文**——既不漂移,也无须自己压缩。

### 4.3 topic 切分:不需要显式判断

对话滚动出现多 topic 时,主会话的 compaction 已经在维护「模型此刻看什么」——上下文边界由它处理,抽取器无需显式 topic 切分:

1. topic 边界检测要额外模型判断,成本高、收益未验证;
2. 抽取器提示词要求「只抽 rules/lessons,禁止流水账/过程/代码/凭据」,天然跨 topic 过滤;
3. 同一事实被重复抽出,由 `remember` 的「rules 只增不减、重复 entry 拒绝」去重兜底。

若未来需要 topic 意识(按 topic 归档),作为独立步骤引入,不混入抽取器。

## 5. 抽取器(extractor):从会话判断并提取记忆

触发(§3)与窗口(§4)决定了「何时、抽什么范围」,但「判断是否值得记、提取成条目」由**抽取器**完成——§3 里的 `extract()` 就是这个角色,此前未展开,本节补齐。

### 5.1 来源不同 → 角色不同:抽取器不是 team 的召回/质检节点

记忆节点 team 现有两个职责,都面向**存量记忆文本**(已落盘的记忆):

- **召回节点**:输入 = 已存记忆 + query → 输出 = 相关条目;
- **review 节点**:输入 = 已存记忆 → 输出 = 缺陷发现(见 [memory-review.md](memory-review.md))。

抽取器面向**会话上下文**,输入完全不同:

- 输入 = `deriveMessages()`(主会话此刻上下文,§4);
- 输出 = 值得记的**新记忆候选条目**(尚未落盘)。

所以抽取器是**第三个职责**,不是给现有 team 节点加功能——来源不同(会话流 vs 存量记忆),角色必然不同。

### 5.2 按 memory-type 分两个抽取节点

是的——抽取器**按 memory-type 分两个节点**,各自负责一类记忆的判断与提取:

| 抽取节点 | 负责 type | 判断标准 | 后处理 |
|---|---|---|---|
| rules 抽取器 | `rules` | 用户偏好 / 习惯 / 格式 / 技术栈限制 / 共识 / 约束 | 只新增(重复 entry 拒绝) |
| lessons 抽取器 | `lessons` | 踩坑 / 环境限制 / API 变更 / bug 根因结论 | 判合并(同主题合并,≤300 字) |

为什么按 type 分、而非复用召回节点的容量分区:

1. **判断标准截然不同**:rules 是「用户想怎样」,lessons 是「什么会出错」。混在一个提示词里,模型要在两类判断间切换,两类都做不好。
2. **后处理不同**:对应 concept.md §5——rules 只增不减、lessons 偶尔合并。rules 抽取器输出即新增;lessons 抽取器还要判「与已有 lessons 是否同主题、是否合并」。
3. **分区维度本就不同**:召回 / review 按**容量**(600Kb)分区,因为存量记忆会增长;抽取器输入是**单会话窗口**(有界、随 compaction 收缩),固定 2 节点即可,不需要容量分区。

### 5.3 抽取节点构成与提示词

每个抽取节点 = 一次 `v4-flash` 调用 + 单一 type 的抽取提示词 + 结构化输出。

**rules 抽取器**(默认提示词,可经配置覆盖):

```
你是「用户偏好(rules)」抽取器。给定一段对话,找出用户明确表达或隐含的长期偏好、习惯、格式、技术栈限制、共识、约束。只输出值得长期记住的条目,一行一条,格式为「domain|scope|entry|entryPoint|references」,domain 从已知领域枚举中选最贴切的一个(如 DurablePrefs、CodeFacts、Style),scope 填这条记忆影响的具体子系统 / 模块(自由文本,如「全项目」「Web UI」),entry 填一句话条目(不含竖线 |),entryPoint 填这条记忆的来源文件路径(对话中出现的真实路径,如 src/index.ts),references 填相关参考文件路径;entryPoint / references 没有对应路径时填 -。没有值得记的输出空。禁止记录:操作流水账、思考过程、具体代码实现、密钥或凭据、易变的进度/待办。
```

**lessons 抽取器**(默认提示词,可经配置覆盖):

```
你是「经验教训(lessons)」抽取器。给定一段对话,找出踩过的坑、环境限制、API 变更、bug 根因结论。只输出值得长期记住的条目,一行一条,格式为「domain|scope|entry|entryPoint|references」,domain 从已知领域枚举中选最贴切的一个(如 PastFixes、PromotedPitfalls、CodeFacts),scope 填这条记忆影响的具体子系统 / 模块(自由文本,如「样本库」「检测评分」),entry 填一句话条目(不含竖线 |),单条不超过 300 字,entryPoint 填这条记忆的来源文件路径(对话中出现的真实路径,如 src/index.ts),references 填相关参考文件路径;entryPoint / references 没有对应路径时填 -。没有值得记的输出空。禁止记录:操作流水账、思考过程、具体代码实现、密钥或凭据。
```

### 5.4 成本分级:抽取 / 召回用 flash,review 才用 pro

| 职责 | 模型 | 频率 | 理由 |
|---|---|---|---|
| 抽取(extract) | `deepseek-v4-flash` | 高(每次触发) | 判断「有无偏好 / 教训」相对简单 |
| 召回(recall) | `deepseek-v4-flash` | 中 | 相关性匹配 |
| 质检(review) | `deepseek-v4-pro` | 低(slash 手动) | 找矛盾 / 重复需强推理 |

### 5.5 抽取 → 后处理 → 写盘:走共享存储层,不调工具

触发时 fan-out 到两个抽取节点(并行、互不干扰):

1. rules 抽取器输出 rules 候选 → 与已有 rules 比对去重(重复 entry 拒绝)→ 非空则 `store.append` 写盘;
2. lessons 抽取器输出 lessons 候选 → 与已有 lessons 判是否同主题合并(≤300 字)→ 合并或新增 → `store.append` / `store.update` 写盘。

**关键:抽取器不调用 `remember` 工具,而是调用共享存储层(store)。** 模型面工具(`remember` / `recall` / `forget`)与操作工具(`memory-find` / `memory-update` / `memory-delete`)都是**模型面契约**,而抽取器是**插件内部逻辑**——两者不在同一层,不应互相调用:

- **工具** = 模型调用入口:带 schema(模型提供哪些参数)+ description(模型何时调)+ 薄 handler(解析参数 → 调 store)。`scope`(影响范围,自由文本)与 `layer`(落点层,枚举)由**模型参数决定**。
- **抽取器** = 插件内部:输入是 v4-flash 的结构化输出(已经过抽取提示词约束),`layer` 由**会话推导**、`scope` 由**抽取器判断**(§5.6),不需要 schema / description。

正确分层是抽出一个共享的**存储层 store**,工具与抽取器都调它:

```
模型面工具(remember / memory-update / …)
      │  handler 调 store
      ▼
存储层 store(validate + dedup/merge + id + append/rewrite JSONL + render MD + update catalog)
      ▲
      │  抽取器调 store
抽取器节点(rules / lessons v4-flash)
```

**为什么不复用工具**:工具是模型面契约,其 `scope` 语义是「模型通过参数表达记忆的操作/影响边界」;抽取器的 `scope` 是「抽取器自行判断」(§5.6)。复用工具会把抽取器耦合到模型面的 schema 与默认 scope 逻辑,且抽取器根本用不到 recall / forget / find / delete 这些工具。

**为什么也不另维护一套写盘**:写盘的不变量(schema 校验、id 生成、catalog 更新、JSONL↔MD 一致、去重/合并规则)必须单一真相源。两套独立写路径必然漂移(校验规则、catalog 格式、去重逻辑各写一份,改一处漏一处)。

**对现有代码的落点**:`store` 不必是新 Cordis 服务——dsh-memory 是单插件,工具与抽取器同处一个插件内,一个纯模块 `store.ts`(与 schema.ts / render.ts / check.ts / team.ts 并列)即可承载。把现在工具 handler 里内联的「校验 + 追加 JSONL + 重渲染 MD」抽到 `store.ts` 暴露 `append` / `update` / `delete` / `find`,工具 handler 变薄、抽取器直接 import 调用。

### 5.6 scope(影响范围)与 layer(落点层)是两回事

`scope` 的权威定义在 **concept.md §2**:

> **scope = 操作或影响的边界**(广度、界限、权限),与 domain(知识或控制的区域)共同定位一条记忆——「一条记忆活动 = 信息(Domain)对现实的操作(Scope)」。domain 决定「关于什么」,scope 决定「在多大范围内生效」。

`scope` 的取值是**自由文本**(具体子系统 / 模块名,如「全项目」「Web UI」「Provider 接入」「样本库」),随项目变化,**不是** Global / User / Project 三层枚举——那三层是 `layer`(落点层)的取值(concept.md §8)。

`domain` 与 `scope` 是**语义定位的正交对,成对出现**(一条记忆同时有「关于什么领域」+「影响什么范围」),`layer` 是**存储元数据**,不参与定位:

| 维度 | 层次 | 语义 | 取值 | 抽取器如何定 |
|---|---|---|---|---|
| `domain` | 语义定位(正交对) | 知识/控制的区域(主题、类别) | 21 个 closed 枚举(concept.md §3) | 抽取器判断「关于什么」 |
| `scope` | 语义定位(正交对) | 操作/影响的边界(具体子系统 / 模块) | 自由文本 | 抽取器判断「作用于哪个子系统」 |
| `layer` | 存储元数据 | 落点层(写哪个目录) | global / user / project | 会话推导「写到哪」 |

**工具路径**(`remember`):模型提供 `scope`(影响范围,自由文本)+ `layer`(落点层,枚举),系统按 `layer` 映射落点(design.md §4「按 layer 决定写哪」)。

**抽取器路径**:`layer` 与 `scope` 分开确定:

- **`layer` 由会话推导**:记忆写到「会话所在的目录」。项目会话(cwd 经 `.git` 向上探测到项目根,与 team 预热 project-root 探测同源)→ `<repo>/.dsh/memory/`,layer = `project`;无项目 → `~/.dsh/memory/`,layer = `user`。global 层几乎不用(concept.md §8)。
- **`scope` 由抽取器判断**:判断「这条记忆影响哪个子系统 / 模块」,输出自由文本(如「全项目」「Web UI」)。它不是三层枚举,是与 domain 正交的影响范围。

其余(校验 / 去重 / id / catalog)完全共享 store,与工具路径一致。

## 6. 推荐与理由

**推荐形态 3(事件 + 计数器)**:

1. 纯计数器(形态 2)会「每 N 轮抽一次,哪怕全是流水账」——浪费且易误抽;纯信号词(形态 1)会漏。
2. 形态 3 用 agent 事件的语义做定向(出错→lesson、会话开始→回顾)、计数器做退火抑制高频,准确率/成本比最优。
3. 直接复用 §5 的抽取器(v4-flash 调用器)+ 共享存储层 store 写盘,不重写基础设施。

形态 3 只需一个冷却计数器(`turnsSinceLastExtract`)加若干 agent 事件监听,都轻,且可配置(见 §7)。

## 7. 新增配置项(存 `ctx.settings`,经 `/lmemory config set`)

| 配置项 | 默认 | 含义 |
|---|---|---|
| `autoExtract` | `true` | 是否启用自动提取(默认开,旁路观测主会话自动管理记忆) |
| `extractMode` | `event-counter` | 触发形态:`signal` / `counter` / `event-counter` |
| `extractInterval` | `5` | 相邻两次抽取的最小 turn 间隔:形态 2 作触发周期,形态 3 作退火冷却期(`cooldownTurns`) |
| `signalWords` | 见 §3 | 信号词集(逗号分隔,可自定义) |
| `extractRulesPrompt` | 见 §5.3 | rules 抽取器提示词模板 |
| `extractLessonsPrompt` | 见 §5.3 | lessons 抽取器提示词模板 |

> 两个抽取提示词模板见 §5.3;原「单一 `extractPrompt`」按 type 拆分为两个,分别驱动 rules / lessons 抽取节点。

> 三种触发形态均已接线(§10);`extractMode` 三枚举与 `signalWords` 可经 `/lmemory config set` 读写。

## 8. 架构约束(实现前必须想清)

自动抽取写记忆 = 一个潜在的 **model-visible 输入/输出**。

- dsh 铁律:**model-visible ⟺ logged**——任何进入模型请求的内容必须能从 session log 重建。
- **主动记忆**天然满足:模型调 `remember` 有 `tool/call`/`tool/result` 落 log。
- **自动提取**写的是**文件**(jsonl),不是 session log。若自动抽取的记忆要在**当前会话**就立刻注入 model context(system prompt 摘要),那么「抽取」这个动作本身也需落 log(或至少保证可回放),否则回放对不上。

**决策建议(v1)**:自动提取产生的记忆,**不在当前会话立即注入**——只写盘,下次会话才经 system prompt 摘要进入模型。这样规避「model-visible ⟺ logged」的复杂约束,把自动提取定位为「跨会话沉淀」,而非「本会话即时反馈」。若未来要「即时注入」,再补 log 事件。

## 9. 非目标 / 开放问题

- ❌ v1 不做「自动提取记忆即时注入当前会话」(见 §8)。
- ❌ 不做基于 embedding 的「该不该记」判断(先做信号词 + v4-flash 抽取)。
- ⏳ 抽取质量评估(误抽率/漏抽率)需要真实数据,留待启用后观察。
- ⏳ 计数器阈值、信号词集的最佳默认值,需在真实使用中调优。

## 10. 落地决策与已确认偏离

三种触发形态(§3)均已接线,`extractMode` 三枚举与 `signalWords` 可经 `/lmemory config set` 读写,放行判断(`extractEnabled`)按 `autoExtract && extractMode === <mode>` 分发到对应监听:

- `signal`:观测 `session/event` 的 `user/message` / `assistant/message`,命中信号词即抽(无退火);
- `counter`:观测 `session/event` 的 `turn/end`,计数到 `extractInterval` 触发;
- `event-counter`:agent 事件(`turn-stopping` / `error` / `session-start`)触发,计数器退火抑制高频。

以下两点是本实现相对本文档其余章节的**已确认偏离**,作为明确决策记录:

1. **lessons「同主题合并」降级为「按 entry 精确去重」**。§5.2 / §5.5 描述的「与已有 lessons 判是否同主题合并(≤300 字)→ 合并或新增(store.update)」未实现:lessons 候选先按 entry 文本与已有 lessons 精确比对去重(`filterNovel`),去重后的候选只走 `store.append` 新增,**不合并、不调 `store.update`**。同一主题的近似重复可能以不同 entry 文本并存;是否补同主题合并,留待真实数据验证后再定。

2. **`agent/session-start` 抽取在 fresh 会话基本是空操作**。§3 形态 3 给 session-start 的语义是「回顾上次会话未沉淀的尾部」,但 §4 钉死抽取输入 = `deriveMessages()`(主会话此刻上下文)——fresh 会话在 `agent/session-start` 触发时 `deriveMessages()` 为空,抽取只会以空 transcript 发出两次 v4-flash 调用并返回空,不写任何记忆;「回顾尾部」仅在 resume / compact 回放历史、`deriveMessages()` 非空时才有实际内容。实现保留该监听(冷却计数器随新会话归零,resume 场景受益),但**不承诺「回顾上次会话尾部」语义**。

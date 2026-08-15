# 概念文档:长期记忆(Long-Term Memory)

本文定义 dsh-memory 的领域模型:记忆记什么、怎么分类、怎么分层、怎么衰减、以什么格式落盘。它是「设计文档」的上游——先有领域模型,再有技术落地。

## 1. 定位

长期记忆是**跨会话持久化的、提炼过的语义事实**——不是整段历史会话,而是从会话里抽取的、值得长期保留的高价值信息。

与 `session-reference` 的边界(关键):

| 能力 | 记什么 | 粒度 |
|---|---|---|
| `session-reference`(dsh 已内置) | **整段历史会话快照**(有界引用) | 会话级、不提炼 |
| **dsh-memory(本插件)** | **提炼的语义事实**(偏好/教训/状态/待办) | 条目级、跨会话累积 |

一句话:session-reference 回答「上次那场会话说了什么」,长期记忆回答「**我该一直记住什么**」。

## 2. Scope vs Domain 框架

区分两个常被混淆的词,它们共同定位一条记忆:

| 方面 | Scope(范围/范畴) | Domain(领域/范畴) |
|---|---|---|
| 核心概念 | **操作或影响的边界** | **知识或控制的区域** |
| 关注点 | 广度、界限、权限 | 主题、类别、专业 |
| 比喻 | 手电筒照射的范围 | 一个特定的房间(房里东西是主题) |
| 常见语境 | 编程:变量作用域;项目:项目范围 | 编程:业务领域(DDD);数学:函数定义域 |

一条记忆活动 = **信息(Domain)对现实的操作(Scope)**。`domain` 决定「这是关于什么的记忆」,`scope` 决定「这条记忆在多大范围内生效」。

`domain` 与 `scope` 是**正交的两个定位维度,成对出现**——一条记忆总是同时具有「关于什么领域(domain)」和「影响什么范围(scope)」,二者缺一不可,共同定位这条记忆。

`scope` 的取值是**自由文本**(具体子系统 / 模块名,如「全项目」「Web UI」「Provider 接入」「样本库」),随项目变化,不做全局枚举;`domain` 才是 21 个 closed 枚举(见 §3)。

> **三者关系(结论)**:`domain` 与 `scope` 是**语义定位的正交对**,成对出现、共同定位一条记忆;`layer` 是**存储元数据**,只决定物理落点(Global / User / Project,见 §8),**不参与语义定位**。

## 3. 长期记忆的 Domain(知识领域清单)

记忆必须归入以下 domain 之一(closed 枚举,新 domain 需显式扩展)。`Domain(id)` 列是**机器可读的 id 形式**(camelCase,写入 JSONL 的 `domain` 字段与工具 `domain` 枚举):

| # | Domain(id) | 中文 | 例(记忆主题) |
|---|---|---|---|
| 1 | OutputContract | 输出契约 | 某接口的响应字段、必填项 |
| 2 | ToolGovernance | 工具作用域治理 | 某工具在什么作用域可用/禁用 |
| 3 | RedLines | 不可逆红线 | 绝不删除生产数据、绝不裸 `--force` |
| 4 | Invariants | 项目不变量 | 如 R1/R2/R3 这类不可违反的约定 |
| 5 | NamingBijection | 命名机械对应 | issue↔分支↔worktree 三者命名映射 |
| 6 | ContractConstants | 契约常量 | `TYPES=[feat,fix,...]`、`MAIN_BRANCH=main` |
| 7 | CommandsRuntime | 命令与运行时特性 | 某命令的 flag、某脚本的行为 |
| 8 | DirScoped | 目录级约定 | `issues/` 的存放规则 |
| 9 | PathScopedRules | 路径级硬约束 | 某文件必须在某路径、不得移动 |
| 10 | WorkflowSOP | 工作流工序 | 「先 commit 再切 worktree」这类顺序 |
| 11 | QualityGates | 门禁清单 | 提交前必跑的检查项 |
| 12 | RebuildSpec | 脚本重建规格 | 某脚本缺失时如何按职责重建 |
| 13 | ChangeSurface | 架构与跨层改造面 | 改某功能要动哪些跨层文件 |
| 14 | ADR | 决策与否决理由 | 某方案为何被采纳/否决 |
| 15 | DurablePrefs | 用户长期偏好 | 用户习惯的格式、技术栈限制 |
| 16 | Glossary | 术语表 | 项目里某术语的确切含义 |
| 17 | ExternalRefs | 外部资源 | 权威文档 URL、上游仓库 |
| 18 | PromotedPitfalls | 已知陷阱 | 踩过的坑、API 变更 |
| 19 | CodeFacts | 代码结构事实 | 某模块在哪、负责什么 |
| 20 | PastFixes | 历史修复过程 | 某 bug 的根因与修法结论 |
| 21 | Style | 风格/格式规范 | 命名、注释、提交格式约定 |

## 4. 长期记忆只含两类高价值信息(提取原则)

**长期记忆只持久化两类**;`state`/`todo` 是易变的会话级/短期数据,**不进长期记忆文件**。

| 类型 | 记什么 | 目的 |
|---|---|---|
| `rules`(偏好/共识/约束) | 用户明确的习惯、格式、技术栈限制、共识 | 防止偏离用户意图 |
| `lessons`(经验教训) | 踩过的坑、环境限制、API 变更 | 防止重犯同样的错 |

**反原则(禁止记)**:操作流水账、思考过程、具体代码实现、密钥/令牌/凭据、敏感路径。

`state`(宏观进度)与 `todo`(待办/阻塞)在概念上仍是「高价值信息」,但它们是**易变的短期上下文**,不属于「长期记忆」——由会话日志 / 其他机制承载,不写进 `.remember.*` 文件。

## 5. 时间衰减周期

| 类型 | 属性 | 维护策略 |
|---|---|---|
| `rules` | 冷数据/永久 | **只增不减,极少修改** |
| `lessons` | 温数据/经验库 | **偶尔合并**,保持不分散,单条入口 ≤300 字 |

## 6. 存储与渲染:JSONL 为真相源,MD 为投影

**存储真相源是 JSONL(`.remember.jsonl`),Markdown(`.remember.md`)只是渲染投影**,两者一一对应、同 basename 配对。

| 文件 | 角色 | 谁读写 |
|---|---|---|
| `.remember.jsonl` | **真相源**:一行一条记忆,schema 可校验 | 插件(读写);人可看(可选) |
| `.remember.md` | **渲染投影**:8 列 Markdown 表格 | 插件生成(纯函数渲染);人/agent 阅读 |

为什么 JSONL 为真相源:

- 每行是独立 JSON 对象,可逐行做 schema 校验(契合「方便 schema 校验」);
- 追加/删除/合并 = 改 jsonl 行,**不解析 Markdown**(避免手写 md 表格解析器的脆弱性);
- MD 是「只生成、不解析」的投影——渲染后做一次 Markdown 语法静态检查,保证人读安全。

**JSONL 记录 schema**(一行一条):

```json
{"id":"m-3k9f2x8q1a","type":"rules","domain":"DurablePrefs","scope":"全项目","layer":"user","entry":"提交信息用 Conventional Commits","entryPoint":"-","references":"<repo_root>/CLAUDE.md"}
```

字段与 8 列一一对应:`id` / `type` / `domain` / `scope` / `layer` / `entry` / `entryPoint` / `references`。其中 `id` 是全局唯一编号(见 [memory-review.md](memory-review.md) §2),`domain` 与 `scope` 是**语义定位的正交对**(共同定位一条记忆),`layer` 是**存储元数据**(不参与语义定位)。

**MD 渲染**(纯函数,由 jsonl 派生,8 列):

```markdown
| id | 类型 | 所属知识领域 (domain) | 影响范围 (Scope) | Layer (落点层) | 条目 | entry point (file path) | references (file path) |
|---|---|---|---|---|---|---|---|
| m-3k9f2x8q1a | rules | DurablePrefs | 全项目 | user | 提交信息用 Conventional Commits | - | <repo_root>/CLAUDE.md |
```

渲染后必须通过 **Markdown 语法静态检查**(表格列数一致、无未闭合管道、`entry` 内的 `|` 已转义)。

## 7. 命名规范

```
memory/YYYY-MM-DD[.<partition>].<memory_type>.remember.{jsonl|md}
```

- `YYYY-MM-DD`:写入日期(按天分文件)。
- `<memory_type>`:**强制**,就是 `rules` 或 `lessons` 二者之一。**不是** layer(Global/User/Project)、**不是** domain(21 类)——type 维度和 scope/domain/layer 是正交的独立字段,不要在文件名里混用。
- `<partition>`:**可选**自由前缀(kebab-case),用于把同类记忆拆成多个文件分片(单个文件不宜无限大)。它是自由分片标识,不是 scope/domain/layer 枚举。
- 每个 `.remember.md` 必有同名 `.remember.jsonl`,一一对应。

示例:
- `memory/2026-08-13.rules.remember.jsonl` + `.md`(无分区)
- `memory/2026-08-13.user.rules.remember.jsonl` + `.md`(partition = `user`,仅作分片标识,与 scope / layer 字段无关)

## 8. Layer 分层(落点层:Global / User / Project)

记忆按**落点层(layer)**分三层物理存储,目录发现时按「就近覆盖」。这是 layer(物理存储位置),**不是** scope(影响范围)——scope 见 §2,是「操作或影响的边界(具体子系统 / 模块)」。

| 层(layer) | 落点 | 含义 |
|---|---|---|
| Global | 全局 | 跨所有项目生效(几乎不用) |
| User | `~/.dsh/lmemory/` 或 `~/.agents/lmemory/` | 用户级,跨项目 |
| Project | `<repo>/.dsh/lmemory/` 或 `<repo>/.agents/lmemory/` | 项目级,单仓库 |

写入 JSONL 的 `layer` 字段与工具 `layer` 枚举取**小写 id**:`global` / `user` / `project`(上表首字母大写仅为概念名)。

## 9. 召回:多 v4-flash 记忆节点 team

召回不用单次全文检索,而是用**多个 `deepseek-v4-flash` 记忆节点组成 team**。

### 记忆节点(node)

- 每个节点 = 一次 `v4-flash` 模型调用器 + **它负责的记忆文本**(≤ 600Kb,可配置,见 §10)。
- 一个节点可**装载多个记忆文件**:文件按命名(日期/分区/类型)分配到节点,直到累计接近容量上限为止。
- 节点数量随总记忆大小动态调整 = `ceil(总大小 / 每节点容量)`。

### 预热(warm-up)

**预热 = 提前把 `llm` 调用器 + 记忆文件内容 组装成一个「就绪的节点 team」**,而不仅是读文件进内存。

- 预热完成后,team 是「可立即 fan-out」的状态:节点、分配关系、模型绑定都已就位。
- 只要不退出程序(且 team 未被 stop),后续每次 recall 直接 fan-out 到已就绪的 team,**不再等待组装 / 不再重读磁盘**。
- 预热可手动触发(slash command),也可在插件启动时自动执行。

### 召回流程

1. **fan-out**:recall 把 query 并发派给 team 里的每个节点;每节点在其负责的记忆文本上挑出相关条目,返回候选项。
2. **聚合(aggregate)**:汇总各节点候选 → 去重(按 entry 精确匹配)→ 按相关度排序(重排序提示词可配置,见 §10)→ 返回最终结果。

## 10. 可配置项(经 slash command 设置)

| 配置项 | 默认 | 含义 |
|---|---|---|
| `maxNodeKb` | `600`(单位 Kb) | 每个 v4-flash 记忆节点最多负责的记忆文本大小 |
| `recallTopK` | 待定 | recall 返回的最大条目数 |
| `rerankPrompt` | 待定 | 聚合阶段重排序候选的提示词模板 |
| `warmupOnStart` | `true` | 插件启动时是否自动预热 team |

> 配置项是「设计起点的合理集」,开发时可按需增删(如召回模型、节点并发度等)。存 `ctx.settings`,slash command 读写。

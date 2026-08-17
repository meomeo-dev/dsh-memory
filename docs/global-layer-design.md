# Global 记忆层设计(global-layer)

本文档把 global 层从「几乎不用」的占位概念落地为**门禁写入、专用 team 泛型、独立存储、最小注入**的一等公民。范围:global 的入口与抽取/评审 team、存储位置与 catalog 维护、注入语义改造、shared 层评估、两条提升路径、WEB 导入导出。

> 本稿为 v2(修订稿):三份交叉 review(存储/数据契约、注入/workspace、team 泛型/门禁)的结论已并入。三份 review 一致判定方向正确、需修订后采纳;修订要点在文中以「修订」标注。

## 1. 背景与现状问题

现状(concept.md §8):global 层「几乎不用」——没有独立的 global 目录(global 写入与 user 同落 `~/.dsh/lmemory/`,writeRootFor 对非 project 层一律落 user 根)、没有面向 global 的入口或 team、`remember` 工具的 layer 枚举虽含 global 但模型写 global 无任何门槛。因此 user 根 jsonl 里**可能存在 layer=global 与 layer=user 混行的存量条目**。同时注入是全量的:system prompt 的 `memory:summary` 把 cwd 可见的**全部**条目(内置 + 用户 + 项目)注入提示词。

由此产生五个问题:

1. **global 无路可达**:没有「提供文档 → 抽取为 global」的入口(WEB / slash command 都没有),也没有把 user/project 记忆提升为 global 的路径。
2. **team 无泛型隔离**:recall / review / extract 节点把三层记忆混合喂给模型——review 节点会拿 project 记忆的上下文去判断 user 记忆,反之亦然,产生跨层误判。
3. **注入过载且混层**:全量注入把 project 记忆带进任何会话的上下文,随项目数增长上下文成本线性上涨;且不同项目的记忆在各自会话里交叉可见,语义上是错的。
4. **global 无导入导出**:无版本校验、无「是否为真实 global 导出」的来源确认,导入错误记忆(如把某项目导出包当 global 导入)没有防线。
5. **跨项目共享无落点**:dsh-memory / dsh-voice / dsh-voice-tts 等插件开发的共同经验,现在要么复制进每个项目,要么淹没在 user 层——缺少「从 project 提升到跨项目」的机制。

## 2. 用户故事

1. 作为用户,我想把一个文档(WEB 上传或 `/lmemory global extract <file>`)交给 global 抽取泛型小队,它只懂 global 记忆的标准,返回 0..g 条**经过充分评估**的 global 条目(不会太小/太局限/易变/无跨项目通用性),而不是把文档里的细节流水账全搬进来。
2. 作为用户,我想让 global 评审泛型小队只看见 global 记忆、只评审 global 记忆——不混入 project/user,避免跨层误判。
3. 作为用户,我想让提升评审泛型小队严格评估当前全部 user/project 记忆,从中总结并创建 global 条目,门槛与故事 1 相同。
4. 作为用户,每次会话的提示词**默认只注入 global 条目全文**,另附两行统计:user 记忆共 N 条(按 domain 分组)、当前工作区 project 记忆共 M 条(按 domain 分组)——具体条目由模型按需用 recall 工具取,不再全量注入。
5. 作为用户,一个工作区只能看到属于自己的 project 记忆:写 project 记忆时记录的 workspace 路径与 catalog 收集的路径必须一致,匹配时正确处理相对路径与 symlink。
6. 作为用户,WEB 上可以导出/导入 global 记忆;导入必须校验数据版本、并确认文件是「真实的 global 导出」(来源标记 + schema 校验),否则拒绝,不污染 global 层。

## 3. 设计总览:三条不变式

> **G1(门禁写入)**:global 层**只**由四个 gated 路径写入——extract<global-type1>(§7.2)、review<global-type2>(§7.3)、global 导入(§9.3)、存量迁移(§5.4)。`remember` 工具的 layer 参数收缩为 user/project(模型不再能直接写 global);`memory-find` 的 layer 过滤保留三层(global 条目必须可被按层查到)。**任何候选条目必须过 global gate(§7.1)才落盘——导入路径同样不得豁免(§9.3 步骤 3.5)**。
>
> **G2(泛型隔离)**:三个新 team 泛型的节点输入**只来自声明的作用域**——global team 只见 global 目录条目;提升评审只见 user/project 条目;抽取只见用户提供的文档。隔离在**源拼装层**实现(给哪个目录/哪段文本),不靠提示词自律。
>
> **G3(注入最小化)**:system prompt 只注入 global 全文 + user/project 统计摘要;其余条目经 recall 工具按需获取。范围可配置(`summaryMode`,默认 `'global'`,可设 `'all'` 恢复旧行为)。

## 4. 议题 1:global 的入口与 extract<global-type1>

### 4.1 入口(两个,同一条写入路径)

**命令面统一为三个子命令**(command.ts 是封闭 discriminated union,USAGE / COMMAND_HELPS 同步):

- `/lmemory global extract <file> [--dry-run]` —— 读本地文件文本,交给 extract<global-type1> 小队,回显 0..g 条候选 + gate 结论;`--dry-run` 只回显不写盘,缺省确认后写盘(CLI 交互确认)。
- `/lmemory global promote [--confirm]` —— review<global-type2> 提升评审(§7.3);先回显预估节点数与预计成本,`--confirm` 才执行。
- `/lmemory global review` —— review<global-type1> 质检(§8),报告注入主会话(复用现有 review 报告形态)。

**WEB**:新增 `/memory/global` 页(RPC `global-extract` / `global-promote` / `global-review` / `global-import` / `global-export` / `global-entries` 六端点)。文件经浏览器 `FileReader.readAsText` 读为文本**直传**(不 base64——现有 RPC 载荷全是 schemastery string 小对象,text 直传更贴合;v1 只支持文本类文档);**服务端按 `Buffer.byteLength ≤ 1 MiB` 硬校验**(token 门不能代替上限校验),超限 `bad-request`。CLI 文件读取同受 1 MiB 上限。

### 4.2 extract<global-type1> 泛型(形态)

- **输入**:用户文档文本。**新增纯函数 `chunkDocument(text, maxChars)` 把文档预切成多个 MemorySource**(按字符数、约 maxNodeKb 一个,切块边界规则单测锁定)——修订:team.ts 的 `partitionNodes` 是**打包器不是切分器**(超容量单源独占一个节点、绝不切分,team.ts:62-87),1 MiB 文档不能作为单 source 直接喂 v4-flash。
- **节点与类型**:切块后每个容量节点 fan-out **rules / lessons 两型各一次**调用(沿用 extractBoth 的 per-type 双节点形态);调用数 = 容量节点数 × 2。候选行格式在现有五段前**补 type 列**:`type|domain|scope|entry|entryPoint|references|verdict: pass/reject|理由`(MemoryEntry 必填 type,gate 也要求 type 合法——修订:原草案漏了 type 列)。
- **知识**:节点 system prompt 只含 global 准入标准(§7.1 gate)与 global 记忆格式;可选附**现有 global 条目清单**(用于去重与风格一致)——**绝不**混入 user/project 条目。
- **verdict 解析**:**新增纯函数 `parseGlobalCandidates(text)`**(verdict 感知)——现有 `parseExtraction` 只解构前 5 段并静默丢弃多余段(extract.ts:87-108),不能复用;新函数解析 7 段、校验 verdict 枚举、只返回 pass 候选(或带 verdict 字段供回显),reject 绝不落盘。理由字段在 prompt 层约束「不含 `|`」(与 entry 同约束)。
- **写盘**:pass 候选 → 与现有 global 条目按 entry 精确去重 → 全量 schema 校验 → store.append(global 根)→ 更新 global catalog。WEB「确认写盘」载荷 = 候选行数组 + acToken,**服务端对每条候选重跑 §7.1 确定性 gate + schema 校验后才 append**——客户端 verdict 仅供回显,确认不绕过 gate(修订)。

## 5. 议题 2:global 存储位置与 catalog 维护

### 5.1 存储路径

`~/.dsh/lmemory/global/` —— 用户 dsh 根内的**子目录**。决策理由:

1. **发现层自然隔离**:`loadDir` 只读顶层 `*.remember.jsonl`、不递归——global 子目录自动被现有 user/project 发现链排除,零改动即可避免「global 条目被当作 user 条目重复读到」(review 已验证成立)。
2. **catalog 就近**:每个 lmemory 目录一份 `catalog.json`,global 子目录独立持有一份,`rebuild` 作用域就是该子目录,与现有机制同构。
3. **单一真相源**:global 只在 dsh home 落一份(agents home 不设 global 目录)——global 是 host 级概念,双目录 + basename 覆盖合并只会带来歧义;写入根解析新增 `global: join(dshHome(), 'lmemory', 'global')`。
4. **文件命名不变**:仍用 `YYYY-MM-DD[.<partition>].<type>.remember.{jsonl,md}`,id 随机 `m-` 前缀。

### 5.2 发现、召回与各消费方(修订)

新增 `discoverGlobalEntries()` / `visibleGlobalDir()`。global 目录**不进 visibleMemoryDirs 合并链**(保持 §5.1 的隔离),而是按消费方逐一追加:

| 消费方 | 现状来源 | global 改造 |
|---|---|---|
| `sourcesFor`(recall team 节点文本) | discoverFiles(cwd) | **追加 global 目录文件**(global 条目可被 recall/query 取到) |
| `resolveRecalled`(召回逆查) | discoverFiles(cwd) | **追加 global 目录条目**——否则 global 召回行全部降级为 `file/layer/entryPoint = '-'`(修订:逆查盲区会让「recall 返回完整 global 条目」失效,必须同步) |
| `renderMemorySummary`(注入) | 新函数(§6.1) | 自读 global 目录 + user/project 统计 |
| `/lmemory stats` | discoverEntries(cwd) | 追加 global 目录条目(byLayer.global 计 global 目录) |
| 面板 stats(host 视图) | computeStatsIn(hostMemoryDirs) | hostMemoryDirs 追加 global 目录 |
| `doReview`(现有 user/project 质检) | discoverEntries(cwd) | **不追加**(现有 review 保持 user/project 域;global 质检走 review<global-type1>) |
| 自动提取 | 写 user/project | 不变(自动提取不写 global) |

合并语义:global 平面与 user/project 平面**不做 basename 覆盖合并**(不同平面,各自独立;读侧按 id 去重已有)。

### 5.3 catalog / registry / 写链维护(修订)

- **catalog**:global 目录自带 `catalog.json`;`store.rebuild` 增加 `dirs` 显式入参,`/lmemory catalog rebuild` 解析器新增 `--root`。**默认 rebuild 只重建 cwd 可见的 user/project 层、不触碰 global 目录;`--root ~/.dsh/lmemory/global` 只重建 global 目录**——两侧作用域单测锁定(修订:原 AC「rebuild 不触碰 global 以外的层」歧义,已改)。
- **registry**:`fixedRoots()` 增 `<dsh>/lmemory/global`(沿用「存在才登记」,global 目录在首次写入前不出现在目录页);`registerExplicitRoot` 的 kind 判定加 global 分支(路径恰为 global 根即 'global',否则显式 add 会误判 project);kind 枚举扩为 `'user' | 'project' | 'global'`。**版本策略:formatVersion 保持 1**——结构未变仅 kind 加值;降级行为声明:旧版 dsh-memory 读新 registry.json 会静默丢弃 kind='global' 的根并在其下一次 refresh 时抹除登记,**数据本身(global 目录)不受影响**,新版重新 refresh 自动重登记;该行为与 parseRegistry「未知 kind 跳过」的既有契约一致,记录为已接受(修订)。
- **写链与并发**:global 写盘走同一条 store.append 写链,但两点声明:① store.append 的 **rules duplicate 兜底不覆盖 global 目录**(其去重走 visibleMemoryDirs 可见链)——三条 gated 路径的 entry 精确去重是**唯一**兜底,且必须对 rules/lessons **都**做(现有 filterNovel 只在 lessons 路径使用;§7.2/§7.3 写死);② **跨层逐字相同不视为重复**:global 允许与 user/project 存在同文条目(提升路径要求总结提炼,通常不会逐字相同;但 gate 不因此拒绝)。③ 原子性:global 层继承 store 的读-改-写语义,多会话并发 append 存在最后写赢的丢更新窗口(与 user/project 现状一致);v1 接受(写盘低频、窗口窄),可选加固 = writeFilePair/catalog 改 tmp+rename(registry/runtime-status 已有先例)。
- **写根解析**:`writeRootFor(cwd, layer)` 的 cwd 参数改为**可选**:layer=global 时不需要 cwd(global 根与 cwd 无关),global 写盘的去重域固定为 global 目录,不随调用方 cwd 变化(修订:WEB RPC 无会话 cwd,现状签名要求 cwd 是 host 级写入的障碍)。

### 5.4 存量 global 条目迁移(修订,三份 review 一致指出)

**新增一次性迁移 `migrateLegacyGlobalEntries()`,幂等,与 migrateLegacyMemoryDirs 同构**:扫描 dsh/agents 两个用户根的顶层 `*.remember.jsonl`,把 `layer === 'global'` 的行移入 global 目录(按原 type 沿用当天文件名或归入 `YYYY-MM-DD.<type>.remember.jsonl`),源文件重写为不含这些行的集合,随后重写两侧 catalog;迁移报告与 migrateLegacyMemoryDirs 同口径打印。在 visibleMemoryDirs / memoryWriteRoots 咽喉处调用(报告丢弃,启动期显式调用一次)。

迁移完成后「layer=global 的条目」与「global 目录的条目」恢复同一集合——去重/导出/评审/注入的视图不再分裂。AC:迁移后 user 根 jsonl 中不再存在 layer=global 行(单测)。

## 6. 议题 3:注入语义与 workspace 匹配

### 6.1 注入改造(system prompt)

**新增纯函数 `renderMemorySummary(entries, mode, maxInject)` 承载三段式输出;`renderSummary` 保持不动**(供 summaryMode='all' 旧行为与兼容——render.spec.ts 精确锁定其输出,不能改;修订)。输出模板(确定性,可单测锁定):

```
- [rules] <global 条目 1 全文>
- [lessons] <global 条目 2 全文>
（用户记忆 N 条:DurablePrefs ×12,Style ×9,…按 domain 计数降序、全部 domain 列出）
（当前工作区 project 记忆 M 条:DurablePrefs ×3,…同上）
```

- **global 全文**:`discoverGlobalEntries()` 按 layer=global 过滤,**在注入渲染层**按 createdAt 降序稳定排序(createdAt 相同按 id 升序定序——append 同批条目 createdAt 相同,次级键保证确定性),截断 `GLOBAL_INJECT_MAX = 30`,并注明「更早的 global 记忆经 recall 获取」。
- **user 统计** = 两个固定用户根经**与召回相同的 basename 合并语义**(同名文件 dsh 覆盖 agents)后的条目计数按 domain 分组——计数与 recall 可见面严格同源(修订:原「两固定根分别计数」会多计被覆盖文件)。
- **project 统计** = 当前会话 cwd → canonical workspace 根(§6.2)的项目目录计数按 domain 分组。计数是文件读、每次 assemble 现算——**现状注入本已每 turn 全盘读,本次只增加内存中的 domain 分组,不新增读盘**;若会话高频下读盘成为瓶颈,可加进程级写版本计数缓存(store 写入口递增 `storeVersion`,summary 按 `(canonicalCwd, storeVersion)` memoize)。注意:global 经 gated 路径写入后,recall 可见性受 recall team 预热缓存生命周期约束(直到 stop/restart 才重读盘)——与现状对 user/project 一致,非本次引入,声明即可。
- **退化规则**:global 0 条时只输出统计行;cwd 不可得时省略 project 统计行;全部为 0 时输出空串(沿用现状「空集返回空串」,由调用方省略 section)。
- **builtin 层**:在 summaryMode='global' 下不注入全文、不计入统计,仅经 recall 可达——与现状一致(内置层当前为空);种子目录非空时再评估。
- **summaryMode 配置键落地(修订:五处联动 + 测试锁)**:`summaryMode: z.union([z.literal('global'), z.literal('all')]).default('global')`;仿 EXTRACT_MODES 建 `SUMMARY_MODES` const 元组;改动面 = SCHEMA + DEFAULT_CONFIG + CONFIG_KEYS + coerceConfigValue(enum 校验)+ PANEL_CONFIG_META(`{ kind: 'enum', options: SUMMARY_MODES }`,SettingsPage key 驱动自动渲染)+ **tests/web-ui.spec.ts 两处「13 键」断言(158/229)与 ui.ts/SettingsPage/web-panel.md 的「13」文案一并更新为 14**。
- **summaryChars 三处口径(修订)**:runtime 状态快照(index.ts:327)、`/lmemory stats`(index.ts:616)、面板 dashboard(index.ts:789)的「system-prompt summary」体积统计**与注入同函数、同 summaryMode**——否则展示体积与实际注入不符。

### 6.2 workspace 匹配(project 记忆的归属)

1. **canonical root**:新增 `canonicalProjectRoot(cwd) = realpathSync(findProjectRoot(cwd))`(try/catch,路径已消失时回退词法路径)。**替换面(修订:列全调用点)**:`rootFor`(team 缓存键)、`memoryWriteRoots` / `visibleMemoryDirs`(读写发现)、`refreshRegistry`(登记)、`registerExplicitRoot`(手动登记,防 symlink 路径产生重复根)、deriveLayer(布尔判定,同步替换保持单一函数)。附带收益:symlink 进入同一项目的「双 warm team」现存问题一并修复。**固定用户根豁免 realpath**(避免 macOS `/tmp → /private/tmp` 与 DSH_HOME symlink 的连带变更)。
2. **registry 存量根 canonical 化(修订:去重算法)**:refresh 时对每个存量 root 尝试 `realpathSync(root)` 建 canonical→entry 映射;新 canonical 根命中映射时**合并**——root 字段改写为 canonical 路径、firstSeenAt 取最早、更新 lastSeenAt/计数;未命中且磁盘已消失的根不做 realpath(保持最后已知路径)。**防止同一物理项目经 symlink 与真实路径各登记一次造成导出/统计双计**。
3. **写时记录**:store.append 写 project 时,目录本身(绝对路径)就是 workspace 身份;registry 登记同一 canonical 路径。**catalog 不额外存 workspace 字段**——目录即身份,两处来源天然一致。
4. **worktree 语义**:worktree 的 `.git` 是文件、主仓 `.git` 是目录,`findProjectRoot`(existsSync)对两者都能命中 → **每个 worktree 是独立 workspace**(project 记忆按 worktree 隔离)。v1 保守语义,不实现 git common dir 探测(review 已验证与代码行为一致)。
5. **相对路径**:`entryPoint` / `references` 允许相对路径,语义 = **相对该 workspace 根解释**;读侧展示原样,面板表头/CLI 文案加「相对 workspace 根」注记(进 AC)。写侧不校验其存在性。抽取与 global gate 的 prompt 措辞改为「相对 workspace 根的相对路径或绝对路径」——否则模型几乎只会产出绝对路径(修订)。

## 7. 议题 5:两条提升路径与 global gate

### 7.1 global gate(准入标准,抽取 / 提升 / 导入共用)

**gate 常量与 verdict 解析统一放新纯模块 `global-gate.ts`**(类比 pricing.ts/team.ts 的纯逻辑模块;各常量加 JSDoc 引用 MIN_TRANSCRIPT_CHARS 先例说明「哨兵值而非调优旋钮,故为常量而非配置项」)。一条候选必须**同时**满足:

| 标准 | 判据(提示词内嵌 + 代码确定性检查) |
|---|---|
| 跨项目/跨人通用性 | 事实不绑定单一项目实现细节;换个项目/换个人仍有指导意义(提示词判据) |
| 低易变性 | 不是进度、待办、临时状态、本次会话的流水账(提示词判据) |
| 大小适度 | `MIN_GLOBAL_ENTRY_CHARS = 20` ≤ entry 长度 ≤ `MAX_LESSON_CHARS`(复用 schema.ts 常量,不另定义避免双处漂移;代码硬查) |
| 无机密 | 不含密钥/凭据/身份隐私(global 抽取 prompt 内嵌与现有抽取 prompt 同文的禁止清单;如有需要先把该清单提取为共享常量供三处引用) |
| 类型合法 | type ∈ rules/lessons、domain ∈ 21 枚举、scope 非空(schema 校验兜底) |

不满足 → 拒绝并给出理由(verdict 行)。pass 候选**按稳定序(节点顺序 → 行出现顺序)取前 g**(g = 单次提升上限 `GLOBAL_PROMOTE_MAX = 10`),不引入模型自评质量排序(修订:verdict 只判 pass/reject,不排序);超出部分回显「再运行可取更多」。

### 7.2 提升路径 5.1:文档 → global(extract<global-type1>)

流程:`文档文本 → chunkDocument 切块 → fan-out 抽取(rules/lessons 两型 × 容量节点,每节点独立 verdict)→ parseGlobalCandidates 汇总 → 跨节点按 entry 去重(rules/lessons 都去重)→ §7.1 确定性 gate 硬查 → store.append(global 根)→ catalog 更新 → 回显`。0 条是合法结果(文档无可提升内容),回显原因。

### 7.3 提升路径 5.2:user/project → global(review<global-type2>)

流程:`扫描全部 user + 全部已登记 project 根的条目(host 级,registry 口径)→ 按容量分区(v4-pro 节点)→ 每节点严格评估并给出 0..n 条 global 候选(带 verdict)→ parseGlobalCandidates 汇总 → 跨节点去重 → §7.1 gate 硬查 → append → 回显`。

- **成本预估(修订)**:新增纯函数 `estimatePromoteCost(table, nodeCount, maxNodeKb, ts)`——输入侧按 `nodes × maxNodeKb × chars/4` 经 estimateTokens 估,输出侧按「每节点 ≤ GLOBAL_PROMOTE_MAX 条 × ~150 字符」假设估,逐节点用 costFor 计价(提升用 config.reviewModel = v4-pro,与 usage 行 label 回退语义一致)。**`estimateWindowCosts` 是对已发生 usage 行的聚合,不能复用**(修订);假设在文档与函数 JSDoc 写明。执行前回显节点数与预计成本,`--confirm` / WEB「确认」后才发调用(AC:未确认不发调用)。
- **候选不是原条目拷贝**:prompt 要求**总结提炼**成 global 口径(通用化、去项目细节),entry 与原条目不要求逐字相同。
- **源条目不动**:提升**不删除、不改写** user/project 条目(只读 + 新增 global)。

## 8. 议题 6:三个新泛型 team

| 泛型 | 角色 | 模型 | 输入源(隔离面) | 输出 |
|---|---|---|---|---|
| extract<global-type1> | global 抽取 | v4-flash | 用户文档(chunkDocument 切块)+ 可选现有 global 清单 | 0..g 条带 verdict 的 global 候选 |
| review<global-type1> | global 质检 | v4-pro | **仅** global 目录条目 | 四类缺陷发现(复用 review.ts 结构) |
| review<global-type2> | 提升评审 | v4-pro | **仅** user/project 条目(host 级,registry 口径) | 0..g 条带 verdict 的 global 候选(总结提炼) |

**复用与新增的分界(修订:原「只新增源拼装与 prompt 常量」被代码证伪)**:review<global-type1> **零改动复用 review.ts**(runReview/reviewTeam/parseFindings 全部按 entries 注入,隔离 = 传入 global 目录 entries)——三份 review 中唯一完全成立的复用声称。review<global-type2> **不是 review.ts 的调用方**(review.ts 输出是 ReviewFinding 缺陷结构,与候选输出不相干);它复用 warmUp/partitionNodes 的 fan-out 容错模式 + parseGlobalCandidates,并**新增候选聚合编排函数**(跨节点按 entry 去重 + verdict 过滤 + 稳定序取前 g)。完整新增清单:**三个源拼装函数 + 候选聚合编排 + chunkDocument(文档切块)+ parseGlobalCandidates(verdict 解析)+ global-gate.ts + prompt 常量**。

- **运行时生命周期**:三个 team 按需创建(懒加载,用完即弃,不常驻)——提升与质检是低频命令,不像 recall team 需要预热缓存。
- **状态键与口径(修订)**:不新增 NodeStatusKey / usage label——新 label 会牵动 usage-log 白名单、聚合桶、pricing label 循环、dashboard DTO 与面板「review (质检)」文案全套连锁。**口径声明:提升评审按 label='review' 计数、global 抽取按 label='extract' 计数**——成本面板的 review/extract 行、节点页对应行将包含这些泛型的调用与成本(模型回退语义一致,v4-pro/v4-flash,金额口径正确);面板「review (质检)」行文案会包含提升评审的花费,记录为已接受的 UI 标签近似。泛型标识不进 UI。
- **G2 的测试面**:单测锁定「sources 函数返回的条目全来自声明目录」+「system prompt 不含其他层内容」——隔离是代码拼装保证的,不是提示词声明。

## 9. WEB:global 页与导入导出

### 9.1 global 页(`/memory/global`,第 6 个面板页)

- 顶部:global 条目列表(只读;`global-entries` 端点,复用 entries 视图 + layer=global 过滤)。
- 动作区:① 文档上传 → 抽取(显示候选 + verdict,「确认写盘」,服务端重跑 gate);② 提升评审(先显示预估成本,「确认执行」);③ global 质检(运行 review<global-type1>,显示缺陷报告);④ 导出/导入。
- RPC 六端点全部经现有 token + loopback 栅栏;handlePanelRpc 的封闭 switch 扩展。

### 9.2 导出格式(版本 + 来源标记)

```json
{
  "kind": "dsh-memory-global-export",
  "formatVersion": 1,
  "exportedAt": 1786800000000,
  "source": "dsh-memory",
  "entries": [ { /* 完整 MemoryEntry 字段(10 字段,含 schemaVersion/id/createdAt/layer=global) */ } ]
}
```

- **与 `collections export` 的分叉声明(修订)**:collections 导出是「jsonl+md 直拷 + manifest」(面向备份/迁移,不做逐条校验);global 导出采用**单文件 JSON 包**——可携带 kind 来源标记与逐条 layer 确认,是「导入防线的第一道门」。两者 formatVersion 独立演进,kind 字段先行区分(§9.3 步骤 1 先查 kind,能把 collections manifest 拦在第一道,顺序不可调换)。

### 9.3 导入校验(防线顺序)

1. `kind === 'dsh-memory-global-export'`,否则拒绝:「不是真实的 global 导出(不是 dsh-memory global 导出包)」;
2. `formatVersion === 1`(不支持的高版本拒绝并提示升级;未知低版本拒绝);
3. 逐条 **migrateRecord**(旧 schemaVersion 自动迁移补全,与读盘同一条链——不是裸 validateEntry;修订),校验失败计入 `skipped` 并列原因,不静默丢弃;
3.5. **通过 schema 的条目再过 §7.1 确定性 gate 硬查**(MIN/MAX 长度、type/domain/scope;导入是四个 gated 路径之一,G1 不得豁免——修订);
4. 强制 `layer = global`(字段缺失或非 global → 拒绝该条,计 skipped);
5. 去重**两轮**:先在导入批内按 entry 精确去重,再与现有 global 条目按 entry 精确去重(重复均计 duplicates;修订);
6. **写盘新增 `appendImported(globalRoot, entries)`,保留原 id/createdAt/schemaVersion,不走 store.append 的 id/createdAt 生成**(修订:append 无条件重生成 id 与 `createdAt: Date.now()`,round-trip 保真与 §6.1 的 createdAt 截断语义都会被摧毁);id 与现有 global catalog 冲突(同 id 异 entry)→ 计 duplicates 并跳过(或重新生成 id,二选一,实现时定死);同 id 同 entry → duplicates;未冲突 → 原样追加并渲染 MD;
7. 返回 `{ imported, skipped, duplicates, errors[] }`。

## 10. 议题 4:shared 层评估(结论:不做)

**评估**:shared 的候选语义 = 「选中项目组共享」,介于 user(全用户共享)与 project(单仓)之间。引入它需要:项目组注册表、独立存储目录、组感知的发现/注入/team、再加一组导入导出与门禁。

**结论:v1 不加**。理由:

1. **提升路径已覆盖核心诉求**:dsh-memory/dsh-voice/dsh-voice-tts 的插件开发共同经验,经 5.2 提升为 global 后,就在所有会话可见(注入默认就是 global),且 global gate 恰好过滤「跨项目才值得记」的内容——shared 在 global 已可用的前提下只是「更细的可见性分组」。
2. **global 即用户级**:本系统的 global 语义是「用户 host 内跨项目」,不是「全世界共享」。跨项目共享的粒度诉求用「domain 分组统计 + recall 按需取」即可缓解。
3. **触发条件(将来何时重开)**:① global 条目出现大量「只对某一组项目有意义」的内容,domain 分组无法缓解;② 用户明确要求组级可见性;③ 出现「同一事实在多组内需要不同表述」的冲突。届时以本节候选语义为起点,复用 §7 gate 与 §9 导出格式(kind 变体)。

## 11. 验收标准(AC)

- **门禁写入(G1)**:`remember` 工具 layer 枚举移除 global(memory-find 保留三层);除四个 gated 路径(抽取/提升/导入/存量迁移)外无任何代码路径向 global 根写盘(grep 级断言 + 写根测试);**导入与提升的「确认」不绕过 §7.1 gate**(服务端重跑断言)。
- **泛型隔离(G2)**:三个泛型的 sources 函数返回的条目全来自声明目录(单测锁定;review<global-type1> = global 目录 entries,review<global-type2> = user/project 条目,extract = 文档切块);system prompt 不含其他层内容(单测)。
- **注入最小化(G3)**:默认 `summaryMode='global'` 时,提示词含 global 条目全文(≤30,createdAt 降序、同刻按 id 升序)+ user/project 两条统计行、不含任何 user/project 条目全文;`summaryMode='all'` 恢复旧行为(**新增 summary 渲染单测锁定两模式输出与退化规则**,不碰 contract.spec.ts);summaryChars 三处口径与注入同函数同 mode(单测)。
- **存储与 catalog**:global 根 `~/.dsh/lmemory/global/` 独立 catalog.json;默认 `catalog rebuild` 不触碰 global 目录、`--root` 只重建目标目录(两侧作用域单测);registry 出现 global 固定根(kind='global'),目录页可见;旧版读新 registry 的降级行为记录为已接受。
- **存量迁移**:迁移后 user 根 jsonl 中不再存在 layer=global 行,global 目录与「layer=global 的条目」同一集合(单测;幂等)。
- **workspace 匹配**:同一项目经 symlink 与真实路径进入,project 统计一致、registry 单条登记( canonical 合并单测);worktree 各得独立 workspace(单测);相对路径 entryPoint 原样存储,面板表头/CLI 文案标注「相对 workspace 根」(进 AC)。
- **提升与 gate**:5.1/5.2 输出的每条候选过 §7.1 全部硬查(MIN/MAX 长度、schema、稳定序取前 g);reject 候选绝不落盘(单测 + mock 节点输出覆盖);提升不修改源条目(单测);5.2 执行前回显节点数与预计成本,未确认不发调用(单测)。
- **导入导出**:非 global 导出包(kind 不符)拒绝;formatVersion 不符拒绝;schema/gate 非法条目 skipped 并列原因;批内 + 存量两轮去重;导入保留原 id/createdAt(round-trip 单测);成功导入后 catalog 条目数一致。
- **契约与视觉**:新页面/端点进 web-ui 契约 fixtures(含 14 键 config 断言);xbrowser 三引擎通过(零 console 错误)。

## 12. 非目标

- 不做 embedding/向量检索式「该不该记」判断(gate 是规则 + verdict,不是语义模型)。
- 不做 shared 层(§10)。
- **global 条目 v1 只增不改不删**(修订):memory-update / memory-delete / forget 不触碰 global 条目(WEB 面板同理只读);需要修订时走「再提升 + 人工清理 jsonl + catalog rebuild --root」。resolveRecalled 逆查域与 sourcesFor 同步扩展(§5.2 表)。
- 不做跨主机 global 同步(host 级,与现有口径一致)。
- 不做 worktree 之间的 project 记忆共享(git common dir 探测不在 v1)。
- 不改 recall 工具的可见面语义(只追加 global 平面到其来源)。
- 不做「自动触发」的提升/抽取(全部为显式命令/WEB 动作;自动提取仍只写 user/project)。

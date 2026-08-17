/**
 * 记忆运行时状态机:team 预热 / 释放 / 重启 / 状态查询(纯逻辑,不 import cordis)。
 *
 * 把「发现记忆文件」与「节点 team 分区」粘起来,暴露给 `index.ts` 的召回工具、
 * `/lmemory` 命令与 system prompt 摘要。team 按 project root 缓存:预热后同一
 * root 的召回不再重读磁盘、不重组装,直到 stop / restart。
 *
 * @module dsh-memory/memory-runtime
 */

import { canonicalProjectRoot, discoverFiles, loadDir, visibleGlobalDir } from './memory-file.js'
import { warmUp } from './team.js'
import type { MemorySource, RecallTeam } from './team.js'
import { entryLine } from './render.js'
import type { SummaryMode } from './render.js'

/** 自动提取触发形态枚举(docs/auto-extraction.md §3)。 */
export const EXTRACT_MODES = ['signal', 'counter', 'event-counter'] as const

/** 自动提取触发形态。 */
export type ExtractMode = (typeof EXTRACT_MODES)[number]

/** 注入摘要模式枚举(docs/global-layer-design.md §6.1)。 */
export const SUMMARY_MODES = ['global', 'all'] as const satisfies readonly SummaryMode[]

/** rules 抽取器默认提示词(docs/auto-extraction.md §5.3)。 */
const DEFAULT_EXTRACT_RULES_PROMPT = '你是「用户偏好(rules)」抽取器。给定一段对话,找出用户明确表达或隐含的长期偏好、习惯、格式、技术栈限制、共识、约束。只输出值得长期记住的条目,一行一条,格式为「domain|scope|entry|entryPoint|references」,domain 从已知领域枚举中选最贴切的一个(如 DurablePrefs、CodeFacts、Style),scope 填这条记忆影响的具体子系统 / 模块(自由文本,如「全项目」「Web UI」),entry 填一句话条目(不含竖线 |),entryPoint 填这条记忆的来源文件路径(对话中出现的真实路径,或相对 workspace 根的相对路径,如 src/index.ts),references 填相关参考文件路径;entryPoint / references 没有对应路径时填 -。没有值得记的输出空。禁止记录:操作流水账、思考过程、具体代码实现、密钥或凭据、易变的进度/待办。'

/** lessons 抽取器默认提示词(docs/auto-extraction.md §5.3)。 */
const DEFAULT_EXTRACT_LESSONS_PROMPT = '你是「经验教训(lessons)」抽取器。给定一段对话,找出踩过的坑、环境限制、API 变更、bug 根因结论。只输出值得长期记住的条目,一行一条,格式为「domain|scope|entry|entryPoint|references」,domain 从已知领域枚举中选最贴切的一个(如 PastFixes、PromotedPitfalls、CodeFacts),scope 填这条记忆影响的具体子系统 / 模块(自由文本,如「样本库」「检测评分」),entry 填一句话条目(不含竖线 |),单条不超过 300 字,entryPoint 填这条记忆的来源文件路径(对话中出现的真实路径,或相对 workspace 根的相对路径,如 src/index.ts),references 填相关参考文件路径;entryPoint / references 没有对应路径时填 -。没有值得记的输出空。禁止记录:操作流水账、思考过程、具体代码实现、密钥或凭据。'

/** 形态 1(signal)默认信号词集,逗号分隔(docs/auto-extraction.md §3)。 */
const DEFAULT_SIGNAL_WORDS = '记住,下次,以后,偏好,习惯,约定,规则,常,总是,从不,remember,preference,always,never,habit,rule'

/** 用户可写配置切片(与 `ctx.settings` 的命名空间 schema 对应)。 */
export interface MemoryConfig {
  /** 每节点容量上限(单位 Kb)。 */
  maxNodeKb: number
  /** recall 返回的最大条目数。 */
  recallTopK: number
  /** 聚合阶段重排序提示词模板。 */
  rerankPrompt: string
  /** 插件启动时是否自动预热 team。 */
  warmupOnStart: boolean
  /** 召回模型调用所用 provider route。 */
  provider: string
  /** 召回模型 id(设计钉死 v4-flash)。 */
  model: string
  /** 质检(review)模式所用模型 id(设计钉死 v4-pro)。 */
  reviewModel: string
  /** 是否启用自动提取(默认开,旁路观测主会话自动管理记忆)。 */
  autoExtract: boolean
  /** 触发形态(`signal` / `counter` / `event-counter`)。 */
  extractMode: ExtractMode
  /** 相邻两次抽取的最小 turn 间隔(形态 3 作退火冷却期)。 */
  extractInterval: number
  /** 形态 1(signal)信号词集,逗号分隔。 */
  signalWords: string
  /** rules 抽取器提示词模板。 */
  extractRulesPrompt: string
  /** lessons 抽取器提示词模板。 */
  extractLessonsPrompt: string
  /** system prompt 注入摘要模式('global' 只注入 global 全文 + user/project 计数;'all' 旧全量行为)。 */
  summaryMode: SummaryMode
}

/** 召回默认配置(设计文档 §9 的起点,含自动提取配置 auto-extraction.md §7)。 */
export const DEFAULT_CONFIG: MemoryConfig = {
  maxNodeKb: 600,
  recallTopK: 10,
  rerankPrompt: '你是记忆召回的重排序器。给定用户的查询与若干候选记忆条目(每条一行,格式「[id|type|domain|scope] 条目文本」),请按与查询的相关度从高到低排序,并仅输出排序后的条目整行(照抄原文,一行一条),不输出任何解释。若两条相关度相同,保持原顺序。请勿编造条目,只使用给定候选。',
  warmupOnStart: true,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reviewModel: 'deepseek-v4-pro',
  autoExtract: true,
  extractMode: 'event-counter',
  extractInterval: 5,
  signalWords: DEFAULT_SIGNAL_WORDS,
  extractRulesPrompt: DEFAULT_EXTRACT_RULES_PROMPT,
  extractLessonsPrompt: DEFAULT_EXTRACT_LESSONS_PROMPT,
  summaryMode: 'global',
}

/** 可经 `/lmemory config get|set` 读写的配置键。 */
export const CONFIG_KEYS = ['maxNodeKb', 'recallTopK', 'rerankPrompt', 'warmupOnStart', 'provider', 'model', 'reviewModel', 'autoExtract', 'extractMode', 'extractInterval', 'signalWords', 'extractRulesPrompt', 'extractLessonsPrompt', 'summaryMode'] as const

/** 一个配置键。 */
export type ConfigKey = (typeof CONFIG_KEYS)[number]

/** 运行时 team 状态:按 project root 缓存的已预热 team。 */
export interface RuntimeState {
  /** project root → 已预热 team。空串 root 表示「无项目 cwd」。 */
  readonly teams: Map<string, RecallTeam>
}

/** 创建空的运行时状态。 */
export function createRuntimeState(): RuntimeState {
  return { teams: new Map() }
}

/**
 * 把给定 cwd 可见的记忆文件转为节点分配所需的记忆源(每个文件一个源,
 * 内容为逐行条目文本 `[id|type|domain|scope] entry`,供模型挑选相关条目并照抄整行)。
 * global 目录整体追加(concat 不合并——独立层,不与用户/项目同名文件互斥;
 * docs/global-layer-design.md §5.2)。
 * @param cwd - 当前工作目录;缺省只含内置 + 用户级。
 * @returns 记忆源列表。
 */
export function sourcesFor(cwd: string | undefined): MemorySource[] {
  return [...discoverFiles(cwd), ...loadDir(visibleGlobalDir())].map(file => ({
    id: file.jsonlPath,
    text: file.entries.map(entryLine).join('\n'),
  }))
}

/** 由 cwd 得 project root(无 cwd 时为空串);canonical 化后 symlink 与真实路径共享同一 team 缓存键。 */
function rootFor(cwd: string | undefined): string {
  return cwd === undefined ? '' : canonicalProjectRoot(cwd)
}

/**
 * 取(或惰性预热)某 cwd 的 team:已预热则直接返回,否则读盘分区并缓存。
 * @param state - 运行时状态。
 * @param cwd - 当前工作目录。
 * @param config - 配置(取 maxNodeKb)。
 * @returns 就绪 team。
 */
export function ensureTeam(state: RuntimeState, cwd: string | undefined, config: MemoryConfig): RecallTeam {
  const root = rootFor(cwd)
  const existing = state.teams.get(root)
  if (existing !== undefined) return existing
  const team = warmUp(sourcesFor(cwd), config.maxNodeKb)
  state.teams.set(root, team)
  return team
}

/** 释放全部已预热 team。 */
export function stopTeams(state: RuntimeState): void {
  state.teams.clear()
}

/** 重新组装某 cwd 的 team(先释放再预热)。 */
export function restartTeam(state: RuntimeState, cwd: string | undefined, config: MemoryConfig): RecallTeam {
  state.teams.delete(rootFor(cwd))
  return ensureTeam(state, cwd, config)
}

/** 单条 team 状态(供 `/lmemory status` 展示)。 */
export interface TeamStatus {
  /** project root;空串 = 无项目。 */
  readonly root: string
  /** 节点数。 */
  readonly nodes: number
  /** 该 root 是否已预热。 */
  readonly warmed: boolean
}

/** 汇总当前 team 状态。 */
export function teamStatus(state: RuntimeState): TeamStatus[] {
  return [...state.teams.entries()]
    .map(([root, team]) => ({ root, nodes: team.nodes.length, warmed: true }))
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
}

/**
 * dsh-memory 插件入口:把「长期记忆(Long-Term Memory)」接到 dsh 的接缝上。
 *
 * 接缝(设计文档 §2):
 *   - `ctx.tools.register` 暴露 remember / recall / forget 三个模型工具。
 *   - `ctx.llm.stream` 用 `deepseek-v4-flash` 做记忆节点 team 召回。
 *   - `ctx.systemPrompt.section` 注入「已知记忆」摘要(order 10)。
 *   - `ctx.commands.register` 提供 `/lmemory` 管理命令。
 *   - `ctx.settings` 存 maxNodeKb / recallTopK / rerankPrompt / warmupOnStart 等配置。
 *   - web 模式下经 `webServer.register` + `connection.rpc.handle` 挂记忆 Web 面板
 *     (`/memory`、`/memory/settings` 页面 + `/memory-api` RPC channel,见 ./web-ui/ui.js)。
 *
 * 与 session-reference 的边界:session-reference 管「整段历史会话快照」,本插件管
 * 「提炼的、跨会话累积的语义事实」(只含 rules/lessons 两类)。所有注册都是
 * ctx.effect,随 fiber 自动销毁;纯逻辑下沉到不 import cordis 的模块。
 * @module @meomeo-dev/dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'

import { DOMAINS } from './schema.js'
import type { DomainId, LayerId, MemoryEntryInput, MemoryType } from './schema.js'
import { renderSummary } from './render.js'
import { discoverEntries, resolveRecalled } from './memory-file.js'
import type { RecalledEntry } from './memory-file.js'
import { append, find, rebuild, remove, removeByEntry, update } from './store.js'
import { recall as recallTeam } from './team.js'
import type { NodeRecallFn, RerankFn } from './team.js'
import {
  parseFindings,
  renderReviewReport,
  reviewEntryLine,
  reviewTeam,
  runReview,
} from './review.js'
import type { CrossNodeReviewFn, NodeReviewFn, ReviewFinding } from './review.js'
import { assertDeletable, requireMemoryId } from './tool-guard.js'
import {
  CONFIG_KEYS,
  createRuntimeState,
  DEFAULT_CONFIG,
  EXTRACT_MODES,
  ensureTeam,
  restartTeam,
  stopTeams,
  teamStatus,
} from './memory-runtime.js'
import type { ExtractMode, MemoryConfig, RuntimeState, TeamStatus } from './memory-runtime.js'
import {
  annealError,
  annealSessionStart,
  annealTurnStopping,
  buildTranscript,
  containsSignalWord,
  deriveLayer,
  extractBoth,
  filterNovel,
  parseSignalWords,
} from './extract.js'
import type { ExtractFn, TranscriptMessage } from './extract.js'
import { computeStats, EMPTY_USAGE, estimateTokens, recordUsage } from './stats.js'
import type { UsageCounter } from './stats.js'
import { COMMAND_HELPS, USAGE, parseLmemoryCommand, renderHelp } from './command.js'
import {
  PANEL_CHANNEL,
  assetContentType,
  describeConfig,
  findPanelDist,
  generatePanelToken,
  handlePanelRpc,
  matchesPanelQuery,
  panelUrl,
  queryToken,
  readPanelAsset,
  renderPanelShell,
  resolvePanelAsset,
  safeTokenEqual,
} from './web-ui/ui.js'
import type { PanelDeps, PanelPage } from './web-ui/ui.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-memory'

/** 插件挂载所需服务。 */
export const inject = ['systemPrompt', 'tools', 'commands', 'llm']

/** 用户可写设置命名空间。 */
const NAMESPACE = settingsNamespace('memory')

/** 该命名空间的 schema(缺省回退到 {@link DEFAULT_CONFIG})。 */
const SCHEMA: z<MemoryConfig> = z.object({
  maxNodeKb: z.number().step(1).min(1).default(DEFAULT_CONFIG.maxNodeKb),
  recallTopK: z.number().step(1).min(1).default(DEFAULT_CONFIG.recallTopK),
  rerankPrompt: z.string().min(1).default(DEFAULT_CONFIG.rerankPrompt),
  warmupOnStart: z.boolean().default(DEFAULT_CONFIG.warmupOnStart),
  provider: z.string().min(1).default(DEFAULT_CONFIG.provider),
  model: z.string().min(1).default(DEFAULT_CONFIG.model),
  reviewModel: z.string().min(1).default(DEFAULT_CONFIG.reviewModel),
  autoExtract: z.boolean().default(DEFAULT_CONFIG.autoExtract),
  extractMode: z.union([...EXTRACT_MODES]).default(DEFAULT_CONFIG.extractMode),
  extractInterval: z.number().step(1).min(1).default(DEFAULT_CONFIG.extractInterval),
  signalWords: z.string().default(DEFAULT_CONFIG.signalWords),
  extractRulesPrompt: z.string().min(1).default(DEFAULT_CONFIG.extractRulesPrompt),
  extractLessonsPrompt: z.string().min(1).default(DEFAULT_CONFIG.extractLessonsPrompt),
})

/** 召回节点 system prompt(固定,非配置项)。 */
const NODE_RECALL_SYSTEM = '你是长期记忆召回节点。给定一组记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`)与一个查询,仅返回与查询相关的条目的**整行**(含方括号前缀),一行一条,照抄原文,不返回任何解释。无相关条目时返回空。'

/** LLM 调用消耗的职责分类(与 stats.ts 的 UsageCounter 对应)。 */
type UsageLabel = 'recall' | 'extract' | 'review'

/** 运行时可变状态:已预热 team + 当前配置 + 退火冷却计数器 + LLM 调用消耗。 */
interface Runtime {
  readonly state: RuntimeState
  config: MemoryConfig
  /** 会话 id → 距上次抽取的 turn 数(形态 3 退火冷却,按会话独立)。 */
  readonly annealing: Map<string, number>
  /** 职责分类 → LLM 调用消耗累计(供 `/lmemory usage`)。 */
  readonly usage: Map<UsageLabel, UsageCounter>
  /** Web 面板访问 token(仅 web 模式注册;每次进程启动重新生成)。 */
  panelToken?: string
}

/** remember 工具的规范化输出。 */
interface RememberValue {
  remembered: boolean
  duplicate: boolean
  type: string
  entry: string
  jsonlPath: string
  mdPath: string
}

/** recall 工具的规范化输出(完整条目投影,与 memory-find 同构)。 */
interface RecallValue {
  entries: RecalledEntry[]
}

/** forget 工具的规范化输出。 */
interface ForgetValue {
  removed: number
  entry: string
}

/** memory-find 工具的规范化输出。 */
interface FindValue {
  entries: RecalledEntry[]
}

/** memory-update 工具的规范化输出。 */
interface UpdateValue {
  id: string
  entry: string
  file: string
}

/** memory-delete 工具的规范化输出。 */
interface DeleteValue {
  removed: boolean
  id: string
}

/** 把模型输出文本按行拆成条目(轻量去前缀)。 */
function parseLines(text: string): string[] {
  return text.split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-*•]\s*/, ''))
    .map(line => line.replace(/^\d+[.)]\s*/, ''))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/**
 * 发一次轻量模型调用(召回用 v4-flash、质检用 v4-pro),返回聚合文本,并把
 * usage 累计进对应职责分类的计数器(供 `/lmemory usage`)。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(取配置 + usage 累计)。
 * @param system - system prompt 文本。
 * @param prompt - 用户消息文本。
 * @param label - 职责分类(recall / extract / review)。
 * @param model - 覆盖模型 id;缺省用 `config.model`。
 */
async function callFlash(
  ctx: Context,
  runtime: Runtime,
  system: string,
  prompt: string,
  label: UsageLabel,
  model = runtime.config.model,
): Promise<string> {
  const message = createUserMessage({
    source: { kind: 'plugin', plugin: 'dsh-memory' },
    content: [{ type: 'text', text: prompt }],
  })
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider: runtime.config.provider,
    model,
    system,
    messages: [message],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') {
      runtime.usage.set(label, recordUsage(runtime.usage.get(label) ?? EMPTY_USAGE, chunk.usage))
    } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error(`memory recall call failed: ${chunk.reason.failure.message}`)
    }
  }
  return text
}

/** 节点失败告警(per-node 容错的可观测性;绑定 ctx.logger.warn,不中断流程)。 */
function warnNode(ctx: Context, label: string, error: unknown): void {
  ctx.logger.warn(`dsh-memory: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
}

/** 执行一次召回:预热 team → fan-out → 聚合(整行)→ 按 id 逆查补全字段。 */
async function doRecall(ctx: Context, runtime: Runtime, cwd: string | undefined, query: string): Promise<RecalledEntry[]> {
  const team = ensureTeam(runtime.state, cwd, runtime.config)
  const nodeFn: NodeRecallFn = async (node, q) => {
    const response = await callFlash(ctx, runtime, NODE_RECALL_SYSTEM, `记忆条目:\n${node.text}\n\n查询:${q}`, 'recall')
    return parseLines(response)
  }
  const rerankFn: RerankFn = async (q, candidates) => {
    const response = await callFlash(
      ctx,
      runtime,
      runtime.config.rerankPrompt,
      `查询:${q}\n\n候选条目:\n${candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`,
      'recall',
    )
    const ordered = parseLines(response)
    return ordered.length > 0 ? ordered : candidates
  }
  const lines = await recallTeam(team, query, nodeFn, rerankFn, runtime.config.recallTopK, (nodeId, error) => warnNode(ctx, `recall node ${nodeId}`, error))
  return resolveRecalled(cwd, lines)
}

/** 质检节点 system prompt(固定,非配置项;只输出 JSON 数组)。 */
const NODE_REVIEW_SYSTEM = '你是长期记忆质检员。给定一组记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`),批判性审查,找出其中的缺陷,只输出一个 JSON 数组,不要输出任何解释。四类缺陷:contradiction(两条记忆互相矛盾)、duplicate(同义记忆重复)、outdated(被新事实推翻的过时结论)、divergence(与当前项目状态背离)。每个元素形如 {"id":"目标记忆 id","problem":"contradiction|duplicate|outdated|divergence","related":["关联记忆 id"],"note":"一句话描述","suggest":"update|delete|merge","suggestedEntry":"建议新条目文本(可选)"}。contradiction/duplicate 需填 related;outdated/divergence 通常单条(related 为空数组)。id/related 必须照抄给定条目的 id,不得编造。无缺陷时输出 []。'

/** 质检跨节点 system prompt(只判矛盾/重复,只输出 JSON 数组)。 */
const CROSS_NODE_REVIEW_SYSTEM = '你是长期记忆质检员。给定全部记忆条目(每条一行,格式 `[id|type|domain|scope] 条目文本`),这些条目可能原本分在不同分组,现在合并到一起。找出跨条目的矛盾(contradiction)与重复(duplicate),只输出一个 JSON 数组,不要输出任何解释。每个元素形如 {"id":"目标记忆 id","problem":"contradiction|duplicate","related":["关联记忆 id"],"note":"一句话描述","suggest":"update|delete|merge","suggestedEntry":"可选"}。id/related 必须照抄给定条目的 id,不得编造。无缺陷时输出 []。'

/**
 * 执行一次质检:读全部可见记忆 → 带 id 分区 → v4-pro fan-out + 跨节点聚合。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(team + 配置)。
 * @param cwd - 当前工作目录。
 * @param filter - 可选限定(按 layer / domain 缩小质检范围)。
 * @returns 聚合去重后的缺陷发现。
 */
async function doReview(
  ctx: Context,
  runtime: Runtime,
  cwd: string | undefined,
  filter?: { kind: 'layer'; value: LayerId } | { kind: 'domain'; value: DomainId },
): Promise<ReviewFinding[]> {
  let entries = discoverEntries(cwd)
  if (filter?.kind === 'layer') entries = entries.filter(entry => entry.layer === filter.value)
  else if (filter?.kind === 'domain') entries = entries.filter(entry => entry.domain === filter.value)
  if (entries.length === 0) return []

  const team = reviewTeam(entries, runtime.config.maxNodeKb)
  const knownIds = new Set(entries.map(entry => entry.id))

  const nodeReviewFn: NodeReviewFn = async (node) => {
    const response = await callFlash(ctx, runtime, NODE_REVIEW_SYSTEM, `记忆条目:\n${node.text}`, 'review', runtime.config.reviewModel)
    return parseFindings(response, knownIds)
  }
  const crossNodeReviewFn: CrossNodeReviewFn = async (allEntries) => {
    const text = allEntries.map(reviewEntryLine).join('\n')
    const response = await callFlash(ctx, runtime, CROSS_NODE_REVIEW_SYSTEM, `记忆条目:\n${text}`, 'review', runtime.config.reviewModel)
    return parseFindings(response, knownIds)
  }
  return runReview(team, entries, nodeReviewFn, crossNodeReviewFn, (nodeId, error) => warnNode(ctx, `review ${nodeId}`, error))
}

/** 从一条消息的 content blocks 提取纯文本(只取 text 块,跳过 reasoning/tool/图片)。 */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    // reasoning / image / tool-call / tool-result 不含面向会话的正文;抽取器只看对话文本。
    default:
      return ''
  }
}

/** 从一组 content blocks 提取纯文本(拼接非空 text 块,供信号词匹配)。 */
function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks.map(blockText).filter(chunk => chunk.length > 0).join(' ')
}

/** 把 `deriveMessages()` 的结果投影成抽取器输入(role + 文本,过滤空文本消息)。 */
function toTranscript(messages: readonly Message[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = []
  for (const message of messages) {
    const text = message.content.map(blockText).filter(chunk => chunk.length > 0).join(' ')
    if (text.length === 0) continue
    result.push({ role: message.role, text })
  }
  return result
}

/**
 * 执行一次自动提取:主会话上下文 fan-out 两个抽取节点 → 写盘(走 store)。
 *
 * 抽取器不调 remember 工具,直接调共享存储层;layer 由会话推导,scope/domain/entry
 * 由抽取器输出(docs/auto-extraction.md §5.5/§5.6)。lessons 先按 entry 与已有记忆
 * 去重再追加,rules 重复由 store.append 的 duplicate 拒绝兜底。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(配置)。
 * @param session - 触发抽取的会话(取上下文与 cwd;agent.id 与 session.id 同值)。
 */
async function runExtraction(ctx: Context, runtime: Runtime, session: Session): Promise<void> {
  const cwd = session.header.cwd
  if (cwd === undefined) return
  const transcript = buildTranscript(toTranscript(session.deriveMessages()))
  const rulesFn: ExtractFn = text => callFlash(ctx, runtime, runtime.config.extractRulesPrompt, text, 'extract')
  const lessonsFn: ExtractFn = text => callFlash(ctx, runtime, runtime.config.extractLessonsPrompt, text, 'extract')
  const result = await extractBoth(transcript, rulesFn, lessonsFn, (type, error) => warnNode(ctx, `extract ${type}`, error))
  const layer = deriveLayer(cwd)
  const existingLessons = new Set(find(cwd, { type: 'lessons' }).map(found => found.entry.entry))
  for (const candidate of result.rules) {
    append(cwd, {
      type: 'rules', domain: candidate.domain, scope: candidate.scope, layer, entry: candidate.entry,
      ...(candidate.entryPoint === undefined ? {} : { entryPoint: candidate.entryPoint }),
      ...(candidate.references === undefined ? {} : { references: candidate.references }),
    })
  }
  for (const candidate of filterNovel(result.lessons, existingLessons)) {
    append(cwd, {
      type: 'lessons', domain: candidate.domain, scope: candidate.scope, layer, entry: candidate.entry,
      ...(candidate.entryPoint === undefined ? {} : { entryPoint: candidate.entryPoint }),
      ...(candidate.references === undefined ? {} : { references: candidate.references }),
    })
  }
}

/** 读某会话的退火冷却计数器(缺省 0;agent.id 与 session.id 同值,故统一用会话 id 作 key)。 */
function turnsSince(runtime: Runtime, sessionId: string): number {
  return runtime.annealing.get(sessionId) ?? 0
}

/** 触发一次抽取(后台 fire-and-forget,吞掉错误避免未处理拒绝)。 */
function scheduleExtraction(ctx: Context, runtime: Runtime, session: Session): void {
  void runExtraction(ctx, runtime, session).catch((error: unknown) => {
    ctx.logger.warn(`dsh-memory auto-extraction failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** 形态守卫:仅当 `autoExtract` 开启且命中指定形态时放行。 */
function extractEnabled(config: MemoryConfig, mode: ExtractMode): boolean {
  return config.autoExtract && config.extractMode === mode
}

/**
 * 注册自动提取的三种触发形态监听(docs/auto-extraction.md §3)。旁路观测:只监听
 * 主会话事件 / agent 事件触发抽取,不向主 agent 注入任何「主动记忆」提示词——
 * 抽取节点的提示词(rules/lessons)只在抽取发生时喂给 v4-flash,不进入主会话。
 */
function registerAutoExtraction(ctx: Context, runtime: Runtime): void {
  // 形态 1 信号词:观测 user/message + assistant/message 正文,命中信号词触发。
  // 无退火——每次命中即抽(成本靠抽取提示词「无记忆返回空」约束,docs/auto-extraction.md §3)。
  ctx.on('session/event', (session, event) => {
    if (!extractEnabled(runtime.config, 'signal')) return
    let text = ''
    if (event.type === 'user/message') text = blocksText(event.data.content)
    else if (event.type === 'assistant/message') text = blocksText(event.data.message.content)
    else return
    if (!containsSignalWord(text, parseSignalWords(runtime.config.signalWords))) return
    scheduleExtraction(ctx, runtime, session)
  })

  // 形态 2 计数器:观测 turn/end,纯 turn 计数到 extractInterval 触发。
  ctx.on('session/event', (session, event) => {
    if (!extractEnabled(runtime.config, 'counter')) return
    if (event.type !== 'turn/end') return
    const decision = annealTurnStopping(turnsSince(runtime, session.id), runtime.config.extractInterval)
    runtime.annealing.set(session.id, decision.turnsSince)
    if (decision.released) scheduleExtraction(ctx, runtime, session)
  })

  // 形态 3 事件 + 计数器:agent 事件(语义触发)+ 计数器退火抑制高频。
  // 高频检查点:每 turn 触发一次,退火降到每 N turn 最多一次。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!extractEnabled(runtime.config, 'event-counter')) return
    const decision = annealTurnStopping(turnsSince(runtime, agent.id), runtime.config.extractInterval)
    runtime.annealing.set(agent.id, decision.turnsSince)
    if (decision.released) scheduleExtraction(ctx, runtime, agent.session)
  })

  // 强语义事件:出错即抽,退火同样防连续 error 高频触发。
  ctx.on('agent/error', ({ agent }) => {
    if (!extractEnabled(runtime.config, 'event-counter')) return
    const decision = annealError(turnsSince(runtime, agent.id), runtime.config.extractInterval)
    runtime.annealing.set(agent.id, decision.turnsSince)
    if (decision.released) scheduleExtraction(ctx, runtime, agent.session)
  })

  // 会话开始:新会话直接抽 + 冷却归零。
  ctx.on('agent/session-start', ({ agent }) => {
    if (!extractEnabled(runtime.config, 'event-counter')) return
    const decision = annealSessionStart()
    runtime.annealing.set(agent.id, decision.turnsSince)
    if (decision.released) scheduleExtraction(ctx, runtime, agent.session)
  })
}

/** 应用新配置;容量变化时释放已预热 team 以便下次重分区。 */
function applyConfig(runtime: Runtime, next: MemoryConfig): void {
  const prev = runtime.config
  runtime.config = next
  if (next.maxNodeKb !== prev.maxNodeKb) stopTeams(runtime.state)
}

/** 渲染一条召回/查找结果为单行(含 id、分类、落点、溯源路径;`-` 字段省略)。 */
function renderRecalledLine(found: RecalledEntry): string {
  const trace = [
    found.file,
    ...(found.entryPoint !== '-' ? [`entryPoint: ${found.entryPoint}`] : []),
    ...(found.references !== '-' ? [`references: ${found.references}`] : []),
  ].join(' · ')
  return `[${found.id}] (${found.type}/${found.domain}, ${found.layer}) ${found.entry} — ${trace}`
}

/** 渲染召回条目为多行编号文本。 */
function renderEntries(entries: readonly RecalledEntry[]): string {
  if (entries.length === 0) return 'No relevant memory entries.'
  return entries.map((entry, index) => `${index + 1}. ${renderRecalledLine(entry)}`).join('\n')
}

/** 渲染 team 状态为可读文本。 */
function renderStatus(statuses: readonly TeamStatus[], config: MemoryConfig): string {
  if (statuses.length === 0) return `No warm memory team. maxNodeKb=${config.maxNodeKb}`
  const lines = statuses.map(status =>
    `  ${status.root === '' ? '(no project)' : status.root}: ${status.nodes} node(s)`)
  return `Memory team (maxNodeKb=${config.maxNodeKb}):\n${lines.join('\n')}`
}

/** 把字节数渲染为人类可读的大小(保留一位小数,自适应 Kb/Mb)。 */
function renderBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kb`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mb`
}

/** 渲染记忆统计(`/lmemory stats`)。 */
function renderStats(cwd: string | undefined, config: MemoryConfig): string {
  const stats = computeStats(cwd)
  const domains = [...stats.byDomain.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const domainLines = domains.length === 0
    ? ['(none)']
    : domains.map(([domain, count]) => `    ${domain}: ${count}`)
  return [
    `Memory stats (maxNodeKb=${config.maxNodeKb}):`,
    `  entries: ${stats.total} (rules: ${stats.byType.rules}, lessons: ${stats.byType.lessons})`,
    `  layers: global: ${stats.byLayer.global}, user: ${stats.byLayer.user}, project: ${stats.byLayer.project}`,
    '  domains:',
    ...domainLines,
    `  files: ${stats.files} (jsonl ${renderBytes(stats.jsonlBytes)}, md ${renderBytes(stats.mdBytes)})`,
    `  catalog entries: ${stats.catalogEntries}`,
  ].join('\n')
}

/** 渲染 token 用量(`/lmemory usage`):静态上下文成本估算 + 动态 LLM 调用消耗。 */
function renderUsage(runtime: Runtime, cwd: string | undefined): string {
  let nodeChars = 0
  let nodeCount = 0
  for (const team of runtime.state.teams.values()) {
    nodeCount += team.nodes.length
    for (const node of team.nodes) nodeChars += node.text.length
  }
  const summaryChars = renderSummary(discoverEntries(cwd)).length
  const labels: readonly UsageLabel[] = ['recall', 'extract', 'review']
  const callLines = labels.map((label) => {
    const counter = runtime.usage.get(label) ?? EMPTY_USAGE
    return `    ${label}: ${counter.calls} call(s) — input ${counter.inputTokens.toLocaleString()} / output ${counter.outputTokens.toLocaleString()} / cacheRead ${counter.cacheReadTokens.toLocaleString()}`
  })
  return [
    'Memory token usage:',
    `  warm team: ${nodeCount} node(s), ${renderBytes(nodeChars)} text (~${estimateTokens(nodeChars).toLocaleString()} tokens est.)`,
    `  system-prompt summary: ${renderBytes(summaryChars)} (~${estimateTokens(summaryChars).toLocaleString()} tokens est.)`,
    '  LLM calls (this process):',
    ...callLines,
  ].join('\n')
}

/** 由配置对象渲染一行/全部配置。 */
function renderConfig(config: MemoryConfig, key?: string): string {
  if (key !== undefined) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      return `Unknown config key "${key}". Known: ${CONFIG_KEYS.join(', ')}`
    }
    return `${key} = ${String((config as unknown as Record<string, unknown>)[key])}`
  }
  return CONFIG_KEYS.map(k => `${k} = ${String((config as unknown as Record<string, unknown>)[k])}`).join('\n')
}

/**
 * 注册记忆 Web 面板(路径 B 独立页,见 ./ui.js 的模块文档):
 *   - GET `/memory`(记忆页)与 `/memory/settings`(设置页),均须 `?ac_token=`;
 *   - GET `/memory-assets/*`(前缀,白名单后缀 + 路径防穿越 + token);
 *   - POST `/memory-api/*` RPC channel(authority: 'loopback',信任栅栏 + 载荷 token)。
 *
 * 仅当 webServer 与 connection 服务同时存在(web 模式)且 panel 构建产物在位时
 * 注册;headless 环境两个服务都不存在,面板不存在,`/lmemory ui` 报不可用。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(token 记录于此)。
 * @param scope - settings 命名空间 scope(config-get/set 端点经它读写)。
 */
function registerPanel(ctx: Context, runtime: Runtime, scope: SettingsScope<MemoryConfig>): void {
  const web = ctx.get('webServer')
  if (web === undefined) return
  const panelDir = findPanelDist()
  if (panelDir === undefined) {
    ctx.logger.warn('dsh-memory: panel dist not found (run `pnpm panel:build`); web panel disabled')
    return
  }
  const token = generatePanelToken()
  runtime.panelToken = token

  const servePage = (page: PanelPage): WebRoute['handler'] => (req, res) => {
    // token 门:缺失或不匹配一律 403(常量时间比较)。
    if (!safeTokenEqual(queryToken(req.url) ?? '', token)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const html = renderPanelShell({ page, token, channel: PANEL_CHANNEL })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  ctx.effect(() => web.register({ kind: 'exact', path: '/memory', handler: servePage('memory') }), 'dsh-memory: /memory page')
  ctx.effect(() => web.register({ kind: 'exact', path: '/memory/settings', handler: servePage('settings') }), 'dsh-memory: /memory/settings page')
  ctx.effect(() => web.register({
    kind: 'prefix',
    path: '/memory-assets',
    handler: (req, res) => {
      const rawUrl = req.url ?? '/'
      let pathname: string
      try {
        pathname = new URL(rawUrl, 'http://x').pathname
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (!safeTokenEqual(queryToken(rawUrl) ?? '', token)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const file = resolvePanelAsset(panelDir, pathname)
      const content = file === undefined ? undefined : readPanelAsset(panelDir, pathname)
      if (file === undefined || content === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': assetContentType(file),
        'cache-control': 'no-cache',
      })
      res.end(content)
    },
  }), 'dsh-memory: /memory-assets route')

  // connection 由 client-connection 插件 fiber 提供:loader 并发启动 plugin,
  // apply 时该 fiber 未必已 ACTIVE,故用声明式注入而非 ctx.get(与 api-proxy 同款)。
  ctx.inject(['connection'], (cctx) => {
    const deps: PanelDeps = {
      entries(cwd, filters) {
        const rows = find(cwd, {
          ...(filters.type !== undefined ? { type: filters.type } : {}),
          ...(filters.domain !== undefined ? { domain: filters.domain } : {}),
          ...(filters.layer !== undefined ? { layer: filters.layer } : {}),
        }).filter(({ entry }) => filters.query === undefined || matchesPanelQuery(entry, filters.query))
        rows.sort((a, b) => b.entry.createdAt - a.entry.createdAt)
        return rows.map(({ entry, file }) => ({ entry, file }))
      },
      getConfig() {
        return describeConfig(runtime.config)
      },
      async setConfig(patch) {
        await scope.update(patch)
        applyConfig(runtime, scope.get())
        return describeConfig(runtime.config)
      },
    }

    const disposeChannel = cctx.connection.rpc.handle(
      PANEL_CHANNEL,
      (endpoint, payload, _signal) => handlePanelRpc(endpoint, payload, token, deps),
      { authority: 'loopback' },
    )
    cctx.effect(() => disposeChannel, 'dsh-memory: /memory-api channel')
    cctx.logger.info(`dsh-memory panel: ${panelUrl(web.port, 'memory', token)}`)
  })
}

/** 把配置命令里的原始字符串强转成对应 JS 值。 */
function coerceConfigValue(key: string, raw: string): unknown {
  if (key === 'maxNodeKb' || key === 'recallTopK' || key === 'extractInterval') {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`)
    return value
  }
  if (key === 'warmupOnStart' || key === 'autoExtract') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new Error(`${key} must be true or false`)
  }
  if (key === 'extractMode') {
    if ((EXTRACT_MODES as readonly string[]).includes(raw)) return raw
    throw new Error(`extractMode must be one of ${EXTRACT_MODES.join(', ')}`)
  }
  return raw
}

/** 执行一次 `/lmemory` 命令。 */
async function handleCommand(
  ctx: Context,
  runtime: Runtime,
  scope: SettingsScope<MemoryConfig>,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const command = parseLmemoryCommand(invocation.rawInput)
  const cwd = invocation.agent.session.header.cwd
  try {
    switch (command.kind) {
      case 'help':
        if (command.topic !== undefined && !COMMAND_HELPS.has(command.topic)) {
          return { kind: 'error', text: renderHelp(command.topic) }
        }
        return { kind: 'success', text: renderHelp(command.topic) }
      case 'status':
        return { kind: 'success', text: renderStatus(teamStatus(runtime.state), runtime.config) }
      case 'stats':
        return { kind: 'success', text: renderStats(cwd, runtime.config) }
      case 'usage':
        return { kind: 'success', text: renderUsage(runtime, cwd) }
      case 'ui': {
        const token = runtime.panelToken
        const port = ctx.get('webServer')?.port
        if (token === undefined || port === undefined) {
          return { kind: 'error', text: 'Memory panel is not available: this session has no webServer/connection (web mode only).' }
        }
        const links = [
          `[记忆面板](${panelUrl(port, 'memory', token)})`,
          `[设置面板](${panelUrl(port, 'settings', token)})`,
        ].join(' · ')
        return { kind: 'success', text: `Memory panel: ${links}` }
      }
      case 'team': {
        if (command.action === 'start') {
          ensureTeam(runtime.state, cwd, runtime.config)
          return { kind: 'success', text: 'Memory team started.' }
        }
        if (command.action === 'stop') {
          stopTeams(runtime.state)
          return { kind: 'success', text: 'Memory team stopped.' }
        }
        restartTeam(runtime.state, cwd, runtime.config)
        return { kind: 'success', text: 'Memory team restarted.' }
      }
      case 'query': {
        const entries = await doRecall(ctx, runtime, cwd, command.text)
        return { kind: 'success', text: renderEntries(entries) }
      }
      case 'config-get':
        return { kind: 'success', text: renderConfig(runtime.config, command.key) }
      case 'config-set': {
        if (!(CONFIG_KEYS as readonly string[]).includes(command.key)) {
          return { kind: 'error', text: `Unknown config key "${command.key}". Known: ${CONFIG_KEYS.join(', ')}` }
        }
        const value = coerceConfigValue(command.key, command.value)
        await scope.update({ [command.key]: value })
        applyConfig(runtime, scope.get())
        return { kind: 'success', text: renderConfig(runtime.config, command.key) }
      }
      case 'review': {
        const findings = await doReview(ctx, runtime, cwd, command.filter)
        const report = renderReviewReport(findings)
        invocation.agent.followup(createUserMessage({
          source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: `记忆质检:发现 ${findings.length} 处缺陷` },
          content: [{ type: 'text', text: report }],
        }))
        return { kind: 'success', text: `review 完成,发现 ${findings.length} 处,报告已注入会话` }
      }
      case 'catalog': {
        rebuild(cwd)
        return { kind: 'success', text: 'catalog rebuilt from jsonl.' }
      }
      /* v8 ignore next 2 -- closed union backstop */
      default:
        return { kind: 'error', text: USAGE }
    }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** remember 工具:校验枚举 → 追加 JSONL 行 → 重渲染 MD;rules 只增不减。 */
const REMEMBER_DESCRIPTION = 'Write one long-term memory entry. Only record rules (durable preferences, constraints, consensus) or lessons (past pitfalls, API changes); never log the step-by-step transcript, reasoning process, code implementation, or credentials. Provide type, domain, scope (impacted subsystem/module, free text), layer (storage layer), and the one-sentence entry; entryPoint and references default to "-".'

/** recall 工具:fan-out 到记忆节点 team → 聚合返回相关条目。 */
const RECALL_DESCRIPTION = 'Recall relevant long-term memory entries for a query by fanning out to the warm memory-node team and aggregating the deduplicated, reranked results. Each returned entry carries its full fields (id, type, domain, scope, layer, entry) plus the containing file, entryPoint, and references for traceability.'

/** forget 工具:精确匹配删除;rules 删除需 confirm:true。 */
const FORGET_DESCRIPTION = 'Delete a long-term memory entry by exact entry text. Deleting a "rules" entry requires confirm: true because rules are append-only.'

/** memory-find 工具:按 id 精确查一条,或按类型/领域/范围/落点层过滤列多条。 */
const FIND_DESCRIPTION = 'Look up long-term memory entries. Pass an exact id to retrieve one entry, or filter by type, domain, scope, or storage layer to list many. Returns the full entry with its id and containing file.'

/** memory-update 工具:按 id 改写可改字段;id/type/layer 不可改。 */
const UPDATE_DESCRIPTION = 'Update one long-term memory entry by its exact id. Only the entry text, domain, scope, entryPoint, and references are mutable; the id, type, and layer cannot change.'

/** memory-delete 工具:按 id 精确删除;rules 删除需 confirm:true。 */
const DELETE_DESCRIPTION = 'Delete one long-term memory entry by its exact id. Deleting a "rules" entry requires confirm: true because rules are append-only.'

/**
 * 注册 remember / recall / forget 三个模型工具。
 * @param ctx - 插件上下文。
 * @param runtime - 运行时状态(team + 配置)。
 */
function registerTools(ctx: Context, runtime: Runtime): void {
  ctx.tools.register(defineTool({
    name: 'remember',
    description: REMEMBER_DESCRIPTION,
    parameters: {
      type: { type: 'string', required: true, enum: ['rules', 'lessons'], description: 'Memory type: rules or lessons.' },
      domain: { type: 'string', required: true, enum: [...DOMAINS], description: 'Knowledge domain (one of 21 ids).' },
      scope: { type: 'string', required: true, description: 'Impacted scope: which subsystem or module this memory affects (free text, e.g. "全项目", "Web UI", "Provider 接入").' },
      layer: { type: 'string', required: true, enum: ['global', 'user', 'project'], description: 'Storage layer: project writes under the repo, user under ~/.dsh.' },
      entry: { type: 'string', required: true, description: 'One-sentence entry text.' },
      entryPoint: { type: 'string', description: 'Associated entry-point file path, or omit.' },
      references: { type: 'string', description: 'Associated reference file path, or omit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remembered: { type: 'boolean', required: true },
          duplicate: { type: 'boolean', required: true },
          type: { type: 'string', required: true },
          entry: { type: 'string', required: true },
          jsonlPath: { type: 'string', required: true },
          mdPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as RememberValue
        const text = v.duplicate
          ? `Already remembered (${v.type}): ${v.entry}`
          : `Remembered (${v.type}): ${v.entry}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec): Promise<RememberValue> {
      const candidate: MemoryEntryInput = {
        type: args.type as MemoryType,
        domain: args.domain as DomainId,
        scope: args.scope,
        layer: args.layer as LayerId,
        entry: args.entry,
        ...(args.entryPoint !== undefined ? { entryPoint: args.entryPoint } : {}),
        ...(args.references !== undefined ? { references: args.references } : {}),
      }
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const result = append(cwd, candidate)
      return {
        remembered: true,
        duplicate: result.duplicate,
        type: result.entry.type,
        entry: result.entry.entry,
        jsonlPath: result.jsonlPath ?? '-',
        mdPath: result.mdPath ?? '-',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recall',
    description: RECALL_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'The recall query.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                file: { type: 'string', required: true },
                type: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                entry: { type: 'string', required: true },
                entryPoint: { type: 'string', required: true },
                references: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as RecallValue
        return [{ type: 'text', text: renderEntries(v.entries) }]
      },
    },
    async execute(args, exec): Promise<RecallValue> {
      const cwd = exec.agent?.session.header.cwd
      const entries = await doRecall(ctx, runtime, cwd, args.query)
      return { entries }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forget',
    description: FORGET_DESCRIPTION,
    parameters: {
      entry: { type: 'string', required: true, description: 'Exact entry text to delete.' },
      type: { type: 'string', enum: ['rules', 'lessons'], description: 'Restrict deletion to this type.' },
      confirm: { type: 'boolean', description: 'Required (true) when deleting a rules entry.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer', required: true },
          entry: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as ForgetValue
        return [{ type: 'text', text: v.removed > 0 ? `Forgot ${v.removed} entry: ${v.entry}` : `No matching entry: ${v.entry}` }]
      },
    },
    async execute(args, exec): Promise<ForgetValue> {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const type = args.type as MemoryType | undefined
      const matches = find(cwd, type === undefined ? {} : { type })
        .filter(found => found.entry.entry === args.entry)
      if (matches.some(found => found.entry.type === 'rules') && args.confirm !== true) {
        throw new Error('forget: this removes a "rules" entry; call again with confirm: true to proceed.')
      }
      const removed = removeByEntry(cwd, args.entry, type)
      return { removed, entry: args.entry }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory-find',
    description: FIND_DESCRIPTION,
    parameters: {
      id: { type: 'string', description: 'Exact memory id to retrieve (e.g. "m-3k9f2x8q1a").' },
      type: { type: 'string', enum: ['rules', 'lessons'], description: 'Filter by memory type.' },
      domain: { type: 'string', enum: [...DOMAINS], description: 'Filter by knowledge domain.' },
      scope: { type: 'string', description: 'Filter by exact impacted scope.' },
      layer: { type: 'string', enum: ['global', 'user', 'project'], description: 'Filter by storage layer.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                file: { type: 'string', required: true },
                type: { type: 'string', required: true },
                domain: { type: 'string', required: true },
                scope: { type: 'string', required: true },
                layer: { type: 'string', required: true },
                entry: { type: 'string', required: true },
                entryPoint: { type: 'string', required: true },
                references: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as FindValue
        if (v.entries.length === 0) return [{ type: 'text', text: 'No matching memory entries.' }]
        const lines = v.entries.map((found, index) => `${index + 1}. ${renderRecalledLine(found)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec): Promise<FindValue> {
      const cwd = exec.agent?.session.header.cwd
      const id = args.id !== undefined ? requireMemoryId(args.id) : undefined
      const entries = find(cwd, {
        ...(id !== undefined ? { id } : {}),
        ...(args.type !== undefined ? { type: args.type as MemoryType } : {}),
        ...(args.domain !== undefined ? { domain: args.domain as DomainId } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.layer !== undefined ? { layer: args.layer as LayerId } : {}),
      })
      return {
        entries: entries.map(found => ({
          id: found.entry.id,
          file: found.file,
          type: found.entry.type,
          domain: found.entry.domain,
          scope: found.entry.scope,
          layer: found.entry.layer,
          entry: found.entry.entry,
          entryPoint: found.entry.entryPoint,
          references: found.entry.references,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory-update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id to update.' },
      entry: { type: 'string', description: 'New one-sentence entry text.' },
      domain: { type: 'string', enum: [...DOMAINS], description: 'New knowledge domain.' },
      scope: { type: 'string', description: 'New impacted scope.' },
      entryPoint: { type: 'string', description: 'New associated entry-point file path.' },
      references: { type: 'string', description: 'New associated reference file path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          entry: { type: 'string', required: true },
          file: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as UpdateValue
        return [{ type: 'text', text: `Updated ${v.id}: ${v.entry} (${v.file})` }]
      },
    },
    async execute(args, exec): Promise<UpdateValue> {
      const id = requireMemoryId(args.id)
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const updated = update(cwd, id, {
        ...(args.entry !== undefined ? { entry: args.entry } : {}),
        ...(args.domain !== undefined ? { domain: args.domain as DomainId } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.entryPoint !== undefined ? { entryPoint: args.entryPoint } : {}),
        ...(args.references !== undefined ? { references: args.references } : {}),
      })
      return { id: updated.entry.id, entry: updated.entry.entry, file: updated.file }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory-delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact memory id to delete.' },
      confirm: { type: 'boolean', description: 'Required (true) when deleting a rules entry.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as DeleteValue
        return [{ type: 'text', text: v.removed ? `Deleted ${v.id}` : `No memory entry with id ${v.id}` }]
      },
    },
    async execute(args, exec): Promise<DeleteValue> {
      const id = requireMemoryId(args.id)
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const found = find(cwd, { id })
      if (found.length === 0) return { removed: false, id }
      assertDeletable(found[0]!.entry, args.confirm)
      const result = remove(cwd, id)
      return { removed: result.removed, id }
    },
  }))
}

/**
 * 插件入口:注册摘要 section、工具、设置命名空间与 `/lmemory` 命令。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  const runtime: Runtime = { state: createRuntimeState(), config: { ...DEFAULT_CONFIG }, annealing: new Map(), usage: new Map() }

  // order 10:persona(0)之后、工具指导(100–199)之前,注入已知记忆摘要。
  ctx.systemPrompt.section({
    name: 'memory:summary',
    order: 10,
    text: (assemble) => renderSummary(discoverEntries(assemble.agent?.session.header.cwd)),
  })

  registerTools(ctx, runtime)

  // 自动提取(默认开):三种触发形态(信号词 / 计数器 / 事件+计数器)旁路观测主会话。
  registerAutoExtraction(ctx, runtime)

  // settings 是可选服务;存在时接管配置读写并挂载 /lmemory。
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NAMESPACE, SCHEMA, { base: DEFAULT_CONFIG })
    runtime.config = scope.get()
    if (runtime.config.warmupOnStart) ensureTeam(runtime.state, undefined, runtime.config)
    scope.watch(next => applyConfig(runtime, next))

    ctx.commands.register({
      name: 'lmemory',
      description: 'manage long-term memory (status / stats / usage / ui / team / query / config / review)',
      input: { hint: 'status | stats | usage | ui | team start|stop|restart | query <text> | config get|set <key> [value] | review [layer|domain] | help [command]' },
      handler: invocation => handleCommand(ctx, runtime, scope, invocation),
    })

    // Web 面板(路径 B):web 模式下挂页面路由 + RPC channel;headless 时静默不存在。
    registerPanel(ctx, runtime, scope)
  })
}

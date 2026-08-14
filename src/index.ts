/**
 * dsh-memory 插件入口:把「长期记忆(Long-Term Memory)」接到 dsh 的接缝上。
 *
 * 接缝(设计文档 §2):
 *   - `ctx.tools.register` 暴露 remember / recall / forget 三个模型工具。
 *   - `ctx.llm.stream` 用 `deepseek-v4-flash` 做记忆节点 team 召回。
 *   - `ctx.systemPrompt.section` 注入「已知记忆」摘要(order 10)。
 *   - `ctx.commands.register` 提供 `/lmemory` 管理命令。
 *   - `ctx.settings` 存 maxNodeKb / recallTopK / rerankPrompt / warmupOnStart 等配置。
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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm'

import { DOMAINS, MAX_LESSON_CHARS, validateEntry } from './schema.js'
import type { MemoryEntry, MemoryType } from './schema.js'
import { renderSummary } from './render.js'
import { appendEntry, discoverEntries, forget } from './memory-file.js'
import { recall as recallTeam } from './team.js'
import type { NodeRecallFn, RerankFn } from './team.js'
import {
  CONFIG_KEYS,
  createRuntimeState,
  DEFAULT_CONFIG,
  ensureTeam,
  restartTeam,
  stopTeams,
  teamStatus,
} from './memory-runtime.js'
import type { MemoryConfig, RuntimeState, TeamStatus } from './memory-runtime.js'
import { USAGE, parseLmemoryCommand } from './command.js'

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
})

/** 召回节点 system prompt(固定,非配置项)。 */
const NODE_RECALL_SYSTEM = '你是长期记忆召回节点。给定一组记忆条目(每条一行,格式 `[类型|领域] 条目文本`)与一个查询,仅返回与查询相关的条目的「条目文本」部分,一行一条,照抄原文,不返回任何解释。无相关条目时返回空。'

/** 运行时可变状态:已预热 team + 当前配置。 */
interface Runtime {
  readonly state: RuntimeState
  config: MemoryConfig
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

/** recall 工具的规范化输出。 */
interface RecallValue {
  entries: string[]
}

/** forget 工具的规范化输出。 */
interface ForgetValue {
  removed: number
  entry: string
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

/** 用 v4-flash 发一次轻量召回调用,返回聚合文本。 */
async function callFlash(ctx: Context, config: MemoryConfig, system: string, prompt: string): Promise<string> {
  const message = createUserMessage({
    source: { kind: 'plugin', plugin: 'dsh-memory' },
    content: [{ type: 'text', text: prompt }],
  })
  let text = ''
  for await (const chunk of ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    system,
    messages: [message],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error(`memory recall call failed: ${chunk.reason.failure.message}`)
    }
  }
  return text
}

/** 执行一次召回:预热 team → fan-out → 聚合。 */
async function doRecall(ctx: Context, runtime: Runtime, cwd: string | undefined, query: string): Promise<string[]> {
  const team = ensureTeam(runtime.state, cwd, runtime.config)
  const nodeFn: NodeRecallFn = async (node, q) => {
    const response = await callFlash(ctx, runtime.config, NODE_RECALL_SYSTEM, `记忆条目:\n${node.text}\n\n查询:${q}`)
    return parseLines(response)
  }
  const rerankFn: RerankFn = async (q, candidates) => {
    const response = await callFlash(
      ctx,
      runtime.config,
      runtime.config.rerankPrompt,
      `查询:${q}\n\n候选条目:\n${candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join('\n')}`,
    )
    const ordered = parseLines(response)
    return ordered.length > 0 ? ordered : candidates
  }
  return recallTeam(team, query, nodeFn, rerankFn, runtime.config.recallTopK)
}

/** 应用新配置;容量变化时释放已预热 team 以便下次重分区。 */
function applyConfig(runtime: Runtime, next: MemoryConfig): void {
  const prev = runtime.config
  runtime.config = next
  if (next.maxNodeKb !== prev.maxNodeKb) stopTeams(runtime.state)
}

/** 渲染召回条目为多行编号文本。 */
function renderEntries(entries: readonly string[]): string {
  if (entries.length === 0) return 'No relevant memory entries.'
  return entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
}

/** 渲染 team 状态为可读文本。 */
function renderStatus(statuses: readonly TeamStatus[], config: MemoryConfig): string {
  if (statuses.length === 0) return `No warm memory team. maxNodeKb=${config.maxNodeKb}`
  const lines = statuses.map(status =>
    `  ${status.root === '' ? '(no project)' : status.root}: ${status.nodes} node(s)`)
  return `Memory team (maxNodeKb=${config.maxNodeKb}):\n${lines.join('\n')}`
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

/** 把配置命令里的原始字符串强转成对应 JS 值。 */
function coerceConfigValue(key: string, raw: string): unknown {
  if (key === 'maxNodeKb' || key === 'recallTopK') {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`)
    return value
  }
  if (key === 'warmupOnStart') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new Error('warmupOnStart must be true or false')
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
        return { kind: 'success', text: USAGE }
      case 'status':
        return { kind: 'success', text: renderStatus(teamStatus(runtime.state), runtime.config) }
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
const RECALL_DESCRIPTION = 'Recall relevant long-term memory entries for a query by fanning out to the warm memory-node team and aggregating the deduplicated, reranked results.'

/** forget 工具:精确匹配删除;rules 删除需 confirm:true。 */
const FORGET_DESCRIPTION = 'Delete a long-term memory entry by exact entry text. Deleting a "rules" entry requires confirm: true because rules are append-only.'

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
      if (args.entry.trim().length === 0) throw new Error('remember: entry must be non-empty')
      const type = args.type as MemoryType
      if (type === 'lessons' && args.entry.length > MAX_LESSON_CHARS) {
        throw new Error(`remember: lessons entry must be at most ${MAX_LESSON_CHARS} characters`)
      }
      const candidate: Record<string, unknown> = {
        type,
        domain: args.domain,
        scope: args.scope,
        layer: args.layer,
        entry: args.entry,
      }
      if (args.entryPoint !== undefined) candidate.entryPoint = args.entryPoint
      if (args.references !== undefined) candidate.references = args.references
      const entry: MemoryEntry = validateEntry(candidate)

      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      if (type === 'rules') {
        const duplicate = discoverEntries(cwd).some(existing => existing.type === 'rules' && existing.entry === entry.entry)
        if (duplicate) {
          return { remembered: true, duplicate: true, type, entry: entry.entry, jsonlPath: '-', mdPath: '-' }
        }
      }
      const { jsonlPath, mdPath } = appendEntry(cwd, entry)
      return { remembered: true, duplicate: false, type, entry: entry.entry, jsonlPath, mdPath }
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
          entries: { type: 'array', items: { type: 'string' }, required: true },
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
      const matches = discoverEntries(cwd).filter(entry =>
        entry.entry === args.entry && (type === undefined || entry.type === type))
      if (matches.some(entry => entry.type === 'rules') && args.confirm !== true) {
        throw new Error('forget: this removes a "rules" entry; call again with confirm: true to proceed.')
      }
      const removed = forget(cwd, args.entry, type)
      return { removed, entry: args.entry }
    },
  }))
}

/**
 * 插件入口:注册摘要 section、工具、设置命名空间与 `/lmemory` 命令。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  const runtime: Runtime = { state: createRuntimeState(), config: { ...DEFAULT_CONFIG } }

  // order 10:persona(0)之后、工具指导(100–199)之前,注入已知记忆摘要。
  ctx.systemPrompt.section({
    name: 'memory:summary',
    order: 10,
    text: (assemble) => renderSummary(discoverEntries(assemble.agent?.session.header.cwd)),
  })

  registerTools(ctx, runtime)

  // settings 是可选服务;存在时接管配置读写并挂载 /lmemory。
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NAMESPACE, SCHEMA, { base: DEFAULT_CONFIG })
    runtime.config = scope.get()
    if (runtime.config.warmupOnStart) ensureTeam(runtime.state, undefined, runtime.config)
    scope.watch(next => applyConfig(runtime, next))

    ctx.commands.register({
      name: 'lmemory',
      description: 'manage long-term memory (status / team / query / config)',
      input: { hint: 'status | team start|stop|restart | query <text> | config get|set <key> [value]' },
      handler: invocation => handleCommand(ctx, runtime, scope, invocation),
    })
  })
}

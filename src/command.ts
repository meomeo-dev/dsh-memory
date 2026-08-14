/**
 * `/lmemory` 命令的参数解析(纯函数)。
 *
 * 子命令:status / team start|stop|restart / query <text> / config get|set /
 * review [layer|domain]。
 * 解析只做词法切分,不校验配置键语义(交给 index.ts 的 handler)。
 * @module dsh-memory/command
 */

import { DOMAINS, LAYERS } from './schema.js'
import type { DomainId, LayerId } from './schema.js'

/** `/lmemory review` 的可选限定(按落点层或知识领域缩小质检范围)。 */
export type ReviewFilter =
  | { readonly kind: 'layer'; readonly value: LayerId }
  | { readonly kind: 'domain'; readonly value: DomainId }

/** `/lmemory` 命令的解析结果。 */
export type LmemoryCommand =
  | { readonly kind: 'help'; readonly topic?: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'stats' }
  | { readonly kind: 'usage' }
  | { readonly kind: 'team'; readonly action: 'start' | 'stop' | 'restart' }
  | { readonly kind: 'query'; readonly text: string }
  | { readonly kind: 'config-get'; readonly key?: string }
  | { readonly kind: 'config-set'; readonly key: string; readonly value: string }
  | { readonly kind: 'review'; readonly filter?: ReviewFilter }
  | { readonly kind: 'catalog' }

/** 命令用法回显文案。 */
export const USAGE = 'Usage: /lmemory status | stats | usage | team start|stop|restart | query <text> | config get|set <key> [value] | review [layer|domain] | catalog rebuild | help [command]'

/** 一条子命令的帮助详情(供 `/lmemory help [command]`)。 */
export interface CommandHelp {
  /** 一行用法(不含 `/lmemory` 前缀)。 */
  readonly usage: string
  /** 一句话说明。 */
  readonly summary: string
  /** 详细说明行(参数、行为、示例)。 */
  readonly details: readonly string[]
}

/** 全部子命令的帮助(键 = 子命令名;命令契约的单一真相源)。 */
export const COMMAND_HELPS: ReadonlyMap<string, CommandHelp> = new Map([
  ['status', {
    usage: 'status',
    summary: '查看记忆节点 team 状态(节点数、预热状态)。',
    details: [
      '行为:列出每个 project root 的已预热节点数;无预热 team 时只显示 maxNodeKb。',
      '示例:/lmemory status',
    ],
  }],
  ['stats', {
    usage: 'stats',
    summary: '记忆统计:条目数、layer / domain 分布、文件字节、catalog 条目数。',
    details: [
      '行为:纯文件读,不发模型调用;统计当前 cwd 可见的全部记忆(内置 < 用户 < 项目)。',
      '示例:/lmemory stats',
    ],
  }],
  ['usage', {
    usage: 'usage',
    summary: 'token 用量:预热 team 与 system prompt 摘要的上下文成本估算 + 本进程 LLM 调用消耗。',
    details: [
      '行为:静态部分按 chars/4 粗估;动态部分按 recall / extract / review 分类累计,仅本进程,重启归零。',
      '示例:/lmemory usage',
    ],
  }],
  ['team', {
    usage: 'team start|stop|restart',
    summary: '记忆节点 team 的生命周期管理。',
    details: [
      'start:组装(预热)team;stop:释放全部 team;restart:释放后重新组装当前项目 team。',
      '示例:/lmemory team start',
    ],
  }],
  ['query', {
    usage: 'query <text>',
    summary: '人主动召回长期记忆(fan-out 同 recall 工具,返回完整字段)。',
    details: [
      '行为:预热 team → fan-out → 按 id 去重 → 重排序 → 逆查真相源补全字段。',
      '示例:/lmemory query 依赖管理',
    ],
  }],
  ['review', {
    usage: 'review [layer|domain]',
    summary: '用 deepseek-v4-pro 质检记忆,发现矛盾/重复/过时/背离,报告注入主会话。',
    details: [
      '可选限定:layer(global / user / project)或 domain(21 枚举之一);无参质检全部可见记忆。',
      '示例:/lmemory review project',
    ],
  }],
  ['catalog', {
    usage: 'catalog rebuild',
    summary: '从全部 jsonl 重建 catalog(派生索引)。',
    details: [
      '行为:全量重写每个 memory 目录的 catalog.json;真相源仍是 jsonl。',
      '示例:/lmemory catalog rebuild',
    ],
  }],
  ['config', {
    usage: 'config get|set <key> [value]',
    summary: '读写配置项(maxNodeKb / recallTopK / extractMode / 提示词等)。',
    details: [
      'get 不带 key 列出全部配置;set 写单个键并即时生效。',
      '示例:/lmemory config get extractMode',
    ],
  }],
  ['help', {
    usage: 'help [command]',
    summary: '显示全部命令用法,或单个子命令的详细帮助。',
    details: ['示例:/lmemory help stats'],
  }],
])

/**
 * 渲染 `/lmemory help`(无 topic = 全部命令一览)或 `/lmemory help <topic>`(单命令详情)。
 * @param topic - 子命令名;缺省渲染全部命令一览。
 * @returns 帮助文本。
 */
export function renderHelp(topic?: string): string {
  if (topic === undefined) {
    const lines = [USAGE, '', 'Commands:']
    for (const [name, help] of COMMAND_HELPS) lines.push(`  ${name.padEnd(9)}${help.summary}`)
    lines.push('', '详细帮助:/lmemory help <command>')
    return lines.join('\n')
  }
  const help = COMMAND_HELPS.get(topic)
  if (help === undefined) return `Unknown command "${topic}". Run /lmemory help for the command list.`
  return [`/lmemory ${help.usage}`, '', help.summary, ...help.details.map(detail => `  ${detail}`)].join('\n')
}

/**
 * 解析 `/lmemory` 命令参数。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果;无法识别时回退为 `help`。
 */
export function parseLmemoryCommand(rawInput: string): LmemoryCommand {
  const parts = rawInput.trim().split(/\s+/).filter(part => part.length > 0)
  const head = parts[0]?.toLowerCase() ?? ''
  if (head === '' || head === 'help') {
    const topic = parts[1]?.toLowerCase()
    return topic === undefined ? { kind: 'help' } : { kind: 'help', topic }
  }
  if (head === 'status') return { kind: 'status' }
  if (head === 'stats') return { kind: 'stats' }
  if (head === 'usage') return { kind: 'usage' }
  if (head === 'team') {
    const action = parts[1]?.toLowerCase()
    if (action === 'start' || action === 'stop' || action === 'restart') return { kind: 'team', action }
    return { kind: 'help' }
  }
  if (head === 'query') {
    return { kind: 'query', text: parts.slice(1).join(' ') }
  }
  if (head === 'config') {
    const sub = parts[1]?.toLowerCase()
    if (sub === 'set' && parts[2] !== undefined && parts[3] !== undefined) {
      return { kind: 'config-set', key: parts[2]!, value: parts.slice(3).join(' ') }
    }
    if (sub === 'get') return { kind: 'config-get', key: parts[2] }
    if (sub === undefined) return { kind: 'config-get' }
    return { kind: 'help' }
  }
  if (head === 'review') {
    const token = parts[1]
    if (token === undefined) return { kind: 'review' }
    const layer = token.toLowerCase()
    if ((LAYERS as readonly string[]).includes(layer)) {
      return { kind: 'review', filter: { kind: 'layer', value: layer as LayerId } }
    }
    if ((DOMAINS as readonly string[]).includes(token)) {
      return { kind: 'review', filter: { kind: 'domain', value: token as DomainId } }
    }
    return { kind: 'help' }
  }
  if (head === 'catalog' && parts[1]?.toLowerCase() === 'rebuild') {
    return { kind: 'catalog' }
  }
  return { kind: 'help' }
}

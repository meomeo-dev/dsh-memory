/**
 * `/lmemory` 命令的参数解析(纯函数)。
 *
 * 子命令:status / team start|stop|restart / query <text> / config get|set。
 * 解析只做词法切分,不校验配置键语义(交给 index.ts 的 handler)。
 * @module dsh-memory/command
 */

/** `/lmemory` 命令的解析结果。 */
export type LmemoryCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'status' }
  | { readonly kind: 'team'; readonly action: 'start' | 'stop' | 'restart' }
  | { readonly kind: 'query'; readonly text: string }
  | { readonly kind: 'config-get'; readonly key?: string }
  | { readonly kind: 'config-set'; readonly key: string; readonly value: string }

/** 命令用法回显文案。 */
export const USAGE = 'Usage: /lmemory status | team start|stop|restart | query <text> | config get|set <key> [value]'

/**
 * 解析 `/lmemory` 命令参数。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果;无法识别时回退为 `help`。
 */
export function parseLmemoryCommand(rawInput: string): LmemoryCommand {
  const parts = rawInput.trim().split(/\s+/).filter(part => part.length > 0)
  const head = parts[0]?.toLowerCase() ?? ''
  if (head === '' || head === 'help') return { kind: 'help' }
  if (head === 'status') return { kind: 'status' }
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
  return { kind: 'help' }
}

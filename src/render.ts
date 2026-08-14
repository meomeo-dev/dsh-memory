/**
 * 长期记忆 JSONL → Markdown 投影的纯函数渲染。
 *
 * `.remember.md` 只是渲染投影(8 列 Markdown 表格:首列 id + 7 个字段),由本模块
 * 从归一化条目纯函数生成,绝不解析 Markdown。单元格内的 `|` 转义为 `\|`;system
 * prompt 注入用 {@link renderSummary} 只列条目文本,不注入整段历史。
 *
 * @module dsh-memory/render
 */

import { TABLE_HEADER, TABLE_SEPARATOR } from './schema.js'
import type { MemoryEntry } from './schema.js'

/** 把单元格文本中的 `|` 转义为 `\|`,保证表格结构不被破坏。 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 渲染一条记忆为 8 列表格行(首列 id + 7 个字段,不含首尾换行)。 */
function renderRow(entry: MemoryEntry): string {
  const cells = [
    entry.id,
    entry.type,
    entry.domain,
    entry.scope,
    entry.layer,
    escapeCell(entry.entry),
    escapeCell(entry.entryPoint),
    escapeCell(entry.references),
  ]
  return `| ${cells.join(' | ')} |`
}

/**
 * 由归一化条目渲染 8 列 Markdown 表格(表头 + 分隔行 + 每行一条)。
 * @param entries - 归一化后的记忆条目。
 * @returns 完整表格文本(末尾带一个换行)。
 */
export function renderMd(entries: readonly MemoryEntry[]): string {
  const header = `| ${TABLE_HEADER.join(' | ')} |`
  const rows = entries.map(renderRow)
  return `${[header, TABLE_SEPARATOR, ...rows].join('\n')}\n`
}

/**
 * 由归一化条目渲染 system prompt 注入用的「已知记忆」摘要(只列条目文本,
 * 非整段历史)。空集返回空串,由调用方决定是否省略该 section。
 * @param entries - 归一化后的记忆条目。
 * @returns 逐条 `- [type] entry` 的多行摘要,或空串。
 */
export function renderSummary(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return ''
  return entries.map(entry => `- [${entry.type}] ${entry.entry}`).join('\n')
}

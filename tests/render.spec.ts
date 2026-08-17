import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entryLine, escapeCell, formatCreatedAt, GLOBAL_INJECT_MAX, renderMd, renderMemorySummary, renderSummary } from '../src/render.js'
import type { MemoryEntry } from '../src/schema.js'

/** 固定创建时间,保证断言与 TZ 无关。 */
const FIXED_CREATED_AT = 1750000000000

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm-0000000000',
    schemaVersion: 2,
    createdAt: FIXED_CREATED_AT,
    type: 'rules',
    domain: 'DurablePrefs',
    scope: '全项目',
    layer: 'user',
    entry: '提交信息用 Conventional Commits',
    entryPoint: '-',
    references: '-',
    ...overrides,
  }
}

describe('escapeCell', () => {
  it('escapes pipes', () => {
    expect(escapeCell('a | b')).toBe('a \\| b')
  })

  it('leaves plain text untouched', () => {
    expect(escapeCell('plain')).toBe('plain')
  })
})

describe('entryLine', () => {
  it('renders the `[id|type|domain|scope] entry` node-text line shared by recall and review', () => {
    expect(entryLine(entry({ type: 'lessons', domain: 'PromotedPitfalls', scope: '样本库', entry: '某坑' })))
      .toBe('[m-0000000000|lessons|PromotedPitfalls|样本库] 某坑')
  })
})

describe('renderMd', () => {
  it('renders a header, separator, and one row per entry', () => {
    const md = renderMd([entry()])
    const lines = md.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('| id |')
    expect(lines[0].split(' | ')).toHaveLength(9)
    expect(lines[1]).toBe('|---|---|---|---|---|---|---|---|---|')
    expect(lines[2]).toContain('| m-0000000000 | rules | DurablePrefs |')
    expect(lines[2]).toContain(formatCreatedAt(FIXED_CREATED_AT))
  })

  it('escapes pipes inside the entry cell', () => {
    const md = renderMd([entry({ entry: '提交用 `feat|fix` 前缀' })])
    expect(md).toContain('提交用 `feat\\|fix` 前缀')
  })

  it('renders an empty table with only header and separator', () => {
    const md = renderMd([])
    expect(md.trimEnd().split('\n')).toHaveLength(2)
  })
})

describe('renderSummary', () => {
  it('lists only entry texts tagged by type', () => {
    const summary = renderSummary([entry(), entry({ type: 'lessons', entry: '某坑' })])
    expect(summary).toBe('- [rules] 提交信息用 Conventional Commits\n- [lessons] 某坑')
  })

  it('returns empty string for no entries', () => {
    expect(renderSummary([])).toBe('')
  })
})

describe('renderMemorySummary (global mode)', () => {
  const globalEntry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry =>
    entry({ id: 'm-0000000009', layer: 'global', entry: '跨项目共识', ...overrides })

  it('renders global full text (createdAt desc, id asc tiebreak) plus domain-grouped count lines', () => {
    const summary = renderMemorySummary([
      globalEntry({ id: 'm-0000000001', createdAt: 100, domain: 'Style', entry: '两空格缩进' }),
      globalEntry({ id: 'm-0000000002', createdAt: 300, domain: 'CodeFacts', entry: '更晚的条目' }),
      entry({ id: 'm-0000000003', domain: 'DurablePrefs' }),
      entry({ id: 'm-0000000004', domain: 'DurablePrefs', entry: '另一条用户记忆' }),
      entry({ id: 'm-0000000005', domain: 'Style' }),
      entry({ id: 'm-0000000006', layer: 'project', domain: 'Style', entry: '项目条目' }),
    ], 'global')
    expect(summary).toBe([
      '- [rules] 更晚的条目',
      '- [rules] 两空格缩进',
      '（用户记忆 3 条:DurablePrefs ×2,Style ×1）',
      '（当前工作区 project 记忆 1 条:Style ×1）',
    ].join('\n'))
  })

  it('caps global entries at maxInject and notes recall for the rest', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      globalEntry({ id: `m-000000000${i}`, createdAt: 500 - i, entry: `条目 ${i}` }))
    const summary = renderMemorySummary(many, 'global', 3)
    expect(summary).toBe([
      '- [rules] 条目 0',
      '- [rules] 条目 1',
      '- [rules] 条目 2',
      '（更早的 2 条 global 记忆经 recall 获取）',
    ].join('\n'))
  })

  it('degrades to count lines only with zero global entries', () => {
    const summary = renderMemorySummary([
      entry({ id: 'm-0000000001', domain: 'DurablePrefs' }),
      entry({ id: 'm-0000000002', layer: 'project', domain: 'Style' }),
    ], 'global')
    expect(summary).toBe('（用户记忆 1 条:DurablePrefs ×1）\n（当前工作区 project 记忆 1 条:Style ×1）')
  })

  it('omits the project line when there are no project entries and returns empty for all-zero', () => {
    expect(renderMemorySummary([entry({ id: 'm-0000000001' })], 'global'))
      .toBe('（用户记忆 1 条:DurablePrefs ×1）')
    expect(renderMemorySummary([], 'global')).toBe('')
  })

  it('mode=all reuses the legacy renderSummary behavior', () => {
    const entries = [entry(), globalEntry()]
    expect(renderMemorySummary(entries, 'all')).toBe(renderSummary(entries))
  })
})

describe('renderMemorySummary source contract', () => {
  it('index.ts injects through summaryText with the runtime summaryMode (4 sites, no direct renderSummary calls)', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(source).not.toContain('renderSummary(')
    expect(source.match(/summaryText\(runtime\.config/g)).toHaveLength(4)
    expect(source).toContain('text: (assemble) => summaryText(runtime.config, assemble.agent?.session.header.cwd)')
    expect(source).toContain('config.summaryMode')
  })

  it('renderSummary itself stays export-visible and unchanged for the all-mode path', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/render.ts', import.meta.url)), 'utf8')
    expect(source).toContain('export function renderSummary')
    expect(GLOBAL_INJECT_MAX).toBe(30)
  })
})

describe('formatCreatedAt', () => {
  const savedTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'UTC'
  })
  afterAll(() => {
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  it('renders epoch zero as 1970-01-01 00:00:00 under UTC', () => {
    expect(formatCreatedAt(0)).toBe('1970-01-01 00:00:00')
  })

  it('always matches the local YYYY-MM-DD HH:mm:ss shape', () => {
    expect(formatCreatedAt(FIXED_CREATED_AT)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { entryLine, escapeCell, formatCreatedAt, renderMd, renderSummary } from '../src/render.js'
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

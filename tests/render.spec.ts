import { describe, expect, it } from 'vitest'
import { escapeCell, renderMd, renderSummary } from '../src/render.js'
import type { MemoryEntry } from '../src/schema.js'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm-0000000000',
    schemaVersion: 1,
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

describe('renderMd', () => {
  it('renders a header, separator, and one row per entry', () => {
    const md = renderMd([entry()])
    const lines = md.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('| id |')
    expect(lines[0].split(' | ')).toHaveLength(8)
    expect(lines[1]).toBe('|---|---|---|---|---|---|---|---|')
    expect(lines[2]).toContain('| m-0000000000 | rules | DurablePrefs |')
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

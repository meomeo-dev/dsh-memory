import { describe, expect, it } from 'vitest'
import { checkMarkdown } from '../src/check.js'
import { renderMd } from '../src/render.js'
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

describe('checkMarkdown', () => {
  it('passes a valid rendered table', () => {
    expect(checkMarkdown(renderMd([entry()]))).toEqual([])
  })

  it('passes a table with escaped pipes', () => {
    expect(checkMarkdown(renderMd([entry({ entry: '提交用 `feat|fix` 前缀' })]))).toEqual([])
  })

  it('rejects a header with the wrong column count', () => {
    const md = '| a | b |\n|---|---|---|---|---|---|---|---|\n| a | b | c | d | e | f | g | h |'
    expect(checkMarkdown(md)).toContain('header row has 2 columns, expected 8')
  })

  it('rejects a separator row with a non-dash cell', () => {
    const header = '| a | b | c | d | e | f | g | h |'
    const md = `${header}\n|---|---|not|---|---|---|---|---|\n| a | b | c | d | e | f | g | h |`
    expect(checkMarkdown(md).some(e => e.includes('separator'))).toBe(true)
  })

  it('rejects a data row with a wrong column count', () => {
    const header = '| a | b | c | d | e | f | g | h |'
    const sep = '|---|---|---|---|---|---|---|---|'
    const md = `${header}\n${sep}\n| a | b | c | d | e | f | g | h |\n| only | four | cells | here |`
    expect(checkMarkdown(md).some(e => e.includes('data row 4'))).toBe(true)
  })

  it('rejects an unescaped pipe inside a data cell', () => {
    const header = '| a | b | c | d | e | f | g | h |'
    const sep = '|---|---|---|---|---|---|---|---|'
    const md = `${header}\n${sep}\n| a | b | c | d | e | bad||pipe | f | g |`
    expect(checkMarkdown(md).some(e => e.includes('unescaped'))).toBe(true)
  })

  it('rejects a table without a separator row', () => {
    expect(checkMarkdown('| a | b | c | d | e | f | g | h |')).toContain('table needs at least a header and a separator row')
  })
})

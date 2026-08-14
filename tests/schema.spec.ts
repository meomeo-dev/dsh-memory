import { describe, expect, it } from 'vitest'
import {
  DOMAINS,
  FILE_NAME_RE,
  MEMORY_ENTRY_SCHEMA,
  MEMORY_TYPES,
  parseEntry,
  TABLE_HEADER,
  TABLE_SEPARATOR,
  validateEntry,
} from '../src/schema.js'
import type { MemoryEntry } from '../src/schema.js'

function entry(overrides: Record<string, unknown> = {}): MemoryEntry {
  return {
    type: 'rules',
    domain: 'DurablePrefs',
    scope: 'user',
    layer: 'user',
    entry: '提交信息用 Conventional Commits',
    entryPoint: '-',
    references: '-',
    ...overrides,
  } as MemoryEntry
}

describe('contract constants', () => {
  it('lists exactly rules and lessons', () => {
    expect(MEMORY_TYPES).toEqual(['rules', 'lessons'])
  })

  it('lists exactly 21 domains', () => {
    expect(DOMAINS).toHaveLength(21)
    expect(new Set(DOMAINS).size).toBe(21)
  })

  it('exposes a 7-column header and separator', () => {
    expect(TABLE_HEADER).toHaveLength(7)
    expect(TABLE_SEPARATOR).toBe('|---|---|---|---|---|---|---|')
  })
})

describe('FILE_NAME_RE', () => {
  it('accepts a plain date rules jsonl', () => {
    expect(FILE_NAME_RE.test('2026-08-13.rules.remember.jsonl')).toBe(true)
  })

  it('accepts a partitioned lessons md', () => {
    expect(FILE_NAME_RE.test('2026-08-13.user.lessons.remember.md')).toBe(true)
  })

  it('rejects a state type and a wrong suffix', () => {
    expect(FILE_NAME_RE.test('2026-08-13.state.remember.jsonl')).toBe(false)
    expect(FILE_NAME_RE.test('2026-08-13.rules.remember.txt')).toBe(false)
    expect(FILE_NAME_RE.test('rules.remember.jsonl')).toBe(false)
  })
})

describe('validateEntry', () => {
  it('normalizes a valid entry with defaulted paths', () => {
    const result = validateEntry({
      type: 'lessons',
      domain: 'PromotedPitfalls',
      scope: 'project',
      layer: 'project',
      entry: '某 API 已改签名',
    })
    expect(result).toEqual({
      type: 'lessons',
      domain: 'PromotedPitfalls',
      scope: 'project',
      layer: 'project',
      entry: '某 API 已改签名',
      entryPoint: '-',
      references: '-',
    })
  })

  it('rejects an unknown type', () => {
    expect(() => validateEntry(entry({ type: 'state' }))).toThrow(/state|rules|lessons/i)
  })

  it('rejects an unknown domain', () => {
    expect(() => validateEntry(entry({ domain: 'NotADomain' }))).toThrow(/NotADomain|domain/i)
  })

  it('rejects an empty entry', () => {
    expect(() => validateEntry(entry({ entry: '' }))).toThrow(/entry/)
  })

  it('rejects a missing entry column', () => {
    const { entry: _entry, ...rest } = entry()
    expect(() => validateEntry(rest)).toThrow(/entry/)
  })
})

describe('parseEntry', () => {
  it('parses a valid JSON line', () => {
    const result = parseEntry('{"type":"rules","domain":"Style","scope":"user","layer":"user","entry":"两空格缩进"}', 3)
    expect(result.entryPoint).toBe('-')
    expect(result.references).toBe('-')
  })

  it('rejects invalid JSON with a line number', () => {
    expect(() => parseEntry('{not json', 7)).toThrow(/remember\.jsonl:7.*invalid JSON/)
  })

  it('rejects schema-invalid JSON with a line number', () => {
    expect(() => parseEntry('{"type":"todo"}', 2)).toThrow(/remember\.jsonl:2/)
  })
})

describe('MEMORY_ENTRY_SCHEMA.toJSON', () => {
  it('serializes to a JSON Schema object', () => {
    expect(MEMORY_ENTRY_SCHEMA.toJSON()).toBeTypeOf('object')
  })
})

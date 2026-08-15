import { describe, expect, it } from 'vitest'
import {
  DOMAINS,
  FILE_NAME_RE,
  LAYERS,
  MEMORY_ENTRY_SCHEMA,
  MEMORY_ID_RE,
  MEMORY_TYPES,
  SCHEMA_VERSION,
  generateMemoryId,
  isMemoryId,
  TABLE_HEADER,
  TABLE_SEPARATOR,
  validateEntry,
} from '../src/schema.js'
import type { MemoryEntry } from '../src/schema.js'

/** 固定创建时间,保证断言与 TZ 无关。 */
const FIXED_CREATED_AT = 1750000000000

function entry(overrides: Record<string, unknown> = {}): MemoryEntry {
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

  it('lists exactly 3 layers', () => {
    expect(LAYERS).toEqual(['global', 'user', 'project'])
  })

  it('exposes the current schema version and a 9-column header and separator', () => {
    expect(SCHEMA_VERSION).toBe(2)
    expect(TABLE_HEADER).toHaveLength(9)
    expect(TABLE_SEPARATOR).toBe('|---|---|---|---|---|---|---|---|---|')
  })
})

describe('MemoryId', () => {
  it('generates a well-formed id (m- + 10 base36)', () => {
    expect(isMemoryId(generateMemoryId())).toBe(true)
    expect(MEMORY_ID_RE.test(generateMemoryId())).toBe(true)
  })

  it('generates globally unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateMemoryId()))
    expect(ids.size).toBe(1000)
  })

  it('rejects malformed ids', () => {
    expect(isMemoryId('m-abc')).toBe(false)
    expect(isMemoryId('m-ABCDEFGHIJ')).toBe(false)
    expect(isMemoryId('x-0000000000')).toBe(false)
    expect(isMemoryId(undefined)).toBe(false)
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

describe('validateEntry (strict)', () => {
  it('accepts a complete record and defaults paths', () => {
    const result = validateEntry(entry())
    expect(result).toMatchObject({
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
    })
  })

  it('rejects a record missing an id', () => {
    const { id: _id, ...rest } = entry()
    expect(() => validateEntry(rest)).toThrow(/id/)
  })

  it('rejects a record missing a schemaVersion', () => {
    const { schemaVersion: _version, ...rest } = entry()
    expect(() => validateEntry(rest)).toThrow(/schemaVersion/)
  })

  it('rejects a record missing a createdAt', () => {
    const { createdAt: _createdAt, ...rest } = entry()
    expect(() => validateEntry(rest)).toThrow(/createdAt/)
  })

  it('rejects a non-integer createdAt', () => {
    expect(() => validateEntry(entry({ createdAt: 1.5 }))).toThrow(/createdAt|step|integer/i)
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

  it('rejects a missing type, domain, or layer column', () => {
    const { type: _type, ...noType } = entry()
    expect(() => validateEntry(noType)).toThrow(/type/)
    const { domain: _domain, ...noDomain } = entry()
    expect(() => validateEntry(noDomain)).toThrow(/domain/)
    const { layer: _layer, ...noLayer } = entry()
    expect(() => validateEntry(noLayer)).toThrow(/layer/)
  })
})

describe('MEMORY_ENTRY_SCHEMA.toJSON', () => {
  it('serializes to a JSON Schema object', () => {
    expect(MEMORY_ENTRY_SCHEMA.toJSON()).toBeTypeOf('object')
  })
})

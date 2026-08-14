import { describe, expect, it } from 'vitest'
import { assertDeletable, requireMemoryId } from '../src/tool-guard.js'
import type { MemoryEntry } from '../src/schema.js'

function entry(type: 'rules' | 'lessons'): MemoryEntry {
  return {
    id: 'm-0000000000',
    type,
    domain: 'DurablePrefs',
    scope: '全项目',
    layer: 'user',
    entry: '用 pnpm',
    entryPoint: '-',
    references: '-',
  }
}

describe('requireMemoryId', () => {
  it('returns a valid memory id unchanged', () => {
    expect(requireMemoryId('m-0000000000')).toBe('m-0000000000')
  })

  it('rejects an invalid id with a clear error', () => {
    expect(() => requireMemoryId('not-an-id')).toThrow(/invalid memory id/)
    expect(() => requireMemoryId('m-ABC')).toThrow(/invalid memory id/)
    expect(() => requireMemoryId(42)).toThrow(/invalid memory id/)
  })
})

describe('assertDeletable', () => {
  it('requires confirm:true when deleting a rules entry', () => {
    expect(() => assertDeletable(entry('rules'), undefined)).toThrow(/confirm: true/)
    expect(() => assertDeletable(entry('rules'), false)).toThrow(/confirm: true/)
  })

  it('allows a rules deletion with confirm:true and any lessons deletion', () => {
    expect(() => assertDeletable(entry('rules'), true)).not.toThrow()
    expect(() => assertDeletable(entry('lessons'), undefined)).not.toThrow()
  })
})

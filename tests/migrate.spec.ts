import { describe, expect, it } from 'vitest'
import { migrateRecord } from '../src/migrate.js'
import { isMemoryId } from '../src/schema.js'

/** v0 记录:无 id / 无 schemaVersion 的 7 字段旧行。 */
function v0(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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

describe('migrateRecord', () => {
  it('completes a v0 record (no id / schemaVersion) to schemaVersion=1 with a valid id', () => {
    const { entry, migrated } = migrateRecord(v0())
    expect(migrated).toBe(true)
    expect(entry.schemaVersion).toBe(1)
    expect(isMemoryId(entry.id)).toBe(true)
    expect(entry.entry).toBe('提交信息用 Conventional Commits')
  })

  it('passes an already-current record through without migrating', () => {
    const record = { id: 'm-0000000000', schemaVersion: 1, ...v0() }
    const { entry, migrated } = migrateRecord(record)
    expect(migrated).toBe(false)
    expect(entry.id).toBe('m-0000000000')
    expect(entry.schemaVersion).toBe(1)
  })

  it('keeps an existing id when only schemaVersion is missing', () => {
    const { entry, migrated } = migrateRecord({ id: 'm-3k9f2x8q1a', ...v0() })
    expect(migrated).toBe(true)
    expect(entry.id).toBe('m-3k9f2x8q1a')
    expect(entry.schemaVersion).toBe(1)
  })

  it('rejects data that is still invalid after migration', () => {
    expect(() => migrateRecord({ id: 'm-3k9f2x8q1a', schemaVersion: 0, type: 'rules' })).toThrow()
  })
})

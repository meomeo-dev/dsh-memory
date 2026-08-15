import { describe, expect, it } from 'vitest'
import { migrateRecord } from '../src/migrate.js'
import { isMemoryId } from '../src/schema.js'

/** v0 记录:无 id / 无 schemaVersion / 无 createdAt 的 7 字段旧行。 */
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

/** v1 记录:有 id / schemaVersion=1、无 createdAt 的旧行。 */
function v1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'm-0000000000', schemaVersion: 1, ...v0(), ...overrides }
}

/** 当前版本(v2)的完整记录。 */
function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...v1(), schemaVersion: 2, createdAt: 1750000000000, ...overrides }
}

describe('migrateRecord', () => {
  it('completes a v0 record (no id / schemaVersion) to schemaVersion=2 with a valid id and backfilled createdAt', () => {
    const { entry, migrated } = migrateRecord(v0())
    expect(migrated).toBe(true)
    expect(entry.schemaVersion).toBe(2)
    expect(isMemoryId(entry.id)).toBe(true)
    expect(entry.entry).toBe('提交信息用 Conventional Commits')
    expect(Number.isInteger(entry.createdAt)).toBe(true)
    expect(entry.createdAt).toBeGreaterThan(0)
  })

  it('passes an already-current record through without migrating', () => {
    const { entry, migrated } = migrateRecord(v2())
    expect(migrated).toBe(false)
    expect(entry.id).toBe('m-0000000000')
    expect(entry.schemaVersion).toBe(2)
    expect(entry.createdAt).toBe(1750000000000)
  })

  it('keeps an existing id when only schemaVersion is missing', () => {
    const { entry, migrated } = migrateRecord({ id: 'm-3k9f2x8q1a', ...v0() })
    expect(migrated).toBe(true)
    expect(entry.id).toBe('m-3k9f2x8q1a')
    expect(entry.schemaVersion).toBe(2)
  })

  it('rejects data that is still invalid after migration', () => {
    expect(() => migrateRecord({ id: 'm-3k9f2x8q1a', schemaVersion: 0, type: 'rules' })).toThrow()
  })
})

describe('migration 0002 createdAt backfill', () => {
  it('backfills a v1 record from the file date at local midnight', () => {
    const { entry, migrated } = migrateRecord(v1(), { fileDate: '2026-08-13', now: 1750000000000 })
    expect(migrated).toBe(true)
    expect(entry.createdAt).toBe(new Date(2026, 7, 13).getTime())
  })

  it('falls back to the migration time when the file date is missing', () => {
    const { entry } = migrateRecord(v1(), { now: 1750000000000 })
    expect(entry.createdAt).toBe(1750000000000)
  })

  it('falls back to the migration time when the file date is malformed', () => {
    const { entry } = migrateRecord(v1(), { fileDate: 'not-a-date', now: 1750000000000 })
    expect(entry.createdAt).toBe(1750000000000)
  })

  it('keeps an existing createdAt untouched (defensive idempotence)', () => {
    const { entry, migrated } = migrateRecord(v1({ createdAt: 123456 }), { fileDate: '2026-08-13', now: 1750000000000 })
    expect(migrated).toBe(true)
    expect(entry.schemaVersion).toBe(2)
    expect(entry.createdAt).toBe(123456)
  })
})

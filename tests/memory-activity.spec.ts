import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVITY_BUCKET_MS,
  ACTIVITY_WINDOW_MS,
  activityKey,
  activityLevel,
  aggregateEntryActivity,
  formatActivityCount,
} from '../src/memory-activity.js'

let dirs: string[] = []

beforeEach(() => {
  dirs = [mkdtempSync(join(tmpdir(), 'dsh-memory-activity-a-')), mkdtempSync(join(tmpdir(), 'dsh-memory-activity-b-'))]
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 一条 v2 条目行。 */
function row(id: string, createdAt: number, type: string, domain: string): string {
  return JSON.stringify({ id, schemaVersion: 2, createdAt, type, domain, scope: '全项目', layer: 'project', entry: '条目', entryPoint: '-', references: '-' })
}

describe('aggregateEntryActivity', () => {
  it('builds 24 buckets of 1 hour over the last 24 hours', () => {
    const now = new Date(2026, 7, 15, 12, 0, 0).getTime()
    const activity = aggregateEntryActivity(dirs, now)
    expect(activity.windowStart).toBe(now - ACTIVITY_WINDOW_MS)
    expect(activity.windowEnd).toBe(now)
    expect(activity.bucketMinutes).toBe(60)
    expect(activity.buckets).toHaveLength(24)
    expect(activity.buckets[0]!.start).toBe(now - ACTIVITY_WINDOW_MS)
    expect(activity.buckets[23]!.start).toBe(now - ACTIVITY_WINDOW_MS + 23 * ACTIVITY_BUCKET_MS)
  })

  it('buckets entries by createdAt across dirs and key type/domain', () => {
    const now = new Date(2026, 7, 15, 12, 0, 0).getTime()
    const bucketStart = now - ACTIVITY_WINDOW_MS + 3 * ACTIVITY_BUCKET_MS
    writeFileSync(join(dirs[0]!, '2026-08-15.rules.remember.jsonl'), [
      row('m-0000000001', bucketStart + 1000, 'rules', 'Style'),
      row('m-0000000002', bucketStart + 2000, 'rules', 'Style'),
      row('m-0000000003', bucketStart + 3000, 'lessons', 'PastFixes'),
    ].join('\n') + '\n')
    writeFileSync(join(dirs[1]!, '2026-08-15.rules.remember.jsonl'), [
      row('m-0000000004', bucketStart + 4000, 'rules', 'Style'),
    ].join('\n') + '\n')

    const activity = aggregateEntryActivity(dirs, now)
    expect(activity.buckets[3]!.counts).toEqual({ 'rules/Style': 3, 'lessons/PastFixes': 1 })
    expect(activity.buckets[4]!.counts).toEqual({})
  })

  it('drops entries outside the window and future timestamps', () => {
    const now = new Date(2026, 7, 15, 12, 0, 0).getTime()
    writeFileSync(join(dirs[0]!, '2026-08-15.rules.remember.jsonl'), [
      row('m-0000000001', now - ACTIVITY_WINDOW_MS - 1, 'rules', 'Style'),
      row('m-0000000002', now + 1, 'rules', 'Style'),
      row('m-0000000003', now - 60_000, 'rules', 'Style'),
    ].join('\n') + '\n')

    const activity = aggregateEntryActivity(dirs, now)
    const total = activity.buckets.reduce((sum, bucket) => sum + (bucket.counts[activityKey('rules', 'Style')] ?? 0), 0)
    expect(total).toBe(1)
  })

  it('skips missing dirs and dedupes duplicate dir paths', () => {
    const now = new Date(2026, 7, 15, 12, 0, 0).getTime()
    writeFileSync(join(dirs[0]!, '2026-08-15.rules.remember.jsonl'), `${row('m-0000000001', now - 60_000, 'rules', 'Style')}\n`)
    const activity = aggregateEntryActivity([dirs[0]!, dirs[0]!, join(tmpdir(), 'nope')], now)
    const total = activity.buckets.reduce((sum, bucket) => sum + (bucket.counts[activityKey('rules', 'Style')] ?? 0), 0)
    expect(total).toBe(1)
  })
})

describe('formatActivityCount', () => {
  it('shows raw values up to 999 and magnitude-capped 99N above', () => {
    expect(formatActivityCount(0)).toBe('0')
    expect(formatActivityCount(999)).toBe('999')
    expect(formatActivityCount(1000)).toBe('99K')
    expect(formatActivityCount(1_234_567)).toBe('99M')
    expect(formatActivityCount(1e9)).toBe('99G')
    expect(formatActivityCount(1e12)).toBe('99B')
    expect(formatActivityCount(1e15)).toBe('99T')
  })
})

describe('activityLevel', () => {
  it('maps counts to 5 intensity levels', () => {
    expect(activityLevel(0)).toBe(0)
    expect(activityLevel(2)).toBe(1)
    expect(activityLevel(3)).toBe(2)
    expect(activityLevel(99)).toBe(3)
    expect(activityLevel(100)).toBe(4)
  })
})

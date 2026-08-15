import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateByDay, aggregateWindowTotals, appendUsageRow, localDay, readUsageRows, recentDays, usageLogPath } from '../src/usage-log.js'
import type { UsageLogRow } from '../src/usage-log.js'

let dshHome: string
const saved = process.env.DSH_HOME

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-usage-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
})

function row(ts: number, overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return { ts, label: 'recall', inputTokens: 100, outputTokens: 50, cacheReadTokens: 25, ...overrides }
}

describe('usage log file', () => {
  it('appends rows and reads them back in order', () => {
    const ts = 1750000000000
    expect(appendUsageRow(row(ts))).toBe(true)
    appendUsageRow(row(ts + 1, { label: 'extract', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }))
    const rows = readUsageRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ ts, label: 'recall', inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 })
    expect(rows[1]!.label).toBe('extract')
    expect(rows[1]!.cacheReadTokens).toBe(0)
  })

  it('returns empty when the log is missing and skips corrupt lines', () => {
    expect(readUsageRows()).toHaveLength(0)
    // 首行坏、次行合法、末行坏。
    mkdirSync(join(dshHome, 'lmemory'), { recursive: true })
    writeFileSync(usageLogPath(), `{bad json\n${JSON.stringify(row(1750000000000))}\n{"ts":1,"label":"nope","inputTokens":1,"outputTokens":1}\n`, 'utf8')
    const rows = readUsageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('recall')
  })
})

describe('localDay / recentDays', () => {
  it('formats local date keys', () => {
    // 本地零点构造,避免 TZ 漂移。
    const localMidnight = new Date(2026, 7, 14).getTime()
    expect(localDay(localMidnight)).toBe('2026-08-14')
  })

  it('lists the last N days ascending, including today', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const days = recentDays(3, now)
    expect(days).toEqual(['2026-08-12', '2026-08-13', '2026-08-14'])
  })
})

describe('aggregateByDay', () => {
  it('buckets rows per local day and zero-fills missing days', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const d0 = new Date(2026, 7, 14, 9, 0, 0).getTime()
    const d1 = new Date(2026, 7, 13, 9, 0, 0).getTime()
    const rows = [
      row(d0),
      row(d0, { label: 'review', inputTokens: 8, outputTokens: 4, cacheReadTokens: 0 }),
      row(d1, { label: 'extract', inputTokens: 20, outputTokens: 10, cacheReadTokens: 5 }),
    ]
    const daily = aggregateByDay(rows, 3, now)
    expect(daily.map(day => day.day)).toEqual(['2026-08-12', '2026-08-13', '2026-08-14'])
    // 8-14:recall 1 次 + review 1 次,总计 175 + 12 = 187。
    expect(daily[2]!.recall.calls).toBe(1)
    expect(daily[2]!.review.calls).toBe(1)
    expect(daily[2]!.total).toBe(187)
    // 8-13:extract 1 次 35 tokens。
    expect(daily[1]!.extract.totalTokens).toBe(35)
    expect(daily[1]!.total).toBe(35)
    // 8-12:零填充。
    expect(daily[0]!.total).toBe(0)
    expect(daily[0]!.recall.calls).toBe(0)
  })

  it('drops rows outside the window', () => {
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const old = new Date(2026, 7, 1, 9, 0, 0).getTime()
    const daily = aggregateByDay([row(old)], 3, now)
    expect(daily.reduce((sum, day) => sum + day.total, 0)).toBe(0)
  })
})

describe('aggregateWindowTotals', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
  const d0 = new Date(2026, 7, 14, 9, 0, 0).getTime()
  const d1 = new Date(2026, 7, 13, 9, 0, 0).getTime()
  const rows = [
    row(d0),
    row(d0, { label: 'review', inputTokens: 8, outputTokens: 4, cacheReadTokens: 0 }),
    row(d1, { label: 'extract', inputTokens: 20, outputTokens: 10, cacheReadTokens: 5 }),
  ]

  it('aggregates per label over the window, identical to summing daily buckets', () => {
    const totals = aggregateWindowTotals(rows, 3, now)
    expect(totals.map(total => total.label)).toEqual(['recall', 'extract', 'review'])

    const recall = totals[0]!
    expect(recall.calls).toBe(1)
    expect(recall.inputTokens).toBe(100)
    expect(recall.totalTokens).toBe(175)
    const extract = totals[1]!
    expect(extract.calls).toBe(1)
    expect(extract.totalTokens).toBe(35)
    const review = totals[2]!
    expect(review.calls).toBe(1)
    expect(review.totalTokens).toBe(12)

    // 对账恒等:窗口合计 = 每日聚合求和(状态页甜甜圈合计与每日柱合计的对账基础)。
    const daily = aggregateByDay(rows, 3, now)
    for (const total of totals) {
      const fromDaily = daily.reduce((sum, day) => sum + day[total.label].totalTokens, 0)
      expect(total.totalTokens).toBe(fromDaily)
    }
    expect(totals.reduce((sum, total) => sum + total.totalTokens, 0)).toBe(175 + 35 + 12)
  })

  it('returns zero totals for an empty window', () => {
    const totals = aggregateWindowTotals([], 14, now)
    expect(totals).toHaveLength(3)
    for (const total of totals) {
      expect(total.calls).toBe(0)
      expect(total.totalTokens).toBe(0)
    }
  })
})

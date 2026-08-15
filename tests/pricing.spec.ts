import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  beijingTime,
  costFor,
  estimateDailyCosts,
  estimateHourlyCosts,
  estimateWindowCosts,
  isPeakBeijing,
  loadPricing,
  priceEntryFor,
  pricingPath,
  pricesAt,
  seedPricing,
} from '../src/pricing.js'
import type { UsageLogRow } from '../src/usage-log.js'

let dshHome: string
const saved = process.env.DSH_HOME

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-pricing-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
})

/** 2026-08-17 00:00 北京时间 → UTC。 */
const CHANGE = Date.UTC(2026, 7, 16, 16, 0, 0)
/** 2026-05-31 00:00 北京时间 → UTC。 */
const V4PRO_FLAT = Date.UTC(2026, 4, 30, 16, 0, 0)

function row(ts: number, overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return { ts, label: 'recall', inputTokens: 100, outputTokens: 50, cacheReadTokens: 25, ...overrides }
}

describe('beijing time conversion', () => {
  it('converts announced Beijing midnight to UTC epoch', () => {
    expect(beijingTime(2026, 8, 17)).toBe(CHANGE)
    expect(beijingTime(2026, 5, 31)).toBe(V4PRO_FLAT)
    // 2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC。
    expect(CHANGE).toBe(Date.UTC(2026, 7, 16, 16, 0, 0))
  })
})

describe('peak windows (Beijing)', () => {
  it('peaks at Beijing 9:00-12:00 and 14:00-18:00, off-peak elsewhere', () => {
    // 北京 09:00 = UTC 01:00;11:59 高峰;12:00 起空闲;13:59 空闲;14:00 高峰;17:59 高峰;18:00 空闲。
    const cases: Array<[number, boolean]> = [
      [Date.UTC(2026, 7, 17, 0, 59), false],
      [Date.UTC(2026, 7, 17, 1, 0), true],
      [Date.UTC(2026, 7, 17, 3, 59), true],
      [Date.UTC(2026, 7, 17, 4, 0), false],
      [Date.UTC(2026, 7, 17, 5, 59), false],
      [Date.UTC(2026, 7, 17, 6, 0), true],
      [Date.UTC(2026, 7, 17, 9, 59), true],
      [Date.UTC(2026, 7, 17, 10, 0), false],
      [Date.UTC(2026, 7, 17, 15, 30), false],
    ]
    for (const [ts, peak] of cases) expect(isPeakBeijing(ts)).toBe(peak)
  })
})

describe('price entry lookup', () => {
  it('picks the latest period with effectiveFrom <= ts, falling back to the earliest', () => {
    const table = seedPricing(0)
    // v4-flash 调价前 → 现行价;调价后 → 新基础价;很早 → 回退最早一条(现行价)。
    expect(priceEntryFor(table, 'deepseek-v4-flash', CHANGE - 1)?.prices.inputPerMTok).toBe(1)
    expect(priceEntryFor(table, 'deepseek-v4-flash', CHANGE)?.prices.inputPerMTok).toBe(1.5)
    expect(priceEntryFor(table, 'deepseek-v4-flash', 0)?.prices.inputPerMTok).toBe(1)
    // v4-pro:5/31 前回退现行价(3),5/31 后现行价,8/17 后空闲 4.5 / 高峰 9。
    expect(priceEntryFor(table, 'deepseek-v4-pro', V4PRO_FLAT - 1)?.prices.inputPerMTok).toBe(3)
    expect(pricesAt(priceEntryFor(table, 'deepseek-v4-pro', CHANGE + 3600_000)!, CHANGE + 3600_000).inputPerMTok).toBe(4.5)
    expect(pricesAt(priceEntryFor(table, 'deepseek-v4-pro', Date.UTC(2026, 7, 17, 1, 0))!, Date.UTC(2026, 7, 17, 1, 0)).inputPerMTok).toBe(9)
    // 无记录模型 → undefined。
    expect(priceEntryFor(table, 'unknown-model', CHANGE)).toBeUndefined()
  })
})

describe('cost estimation', () => {
  it('computes cost = input×input + cacheRead×cacheHit + output×output (CNY per 1M)', () => {
    const table = seedPricing(0)
    // v4-flash 现行价:input 1 / cacheHit 0.02 / output 2。
    const cost = costFor(table, 'deepseek-v4-flash', CHANGE - 1, 1_000_000, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(1 + 0.02 + 2, 10)
    // 峰价:v4-pro 高峰 input 9 / cacheHit 0.3 / output 27。
    const peakTs = Date.UTC(2026, 7, 17, 1, 0)
    const peakCost = costFor(table, 'deepseek-v4-pro', peakTs, 500_000, 500_000, 500_000)
    expect(peakCost).toBeCloseTo(0.5 * 9 + 0.5 * 0.3 + 0.5 * 27, 10)
    // 无价格记录 → undefined(不静默为 0)。
    expect(costFor(table, 'unknown-model', CHANGE, 1, 1, 1)).toBeUndefined()
  })

  it('aggregates window costs per label with model fallback for legacy rows', () => {
    const table = seedPricing(0)
    const now = CHANGE + 24 * 3600_000
    const rows: UsageLogRow[] = [
      // 新行带 model:调价后 v4-flash 空闲价(1.5/0.05/4.5)。
      row(now - 3600_000, { label: 'extract', model: 'deepseek-v4-flash', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      // 旧行无 model:review → 回退 reviewModel 映射。
      row(now - 2 * 3600_000, { label: 'review', inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
      // 缺价模型的行。
      row(now - 3 * 3600_000, { label: 'recall', model: 'unknown-model' }),
    ]
    const fallback = (label: UsageLogRow['label']): string => label === 'review' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
    const costs = estimateWindowCosts(table, rows, 14, fallback, now)

    const extract = costs.perLabel.find(entry => entry.label === 'extract')!
    expect(extract.yuan).toBeCloseTo(1.5, 10)
    expect(extract.missingPricingRows).toBe(0)
    const review = costs.perLabel.find(entry => entry.label === 'review')!
    expect(review.yuan).toBeCloseTo(13.5, 10) // 调价后 v4-pro 空闲输出 13.5
    const recall = costs.perLabel.find(entry => entry.label === 'recall')!
    expect(recall.yuan).toBeUndefined()
    expect(recall.missingPricingRows).toBe(1)
    expect(costs.incomplete).toBe(true)
    expect(costs.totalYuan).toBeCloseTo(1.5 + 13.5, 10)
  })

  it('estimation is pure: never writes anything to the pricing/usage files', () => {
    const table = seedPricing(0)
    const rows = [row(Date.now(), { model: 'deepseek-v4-flash' })]
    const before = new Set(readdirSync(dshHome))
    estimateWindowCosts(table, rows, 14, () => 'deepseek-v4-flash')
    const after = new Set(readdirSync(dshHome))
    expect([...after].filter(name => !before.has(name))).toEqual([])
  })

  it('estimateDailyCosts: per-day costs zero-filled, missing-price days marked', () => {
    const table = seedPricing(0)
    // 本地中午参照;行落在本地今天 09:00 与昨天 09:00(本地时区)。
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const t0 = new Date(2026, 7, 14, 9, 0, 0).getTime()
    const t1 = new Date(2026, 7, 13, 9, 0, 0).getTime()
    const rows: UsageLogRow[] = [
      row(t0, { model: 'deepseek-v4-flash', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      row(t1, { model: 'unknown-model' }),
    ]
    const fallback = (): string => 'deepseek-v4-flash'
    const daily = estimateDailyCosts(table, rows, 2, fallback, now)
    expect(daily.map(entry => entry.day)).toEqual(['2026-08-13', '2026-08-14'])
    // 今天:现行价 1 元/M input → 1 元。
    expect(daily[1]!.yuan).toBeCloseTo(1, 10)
    expect(daily[1]!.missingPricingRows).toBe(0)
    // 昨天:缺价行 → yuan undefined + missing。
    expect(daily[0]!.yuan).toBeUndefined()
    expect(daily[0]!.missingPricingRows).toBe(1)
  })

  it('estimateHourlyCosts: per-hour costs zero-filled, aligned with aggregateByHour buckets', () => {
    const table = seedPricing(0)
    const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
    const t0 = new Date(2026, 7, 14, 9, 30, 0).getTime()
    const t1 = new Date(2026, 7, 14, 10, 15, 0).getTime()
    const rows: UsageLogRow[] = [
      row(t0, { model: 'deepseek-v4-flash', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      row(t1, { model: 'unknown-model' }),
    ]
    const hourly = estimateHourlyCosts(table, rows, 2, () => 'deepseek-v4-flash', now)
    expect(hourly).toHaveLength(48)
    expect(hourly[0]).toMatchObject({ day: '2026-08-13', hour: 0, yuan: 0, missingPricingRows: 0 })
    const b9 = hourly.find(bucket => bucket.day === '2026-08-14' && bucket.hour === 9)!
    expect(b9.yuan).toBeCloseTo(1, 10)
    const b10 = hourly.find(bucket => bucket.day === '2026-08-14' && bucket.hour === 10)!
    expect(b10.yuan).toBeUndefined()
    expect(b10.missingPricingRows).toBe(1)
  })
})

describe('pricing.json load', () => {
  it('seeds the table when the file is missing and never overwrites existing content', () => {
    const first = loadPricing(0)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.table.periods).toHaveLength(4)
      expect(existsSync(pricingPath())).toBe(true)
    }
    // 用户修改后重读:不覆盖。
    const edited = JSON.parse(readFileSync(pricingPath(), 'utf8')) as { periods: unknown[] }
    edited.periods.pop()
    writeFileSync(pricingPath(), `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
    const again = loadPricing(0)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.table.periods).toHaveLength(3)
  })

  it('fails loud on corrupt or malformed content', () => {
    mkdirSync(join(dshHome, 'lmemory'), { recursive: true })
    writeFileSync(pricingPath(), '{not json', 'utf8')
    expect(loadPricing(0).ok).toBe(false)
    writeFileSync(pricingPath(), JSON.stringify({ formatVersion: 99 }), 'utf8')
    expect(loadPricing(0).ok).toBe(false)
    writeFileSync(pricingPath(), JSON.stringify({ formatVersion: 1, currency: 'CNY', updatedAt: 0, periods: [{ model: 'x', effectiveFrom: 0, source: 's', prices: { inputPerMTok: -1, cacheHitPerMTok: 0, outputPerMTok: 0 } }] }), 'utf8')
    expect(loadPricing(0).ok).toBe(false)
  })
})

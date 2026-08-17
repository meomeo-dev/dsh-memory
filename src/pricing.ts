/**
 * 价格表与成本估算:`~/.dsh/lmemory/pricing.json`(纯逻辑,不 import cordis)。
 * 设计见 docs/pricing-and-cost.md。
 *
 * 模型 API 只返回 usage 不返回 cost;官方价格随时段变化(调价提前公告生效日期、
 * 峰谷定价)。价格表是**唯一持久化事实**(缺失时用内置种子创建,绝不覆盖用户
 * 修改);cost 一律即时计算、绝不落盘——价格表一改,历史成本自动重算。
 *
 * @module dsh-memory/pricing
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './memory-file.js'
import { localDay, recentDays } from './usage-log.js'
import type { UsageLogRow } from './usage-log.js'
import { GLOBAL_PROMOTE_MAX } from './global-gate.js'
import { estimateTokens } from './stats.js'

/** 价格表格式版本(结构变化时递增;读取端只认格式,不认识视为损坏)。 */
export const PRICING_FORMAT_VERSION = 1

/** 每百万 tokens 的价格(元,CNY)。 */
export interface TokenPrices {
  /** 缓存未命中输入(标准输入价)。 */
  readonly inputPerMTok: number
  /** 缓存命中输入。 */
  readonly cacheHitPerMTok: number
  /** 输出。 */
  readonly outputPerMTok: number
}

/** 一个模型在一个生效时段的价格记录。 */
export interface PricingPeriod {
  /** 模型 id(与配置的 model / reviewModel 同值)。 */
  readonly model: string
  /** 生效起始时刻(epoch 毫秒,UTC;北京时刻见 source 注释)。0 = 起始时间未公告,自最早使用起计。 */
  readonly effectiveFrom: number
  /** 价格来源与生效时刻说明(人读)。 */
  readonly source: string
  /** 基础价(峰谷期的空闲价)。 */
  readonly prices: TokenPrices
  /** 高峰价;存在 = 该时段启用峰谷。 */
  readonly peakPrices?: TokenPrices
  /** 高峰窗口(北京小时区间 [起,止);缺省 9-12 / 14-18)。 */
  readonly peakWindowsBeijing?: readonly (readonly [number, number])[]
}

/** 价格表文档(pricing.json 全文)。 */
export interface PricingTable {
  /** 格式版本。 */
  readonly formatVersion: number
  /** 币种(官方页人民币口径)。 */
  readonly currency: 'CNY'
  /** 最近一次写入时间(epoch 毫秒)。 */
  readonly updatedAt: number
  /** 全部价格时段(按模型 + effectiveFrom 升序,种子即此序)。 */
  readonly periods: readonly PricingPeriod[]
}

/** 价格表读取结果:损坏时报错(价格错误比没有价格更糟,fail loud)。 */
export type PricingLoad = { ok: true; table: PricingTable } | { ok: false; error: string }

/** pricing.json 的固定路径(用户 lmemory 根内)。 */
export function pricingPath(): string {
  return join(dshHome(), 'lmemory', 'pricing.json')
}

/** 北京时刻 → epoch 毫秒(所有生效时间按 UTC+8 公告换算)。 */
export function beijingTime(year: number, month: number, day: number, hour = 0): number {
  return Date.UTC(year, month - 1, day, hour) - 8 * 3600_000
}

/** 默认高峰窗口(北京 9:00–12:00、14:00–18:00)。 */
export const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]] as const

/** 内置种子价格表(来源见 docs/pricing-and-cost.md「来源」;缺失时惰性创建)。 */
export function seedPricing(now: number = Date.now()): PricingTable {
  return {
    formatVersion: PRICING_FORMAT_VERSION,
    currency: 'CNY',
    updatedAt: now,
    periods: [
      {
        model: 'deepseek-v4-flash',
        effectiveFrom: 0,
        source: '官方定价页(2026-08-15 抓取);起始时间未公告',
        prices: { inputPerMTok: 1, cacheHitPerMTok: 0.02, outputPerMTok: 2 },
      },
      {
        model: 'deepseek-v4-flash',
        effectiveFrom: beijingTime(2026, 8, 17),
        source: '2026-08-13 公告,2026-08-17 00:00 北京时间生效',
        prices: { inputPerMTok: 1.5, cacheHitPerMTok: 0.05, outputPerMTok: 4.5 },
        peakPrices: { inputPerMTok: 3, cacheHitPerMTok: 0.1, outputPerMTok: 9 },
      },
      {
        model: 'deepseek-v4-pro',
        effectiveFrom: beijingTime(2026, 5, 31),
        source: '2026-05-22 公告「2.5 折永久化」,2026-05-31 00:00 北京时间起永久生效',
        prices: { inputPerMTok: 3, cacheHitPerMTok: 0.025, outputPerMTok: 6 },
      },
      {
        model: 'deepseek-v4-pro',
        effectiveFrom: beijingTime(2026, 8, 17),
        source: '2026-08-13 公告,2026-08-17 00:00 北京时间生效',
        prices: { inputPerMTok: 4.5, cacheHitPerMTok: 0.15, outputPerMTok: 13.5 },
        peakPrices: { inputPerMTok: 9, cacheHitPerMTok: 0.3, outputPerMTok: 27 },
      },
    ],
  }
}

/** 校验单个价格时段(数字字段必须为有限非负数;缺省峰谷窗口补默认)。 */
function parsePeriod(raw: unknown): PricingPeriod | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.model !== 'string' || value.model.length === 0) return undefined
  if (typeof value.effectiveFrom !== 'number' || typeof value.source !== 'string') return undefined
  const prices = parsePrices(value.prices)
  if (prices === undefined) return undefined
  const peak = value.peakPrices === undefined ? undefined : parsePrices(value.peakPrices)
  if (value.peakPrices !== undefined && peak === undefined) return undefined
  let windows: [number, number][] | undefined
  if (value.peakWindowsBeijing !== undefined) {
    if (!Array.isArray(value.peakWindowsBeijing)) return undefined
    windows = []
    for (const entry of value.peakWindowsBeijing) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'number') return undefined
      windows.push([entry[0], entry[1]])
    }
  }
  return {
    model: value.model,
    effectiveFrom: value.effectiveFrom,
    source: value.source,
    prices,
    ...(peak !== undefined ? { peakPrices: peak } : {}),
    ...(windows !== undefined ? { peakWindowsBeijing: windows } : {}),
  }
}

/** 校验一组三档价格(有限非负数;元/百万 tokens)。 */
function parsePrices(raw: unknown): TokenPrices | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { inputPerMTok, cacheHitPerMTok, outputPerMTok } = raw as Record<string, unknown>
  if (typeof inputPerMTok !== 'number' || typeof cacheHitPerMTok !== 'number' || typeof outputPerMTok !== 'number') return undefined
  if (![inputPerMTok, cacheHitPerMTok, outputPerMTok].every(value => Number.isFinite(value) && value >= 0)) return undefined
  return { inputPerMTok, cacheHitPerMTok, outputPerMTok }
}

/**
 * 读取价格表;文件缺失时用内置种子创建(绝不覆盖已存在的用户修改)。
 * @param now - 种子写入时刻(测试注入)。
 * @returns 读取结果(损坏 → ok:false + 原因)。
 */
export function loadPricing(now: number = Date.now()): PricingLoad {
  const path = pricingPath()
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(seedPricing(now), null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, error: `cannot create pricing file: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof doc !== 'object' || doc === null) return { ok: false, error: 'pricing.json is not an object' }
    const { formatVersion, currency, updatedAt, periods } = doc as Record<string, unknown>
    if (formatVersion !== PRICING_FORMAT_VERSION || currency !== 'CNY' || !Array.isArray(periods)) {
      return { ok: false, error: 'pricing.json format mismatch (formatVersion/currency/periods)' }
    }
    const parsed: PricingPeriod[] = []
    for (const entry of periods) {
      const period = parsePeriod(entry)
      if (period === undefined) return { ok: false, error: 'pricing.json contains an invalid period entry' }
      parsed.push(period)
    }
    return { ok: true, table: { formatVersion: PRICING_FORMAT_VERSION, currency: 'CNY', updatedAt: typeof updatedAt === 'number' ? updatedAt : 0, periods: parsed } }
  } catch (error) {
    return { ok: false, error: `pricing.json parse failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 找一条价格记录:该模型下 `effectiveFrom <= ts` 的最新一条;没有则回退该模型
 * 最早一条(覆盖「起始时间未公告」的时段);模型完全无记录返回 undefined。
 * @param table - 价格表。
 * @param model - 模型 id。
 * @param ts - usage 行时刻(epoch 毫秒)。
 * @returns 价格时段(可能为回退项)。
 */
export function priceEntryFor(table: PricingTable, model: string, ts: number): PricingPeriod | undefined {
  const entries = table.periods.filter(period => period.model === model).sort((a, b) => a.effectiveFrom - b.effectiveFrom)
  if (entries.length === 0) return undefined
  let selected = entries[0]!
  for (const entry of entries) {
    if (entry.effectiveFrom <= ts) selected = entry
    else break
  }
  return selected
}

/** 判断时刻是否落在北京高峰窗口(缺省 9:00–12:00、14:00–18:00;半开区间)。 */
export function isPeakBeijing(ts: number, windows: readonly (readonly [number, number])[] = DEFAULT_PEAK_WINDOWS): boolean {
  const hour = new Date(ts + 8 * 3600_000).getUTCHours()
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 按时刻选三档单价(峰谷时段判北京高峰窗口)。 */
export function pricesAt(period: PricingPeriod, ts: number): TokenPrices {
  if (period.peakPrices === undefined) return period.prices
  return isPeakBeijing(ts, period.peakWindowsBeijing ?? DEFAULT_PEAK_WINDOWS) ? period.peakPrices : period.prices
}

/**
 * 估算一次调用的成本(元):input×输入价 + cacheRead×缓存命中价 + output×输出价。
 * @param table - 价格表。
 * @param model - 模型 id。
 * @param ts - 调用时刻。
 * @param inputTokens - 缓存未命中输入 token。
 * @param cacheReadTokens - 缓存命中输入 token。
 * @param outputTokens - 输出 token。
 * @returns 成本(元);模型无价格记录返回 undefined。
 */
export function costFor(
  table: PricingTable,
  model: string,
  ts: number,
  inputTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): number | undefined {
  const entry = priceEntryFor(table, model, ts)
  if (entry === undefined) return undefined
  const prices = pricesAt(entry, ts)
  return (inputTokens * prices.inputPerMTok + cacheReadTokens * prices.cacheHitPerMTok + outputTokens * prices.outputPerMTok) / 1_000_000
}

/** 某职责的窗口成本聚合(面板「估算成本」列;yuan 为 undefined = 该职责存在缺价行,不静默为 0)。 */
export interface LabelCost {
  /** 职责分类。 */
  readonly label: UsageLogRow['label']
  /** 窗口内调用次数。 */
  readonly calls: number
  /** 窗口内估算成本(元,两位小数展示);缺价时为 undefined。 */
  readonly yuan?: number
  /** 该职责缺价(无价格记录)的调用行数。 */
  readonly missingPricingRows: number
}

/** 窗口成本聚合(近 N 天,与 totals/daily 同窗)。 */
export interface WindowCosts {
  /** 按职责的成本。 */
  readonly perLabel: readonly LabelCost[]
  /** 可计算部分的合计(元);缺价职责不计入,见 incomplete。 */
  readonly totalYuan: number
  /** 是否因缺价而不完整。 */
  readonly incomplete: boolean
}

/** 由 label 决定旧行(无 model)回退到哪个模型 id。 */
export type ModelFallback = (label: UsageLogRow['label']) => string

/**
 * 聚合近 `days` 天 usage 行的估算成本(不落盘,纯计算)。
 *
 * 旧行(无 model)按 {@link ModelFallback} 映射到当前配置模型;模型无价格记录的
 * 行计缺价,该职责 yuan 置 undefined 而不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 窗口成本聚合。
 */
export function estimateWindowCosts(
  table: PricingTable,
  rows: readonly UsageLogRow[],
  days: number,
  fallback: ModelFallback,
  now: number = Date.now(),
): WindowCosts {
  const cutoff = now - days * 24 * 3600_000
  const windowRows = rows.filter(row => row.ts >= cutoff)
  const perLabel: LabelCost[] = []
  let totalYuan = 0
  let incomplete = false
  for (const label of ['recall', 'extract', 'review'] as const) {
    const labelRows = windowRows.filter(row => row.label === label)
    let yuan = 0
    let missingPricingRows = 0
    for (const row of labelRows) {
      const model = row.model ?? fallback(label)
      const cost = costFor(table, model, row.ts, row.inputTokens, row.cacheReadTokens, row.outputTokens)
      if (cost === undefined) missingPricingRows += 1
      else yuan += cost
    }
    if (missingPricingRows > 0) {
      incomplete = true
      perLabel.push({ label, calls: labelRows.length, missingPricingRows })
    } else {
      totalYuan += yuan
      perLabel.push({ label, calls: labelRows.length, yuan, missingPricingRows: 0 })
    }
  }
  // 合计恒返回可计算部分(缺价职责另计 missingPricingRows);incomplete 标记完整性。
  return { perLabel, totalYuan, incomplete }
}

/** 某一天的估算成本(yuan 为 undefined = 该天存在缺价行;空天 yuan = 0)。 */
export interface DayCost {
  /** 本地日期 `YYYY-MM-DD`(与 aggregateByDay 同日序)。 */
  readonly day: string
  /** 当天估算成本(元);缺价时为 undefined。 */
  readonly yuan?: number
  /** 当天缺价(无价格记录)的调用行数。 */
  readonly missingPricingRows: number
}

/** 某个小时桶的估算成本(yuan 为 undefined = 该小时存在缺价行;空桶 yuan = 0)。 */
export interface HourCost {
  /** 本地日期 `YYYY-MM-DD`(与 aggregateByHour 同桶序)。 */
  readonly day: string
  /** 本地小时 0..23。 */
  readonly hour: number
  /** 该小时估算成本(元);缺价时为 undefined。 */
  readonly yuan?: number
  /** 该小时缺价(无价格记录)的调用行数。 */
  readonly missingPricingRows: number
}

/**
 * 逐日聚合近 `days` 天的估算成本(零填充,与 {@link aggregateByDay} 同日序;
 * 不落盘,纯计算)。逐行 {@link costFor},缺价行计 missing 不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的日成本(升序)。
 */
export function estimateDailyCosts(
  table: PricingTable,
  rows: readonly UsageLogRow[],
  days: number,
  fallback: ModelFallback,
  now: number = Date.now(),
): DayCost[] {
  const cutoff = now - days * 24 * 3600_000
  const daysList = recentDays(days, now)
  const byDay = new Map<string, DayCost>()
  for (const day of daysList) byDay.set(day, { day, yuan: 0, missingPricingRows: 0 })
  for (const row of rows) {
    if (row.ts < cutoff) continue
    const entry = byDay.get(localDay(row.ts))
    if (entry === undefined) continue
    const cost = costFor(table, row.model ?? fallback(row.label), row.ts, row.inputTokens, row.cacheReadTokens, row.outputTokens)
    byDay.set(entry.day, cost === undefined
      ? { ...entry, yuan: undefined, missingPricingRows: entry.missingPricingRows + 1 }
      : { ...entry, yuan: (entry.yuan ?? 0) + cost })
  }
  return daysList.map(day => byDay.get(day)!)
}

/**
 * 逐小时聚合近 `days` 天的估算成本(零填充,与 {@link aggregateByHour} 同桶序;
 * 不落盘,纯计算)。逐行 {@link costFor},缺价行计 missing 不静默为 0。
 * @param table - 价格表。
 * @param rows - usage 日志行。
 * @param days - 窗口天数。
 * @param fallback - label → 模型 id 映射。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的小时成本(升序,`days×24` 桶)。
 */
export function estimateHourlyCosts(
  table: PricingTable,
  rows: readonly UsageLogRow[],
  days: number,
  fallback: ModelFallback,
  now: number = Date.now(),
): HourCost[] {
  const cutoff = now - days * 24 * 3600_000
  const daysList = recentDays(days, now)
  const buckets: HourCost[] = []
  const byKey = new Map<string, number>()
  for (const day of daysList) {
    for (let hour = 0; hour < 24; hour++) {
      buckets.push({ day, hour, yuan: 0, missingPricingRows: 0 })
      byKey.set(`${day}T${hour}`, buckets.length - 1)
    }
  }
  for (const row of rows) {
    if (row.ts < cutoff) continue
    const index = byKey.get(`${localDay(row.ts)}T${new Date(row.ts).getHours()}`)
    if (index === undefined) continue
    const bucket = buckets[index]!
    const cost = costFor(table, row.model ?? fallback(row.label), row.ts, row.inputTokens, row.cacheReadTokens, row.outputTokens)
    buckets[index] = cost === undefined
      ? { ...bucket, yuan: undefined, missingPricingRows: bucket.missingPricingRows + 1 }
      : { ...bucket, yuan: (bucket.yuan ?? 0) + cost }
  }
  return buckets
}

/**
 * 估算一次提升评审(global promote)的总成本(元;docs/global-layer-design.md §7.3,决策 D7)。
 *
 * 假设(写死在 JSDoc,不在运行时可变):输入 = nodeCount × maxNodeKb × 1024 字符
 * (满容量节点)、输出 = nodeCount × GLOBAL_PROMOTE_MAX 条 × 150 字符(逐节点输出
 * 上限近似),均按 chars/4 估 token;逐节点用 costFor 计价(线性可合并为一次调用),
 * 模型 = config.reviewModel(v4-pro),与 usage 行 label='review' 回退语义一致。
 * @param table - 价格表。
 * @param model - 提升评审模型 id。
 * @param nodeCount - 预计节点数(0 节点无调用,成本 0)。
 * @param maxNodeKb - 每节点容量上限(Kb)。
 * @param ts - 估算时刻(epoch 毫秒);缺省当前时间。
 * @returns 估算成本(元);模型无价格记录返回 undefined。
 */
export function estimatePromoteCost(
  table: PricingTable,
  model: string,
  nodeCount: number,
  maxNodeKb: number,
  ts: number = Date.now(),
): number | undefined {
  if (nodeCount <= 0) return 0
  const inputTokens = estimateTokens(nodeCount * maxNodeKb * 1024)
  const outputTokens = estimateTokens(nodeCount * GLOBAL_PROMOTE_MAX * 150)
  return costFor(table, model, ts, inputTokens, 0, outputTokens)
}

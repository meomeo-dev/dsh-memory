/**
 * usage 持久化日志:`~/.dsh/lmemory/usage.jsonl`(纯逻辑,不 import cordis)。
 *
 * 每次 LLM 调用(recall / extract / review)的 usage chunk 聚合为一行追加;
 * 读侧按本地日聚合,支撑 `/lmemory usage --days` 与状态页每日图。设计见
 * docs/storage-and-collections.md §Q4。
 *
 * @module dsh-memory/usage-log
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './memory-file.js'

/** 职责分类(与 index.ts 的 UsageLabel 对应)。 */
export type UsageLabel = 'recall' | 'extract' | 'review'

/** usage 日志的一行。 */
export interface UsageLogRow {
  /** 记录时刻(epoch 毫秒)。 */
  readonly ts: number
  /** 职责分类。 */
  readonly label: UsageLabel
  /** 输入 token(不含缓存读)。 */
  readonly inputTokens: number
  /** 输出 token。 */
  readonly outputTokens: number
  /** 缓存读 token。 */
  readonly cacheReadTokens: number
}

/** 某一天某一职责的聚合。 */
export interface LabelDayUsage {
  /** 调用次数(日志行数)。 */
  readonly calls: number
  /** 当日输入 token 合计。 */
  readonly inputTokens: number
  /** 当日输出 token 合计。 */
  readonly outputTokens: number
  /** 当日缓存读 token 合计。 */
  readonly cacheReadTokens: number
  /** 当日该职责 token 合计(input + output + cacheRead)。 */
  readonly totalTokens: number
}

/** 某一天的聚合视图(三职责 + 合计)。 */
export interface DayUsage {
  /** 本地日期 `YYYY-MM-DD`。 */
  readonly day: string
  /** 各职责聚合。 */
  readonly recall: LabelDayUsage
  readonly extract: LabelDayUsage
  readonly review: LabelDayUsage
  /** 当日全部 token 合计。 */
  readonly total: number
}

/** usage.jsonl 的固定路径(用户 lmemory 根内)。 */
export function usageLogPath(): string {
  return join(dshHome(), 'lmemory', 'usage.jsonl')
}

/**
 * 追加一行 usage 日志(顺序写,不排序;行写失败不抛——usage 是旁路观测,
 * 不能让记忆主链路因日志失败而中断,失败交 logger 在调用方记录)。
 * @param row - 要追加的行。
 * @returns 是否真的写入了(失败时为 false)。
 */
export function appendUsageRow(row: UsageLogRow): boolean {
  try {
    const path = usageLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(row)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 读取全部 usage 日志行;损坏行跳过(usage 是旁路数据,坏行不阻塞统计)。
 * @returns 日志行(按文件顺序)。
 */
export function readUsageRows(): UsageLogRow[] {
  const path = usageLogPath()
  if (!existsSync(path)) return []
  const rows: UsageLogRow[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed !== 'object' || parsed === null) continue
      const { ts, label, inputTokens, outputTokens, cacheReadTokens } = parsed as Record<string, unknown>
      if (typeof ts !== 'number' || (label !== 'recall' && label !== 'extract' && label !== 'review')) continue
      if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') continue
      rows.push({ ts, label, inputTokens, outputTokens, cacheReadTokens: typeof cacheReadTokens === 'number' ? cacheReadTokens : 0 })
    } catch {
      // 坏行跳过。
    }
  }
  return rows
}

/** 把 epoch 毫秒转成本地日期键 `YYYY-MM-DD`。 */
export function localDay(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 零值职责聚合。 */
function emptyLabel(): LabelDayUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
}

/** 零值日聚合。 */
function emptyDay(day: string): DayUsage {
  return { day, recall: emptyLabel(), extract: emptyLabel(), review: emptyLabel(), total: 0 }
}

/** 把某职责的行累计进该职责聚合。 */
function addToLabel(target: LabelDayUsage, row: UsageLogRow): LabelDayUsage {
  const totalTokens = row.inputTokens + row.outputTokens + row.cacheReadTokens
  return {
    calls: target.calls + 1,
    inputTokens: target.inputTokens + row.inputTokens,
    outputTokens: target.outputTokens + row.outputTokens,
    cacheReadTokens: target.cacheReadTokens + row.cacheReadTokens,
    totalTokens: target.totalTokens + totalTokens,
  }
}

/** 近 `days` 天的本地日期键(从今往前,含今天,升序)。 */
export function recentDays(days: number, now: number = Date.now()): string[] {
  const result: string[] = []
  const cursor = new Date(now)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - i)
    const p = (n: number): string => String(n).padStart(2, '0')
    result.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  return result
}

/**
 * 按本地日聚合 usage 日志,零填充近 `days` 天(含今天,升序)。
 * @param rows - 日志行(由 {@link readUsageRows} 读取)。
 * @param days - 聚合天数(1..90;越界由调用方约束)。
 * @param now - 参照时刻(测试注入)。
 * @returns 近 `days` 天的日聚合(升序)。
 */
export function aggregateByDay(rows: readonly UsageLogRow[], days: number, now: number = Date.now()): DayUsage[] {
  const daysList = recentDays(days, now)
  const byDay = new Map<string, DayUsage>()
  for (const day of daysList) byDay.set(day, emptyDay(day))
  for (const row of rows) {
    const bucket = byDay.get(localDay(row.ts))
    if (bucket === undefined) continue
    const next: DayUsage = {
      ...bucket,
      [row.label]: addToLabel(bucket[row.label], row),
      total: bucket.total + row.inputTokens + row.outputTokens + row.cacheReadTokens,
    }
    byDay.set(bucket.day, next)
  }
  return daysList.map(day => byDay.get(day)!)
}

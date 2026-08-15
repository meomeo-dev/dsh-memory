/**
 * 记忆活动聚合:最近 24 小时、每 15 分钟一格,按 type × domain 计数新写入条目
 * (纯逻辑,不 import cordis)。设计见 docs/memory-activity.md。
 *
 * 数据源是已存在的事实——全部记忆根 `.remember.jsonl` 条目的 `createdAt`——不新增
 * 持久化日志;每次 dashboard-get 实时扫描聚合,不落盘。
 *
 * @module dsh-memory/memory-activity
 */

import { existsSync } from 'node:fs'
import { loadDir } from './memory-file.js'
import type { MemoryEntry } from './schema.js'

/** 缺省窗口:24 小时。 */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000

/** 缺省桶宽:15 分钟。 */
export const ACTIVITY_BUCKET_MS = 15 * 60 * 1000

/** 一个 15 分钟桶的计数(counts 键 = `type/domain`,只含非零项)。 */
export interface ActivityBucket {
  /** 桶起始时刻(epoch 毫秒)。 */
  readonly start: number
  /** type/domain → 该桶内新写入条目数。 */
  readonly counts: Readonly<Record<string, number>>
}

/** 记忆活动聚合结果。 */
export interface EntryActivity {
  /** 窗口起点(epoch 毫秒)。 */
  readonly windowStart: number
  /** 窗口终点(epoch 毫秒,= windowStart + 24h)。 */
  readonly windowEnd: number
  /** 桶宽(毫秒)。 */
  readonly bucketMinutes: number
  /** 96 个桶(升序)。 */
  readonly buckets: readonly ActivityBucket[]
}

/** 组合键:type 与 domain 的笛卡尔桶键。 */
export function activityKey(type: MemoryEntry['type'], domain: string): string {
  return `${type}/${domain}`
}

/**
 * 聚合最近 24 小时(15 分钟一格)的记忆写入活动。
 *
 * 条目按 `createdAt` 落桶:窗口 [now−24h, now),窗口外与未来时间戳忽略;
 * v1 旧条目经读即迁移回填的 createdAt 也按事实落桶。
 * @param dirs - 记忆目录列表(host 级注册表视图 + 内置层)。
 * @param now - 窗口终点(测试注入)。
 * @param windowMs - 窗口长度(测试注入;缺省 24h)。
 * @param bucketMs - 桶宽(测试注入;缺省 15min)。
 * @returns 聚合结果(恒返回全部桶,零计数桶含空 counts)。
 */
export function aggregateEntryActivity(
  dirs: readonly string[],
  now: number = Date.now(),
  windowMs: number = ACTIVITY_WINDOW_MS,
  bucketMs: number = ACTIVITY_BUCKET_MS,
): EntryActivity {
  const bucketCount = Math.floor(windowMs / bucketMs)
  const windowStart = now - windowMs
  const buckets: ActivityBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    start: windowStart + index * bucketMs,
    counts: {},
  }))
  const counts: Record<string, number>[] = buckets.map(bucket => bucket.counts as Record<string, number>)
  for (const dir of new Set(dirs)) {
    if (!existsSync(dir)) continue
    for (const file of loadDir(dir)) {
      for (const entry of file.entries) {
        if (entry.createdAt < windowStart || entry.createdAt >= now) continue
        const index = Math.floor((entry.createdAt - windowStart) / bucketMs)
        const count = counts[index]
        if (count === undefined) continue
        const key = activityKey(entry.type, entry.domain)
        count[key] = (count[key] ?? 0) + 1
      }
    }
  }
  return { windowStart, windowEnd: now, bucketMinutes: bucketMs / 60_000, buckets }
}

/** 3 字符封顶显示(面板镜像同规则,见 panel format.ts):≤999 原值,以上量级封顶。 */
export function formatActivityCount(value: number): string {
  if (value < 1000) return String(value)
  if (value >= 1e15) return '99T'
  if (value >= 1e12) return '99B'
  if (value >= 1e9) return '99G'
  if (value >= 1e6) return '99M'
  return '99K'
}

/** 格子底色强度档(与面板 activityLevel 同规则;0 空 / 4 最热)。 */
export function activityLevel(value: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (value < 3) return 1
  if (value < 10) return 2
  if (value < 100) return 3
  return 4
}

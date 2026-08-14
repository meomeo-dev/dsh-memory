/**
 * 记忆统计与 token 用量估算(纯逻辑,不 import cordis / dsh-llm)。
 *
 * 支撑 `/lmemory stats`(记忆条目/文件统计)与 `/lmemory usage`(上下文成本
 * 估算 + LLM 调用消耗累计)。统计只读文件,不发模型调用;token 估算用
 * `chars / 4` 的粗略近似(中英混合语境下的工程近似,不是精确计费)。
 *
 * @module dsh-memory/stats
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { discoverFiles, visibleMemoryDirs } from './memory-file.js'
import type { DomainId, LayerId, MemoryType } from './schema.js'

/** 记忆统计(给定 cwd 可见的全部记忆)。 */
export interface MemoryStats {
  /** 总条目数。 */
  readonly total: number
  /** 按 type 的条目数。 */
  readonly byType: Record<MemoryType, number>
  /** 按 layer 的条目数。 */
  readonly byLayer: Record<LayerId, number>
  /** 按 domain 的条目数(只含非零项)。 */
  readonly byDomain: ReadonlyMap<DomainId, number>
  /** 记忆文件数(jsonl 与 md 成对,各计一份)。 */
  readonly files: number
  /** jsonl 总字节。 */
  readonly jsonlBytes: number
  /** md 总字节。 */
  readonly mdBytes: number
  /** catalog 条目总数(全部可见 memory 目录的 catalog.json 求和)。 */
  readonly catalogEntries: number
}

/** 一个 catalog.json 的最小投影。 */
interface CatalogDoc {
  entries: readonly unknown[]
}

/** 读取某目录的 catalog.json 条目数;文件缺失/损坏返回 0(统计只读,失败降级不抛)。 */
function readCatalogEntries(dir: string): number {
  const path = join(dir, 'catalog.json')
  if (!existsSync(path)) return 0
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<CatalogDoc>
    return Array.isArray(doc.entries) ? doc.entries.length : 0
  } catch {
    return 0
  }
}

/**
 * 计算给定 cwd 可见的全部记忆的统计。
 * @param cwd - 当前工作目录;缺省只统计内置 + 用户级。
 * @returns 统计结果(无记忆时各项为 0 / 空)。
 */
export function computeStats(cwd?: string): MemoryStats {
  const files = discoverFiles(cwd)
  const byType: Record<MemoryType, number> = { rules: 0, lessons: 0 }
  const byLayer: Record<LayerId, number> = { global: 0, user: 0, project: 0 }
  const byDomain = new Map<DomainId, number>()
  let jsonlBytes = 0
  let mdBytes = 0
  for (const file of files) {
    jsonlBytes += statSync(file.jsonlPath).size
    if (existsSync(file.mdPath)) mdBytes += statSync(file.mdPath).size
    for (const entry of file.entries) {
      byType[entry.type] += 1
      byLayer[entry.layer] += 1
      byDomain.set(entry.domain, (byDomain.get(entry.domain) ?? 0) + 1)
    }
  }
  return {
    total: byType.rules + byType.lessons,
    byType,
    byLayer,
    byDomain,
    files: files.length,
    jsonlBytes,
    mdBytes,
    catalogEntries: visibleMemoryDirs(cwd).reduce((sum, dir) => sum + readCatalogEntries(dir), 0),
  }
}

/**
 * 把字符数粗估为 token 数(中英混合语境的工程近似:约 4 字符/token)。
 * @param chars - 文本字符数。
 * @returns 估算 token 数(向上取整)。
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

/** LLM 调用消耗的累计器(按职责分类:recall / extract / review)。 */
export interface UsageCounter {
  /** 调用次数。 */
  readonly calls: number
  /** 累计输入 token(不含缓存读)。 */
  readonly inputTokens: number
  /** 累计输出 token。 */
  readonly outputTokens: number
  /** 累计缓存读 token。 */
  readonly cacheReadTokens: number
}

/** 零值累计器。 */
export const EMPTY_USAGE: UsageCounter = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

/** 一次模型调用的最小 usage 投影(结构性兼容 dsh-llm 的 TokenUsage)。 */
export interface UsageSlice {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

/**
 * 把一次调用的 usage 累计进计数器。
 * @param counter - 现有计数器。
 * @param usage - 本次调用的 usage。
 * @returns 新计数器(调用次数 +1)。
 */
export function recordUsage(counter: UsageCounter, usage: UsageSlice): UsageCounter {
  return {
    calls: counter.calls + 1,
    inputTokens: counter.inputTokens + usage.inputTokens,
    outputTokens: counter.outputTokens + usage.outputTokens,
    cacheReadTokens: counter.cacheReadTokens + (usage.cacheReadTokens ?? 0),
  }
}

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeStats, computeStatsIn, EMPTY_USAGE, estimateTokens, recordUsage } from '../src/stats.js'

let project: string
let dshHome: string
const saved = { dsh: process.env.DSH_HOME }

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dsh-memory-stats-proj-'))
  mkdirSync(join(project, '.git'))
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-stats-dsh-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
  if (saved.dsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.dsh
})

/** 在项目写根塞一个 jsonl + 成对 md + catalog。 */
function seedProject(rows: readonly string[], mdSize = 0, catalogEntries = 0): string {
  const dir = join(project, '.dsh', 'memory')
  mkdirSync(dir, { recursive: true })
  const jsonl = join(dir, '2026-08-14.rules.remember.jsonl')
  writeFileSync(jsonl, `${rows.join('\n')}\n`, 'utf8')
  writeFileSync(join(dir, '2026-08-14.rules.remember.md'), '# md\n' + 'x'.repeat(mdSize) + '\n', 'utf8')
  if (catalogEntries > 0) {
    writeFileSync(
      join(dir, 'catalog.json'),
      JSON.stringify({ version: 1, entries: Array.from({ length: catalogEntries }, (_, i) => ({ id: `m-${i}` })) }),
      'utf8',
    )
  }
  return dir
}

describe('computeStats', () => {
  it('returns zeros for an empty project', () => {
    const stats = computeStats(project)
    expect(stats.total).toBe(0)
    expect(stats.byType).toEqual({ rules: 0, lessons: 0 })
    expect(stats.files).toBe(0)
    expect(stats.catalogEntries).toBe(0)
  })

  it('aggregates entries by type / layer / domain and sums file bytes', () => {
    let seq = 0
    const row = (type: string, domain: string, layer: string, entry: string) => {
      seq += 1
      const id = `m-000000000${seq}`
      return JSON.stringify({ id, schemaVersion: 1, type, domain, scope: '全项目', layer, entry, entryPoint: '-', references: '-' })
    }
    const rows = [
      row('rules', 'DurablePrefs', 'project', '用 pnpm'),
      row('rules', 'Style', 'project', '两空格缩进'),
      row('lessons', 'PromotedPitfalls', 'user', '某坑'),
    ]
    seedProject(rows, 10, 3)
    const stats = computeStats(project)
    expect(stats.total).toBe(3)
    expect(stats.byType).toEqual({ rules: 2, lessons: 1 })
    expect(stats.byLayer.project).toBe(2)
    expect(stats.byLayer.user).toBe(1)
    expect(stats.byDomain.get('DurablePrefs')).toBe(1)
    expect(stats.byDomain.get('Style')).toBe(1)
    expect(stats.byDomain.get('PromotedPitfalls')).toBe(1)
    expect(stats.files).toBe(1)
    expect(stats.jsonlBytes).toBeGreaterThan(0)
    expect(stats.mdBytes).toBeGreaterThan(0)
    expect(stats.catalogEntries).toBe(3)
  })

  it('tolerates a missing or broken catalog.json', () => {
    seedProject([], 0, 0)
    const dir = join(project, '.dsh', 'memory')
    writeFileSync(join(dir, 'catalog.json'), '{not json', 'utf8')
    const stats = computeStats(project)
    expect(stats.catalogEntries).toBe(0)
    expect(stats.total).toBe(0)
  })

  it('includes global dir entries and its catalog (direct append, no merge)', () => {
    const globalDir = join(dshHome, 'lmemory', 'global')
    mkdirSync(globalDir, { recursive: true })
    const row = JSON.stringify({ id: 'm-0000000001', schemaVersion: 1, type: 'lessons', domain: 'PastFixes', scope: '全项目', layer: 'global', entry: '全局坑', entryPoint: '-', references: '-' })
    writeFileSync(join(globalDir, '2026-08-14.lessons.remember.jsonl'), `${row}\n`)
    writeFileSync(join(globalDir, '2026-08-14.lessons.remember.md'), '# md\n')
    writeFileSync(join(globalDir, 'catalog.json'), JSON.stringify({ version: 1, entries: [{ id: 'm-0000000001' }] }))

    const stats = computeStats(project)
    expect(stats.total).toBe(1)
    expect(stats.byLayer.global).toBe(1)
    expect(stats.files).toBe(1)
    expect(stats.catalogEntries).toBe(1)
  })
})

describe('computeStatsIn', () => {
  it('aggregates explicit dirs without merging same-basename files across roots', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'dsh-memory-stats-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'dsh-memory-stats-b-'))
    const row = (seq: number, entry: string) => JSON.stringify({ id: `m-000000000${seq}`, schemaVersion: 1, type: 'rules', domain: 'Style', scope: '全项目', layer: 'project', entry, entryPoint: '-', references: '-' })
    writeFileSync(join(dirA, '2026-08-14.rules.remember.jsonl'), `${row(1, 'A 条目')}\n`)
    writeFileSync(join(dirB, '2026-08-14.rules.remember.jsonl'), `${row(2, 'B 条目')}\n`)

    const stats = computeStatsIn([dirA, dirB])
    expect(stats.total).toBe(2) // 同名 basename 不合并,两个根各计一份
    expect(stats.files).toBe(2)
    // 重复路径去重,不存在的目录跳过。
    const dedupe = computeStatsIn([dirA, dirA, join(tmpdir(), 'nope')])
    expect(dedupe.total).toBe(1)
    expect(dedupe.files).toBe(1)

    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })
})

describe('estimateTokens', () => {
  it('rounds up chars/4', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1)).toBe(1)
    expect(estimateTokens(100)).toBe(25)
    expect(estimateTokens(101)).toBe(26)
  })
})

describe('recordUsage', () => {
  it('accumulates calls and token fields', () => {
    const first = recordUsage(EMPTY_USAGE, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 })
    expect(first).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 })
    const second = recordUsage(first, { inputTokens: 20, outputTokens: 3 })
    expect(second).toEqual({ calls: 2, inputTokens: 120, outputTokens: 13, cacheReadTokens: 50 })
  })
})

describe('seedProject helper', () => {
  it('writes the jsonl file it claims to', () => {
    const dir = seedProject([JSON.stringify({ type: 'rules', domain: 'Style', scope: 'x', layer: 'project', entry: 'e' })])
    expect(existsSync(join(dir, '2026-08-14.rules.remember.jsonl'))).toBe(true)
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildGlobalExport,
  GLOBAL_EXPORT_FORMAT_VERSION,
  GLOBAL_EXPORT_KIND,
  importGlobalEntries,
  parseGlobalExport,
} from '../src/global-io.js'
import { appendImported } from '../src/store.js'
import type { MemoryEntry } from '../src/schema.js'

let dshHome: string
const saved = { dsh: process.env.DSH_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-io-dsh-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  if (saved.dsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.dsh
})

/** 一条完整的 global 条目(10 字段)。 */
function globalEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm-0000000001',
    schemaVersion: 2,
    createdAt: 1750000000000,
    type: 'lessons',
    domain: 'PastFixes',
    scope: '全项目',
    layer: 'global',
    entry: '某个跨项目通用的坑根因值得长期记住并推广',
    entryPoint: 'src/index.ts',
    references: '-',
    ...overrides,
  }
}

/** 一个合法的导出包全文。 */
function exportText(entries: readonly MemoryEntry[], formatVersion = GLOBAL_EXPORT_FORMAT_VERSION, kind = GLOBAL_EXPORT_KIND): string {
  return JSON.stringify({ kind, formatVersion, exportedAt: 1750000000000, source: 'dsh-memory', entries })
}

function readCatalog(dir: string): { entries: Array<{ id: string }> } {
  return JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')) as { entries: Array<{ id: string }> }
}

describe('parseGlobalExport', () => {
  it('accepts a valid envelope and rejects non-JSON', () => {
    const parsed = parseGlobalExport(exportText([globalEntry()]))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.doc.kind).toBe(GLOBAL_EXPORT_KIND)
      expect(parsed.doc.entries).toHaveLength(1)
    }
    expect(parseGlobalExport('{not json').ok).toBe(false)
  })

  it('rejects the wrong kind first, including a collections manifest', () => {
    // 防线 1(kind)先于 formatVersion:collections manifest 无 kind,拦在第一道。
    const manifest = JSON.stringify({ formatVersion: 1, source: 'dsh-memory', roots: [{ root: '/x' }] })
    const parsed = parseGlobalExport(manifest)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('不是真实的 global 导出')
  })

  it('rejects unsupported and legacy formatVersions', () => {
    const future = parseGlobalExport(exportText([], 2))
    expect(future.ok).toBe(false)
    if (!future.ok) expect(future.reason).toContain('unsupported')
    const legacy = parseGlobalExport(exportText([], 0))
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.reason).toContain('legacy')
  })

  it('rejects a missing entries array', () => {
    const parsed = parseGlobalExport(JSON.stringify({ kind: GLOBAL_EXPORT_KIND, formatVersion: 1 }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('entries')
  })
})

describe('importGlobalEntries', () => {
  it('imports entries with original id / createdAt / schemaVersion and a consistent catalog', () => {
    const dir = join(dshHome, 'lmemory', 'global')
    const parsed = parseGlobalExport(exportText([globalEntry()]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = importGlobalEntries(parsed.doc)
    expect(result).toEqual({ imported: 1, duplicates: 0, skipped: [], errors: [] })
    const lines = readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.lessons.remember.jsonl`), 'utf8').split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"id":"m-0000000001"')
    expect(lines[0]).toContain('"createdAt":1750000000000')
    expect(lines[0]).toContain('"schemaVersion":2')
    expect(readCatalog(dir).entries).toHaveLength(1)
  })

  it('migrates legacy schemaVersion rows through the same read-migrate chain (defense 3)', () => {
    const parsed = parseGlobalExport(exportText([globalEntry({ schemaVersion: 1 })]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = importGlobalEntries(parsed.doc)
    expect(result.imported).toBe(1)
    const dir = join(dshHome, 'lmemory', 'global')
    const line = readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.lessons.remember.jsonl`), 'utf8').trim()
    expect(line).toContain('"schemaVersion":2')
    expect(line).toContain('"createdAt":1750000000000')
  })

  it('skips schema-invalid, gate-failing, and non-global entries with reasons', () => {
    const parsed = parseGlobalExport(exportText([
      // schema 非法:缺 domain。
      { id: 'm-0000000001', schemaVersion: 2, createdAt: 1, type: 'lessons', scope: 'x', layer: 'global', entry: '条目', entryPoint: '-', references: '-' },
      // gate 拒绝:太短。
      globalEntry({ id: 'm-0000000002', entry: '太短' }),
      // layer 非 global。
      globalEntry({ id: 'm-0000000003', layer: 'user' }),
    ]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = importGlobalEntries(parsed.doc)
    expect(result.imported).toBe(0)
    expect(result.skipped.map(skip => skip.reason).join('|')).toContain('gate:')
    expect(result.skipped.map(skip => skip.reason).join('|')).toContain('not global')
    expect(result.skipped.some(skip => skip.reason.includes('domain'))).toBe(true)
  })

  it('dedupes in two rounds: within the batch and against existing global entries', () => {
    appendImported(join(dshHome, 'lmemory', 'global'), [globalEntry({ id: 'm-0000000001' })])
    const parsed = parseGlobalExport(exportText([
      globalEntry({ id: 'm-0000000002', entry: '批内重复条目:跨项目通用规范值得长期保存' }),
      globalEntry({ id: 'm-0000000003', entry: '批内重复条目:跨项目通用规范值得长期保存' }),
      globalEntry({ id: 'm-0000000001' }), // 与存量同 entry(且同 id)。
    ]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = importGlobalEntries(parsed.doc)
    expect(result).toEqual({ imported: 1, duplicates: 2, skipped: [], errors: [] })
  })
})

describe('round-trip', () => {
  it('export → import into a fresh host preserves all entry fields and rebuilds the same catalog', () => {
    // 先在当前 host 建 global 数据并导出。
    const dirA = join(dshHome, 'lmemory', 'global')
    appendImported(dirA, [globalEntry()])
    const doc = buildGlobalExport(1750000000000)
    expect(doc.kind).toBe(GLOBAL_EXPORT_KIND)
    expect(doc.formatVersion).toBe(1)
    expect(doc.entries).toHaveLength(1)
    expect(doc.entries[0]).toMatchObject({ id: 'm-0000000001', layer: 'global' })

    // 换一个空 host 导入。
    const hostB = mkdtempSync(join(tmpdir(), 'dsh-memory-io-b-'))
    process.env.DSH_HOME = hostB
    const result = importGlobalEntries(doc)
    expect(result.imported).toBe(1)
    const dirB = join(hostB, 'lmemory', 'global')
    const entryB = JSON.parse(readFileSync(join(dirB, `${new Date().toISOString().slice(0, 10)}.lessons.remember.jsonl`), 'utf8')) as MemoryEntry
    expect(entryB.id).toBe('m-0000000001')
    expect(entryB.createdAt).toBe(1750000000000)
    expect(entryB.entryPoint).toBe('src/index.ts')
    // 新 host 的 catalog 与导出源的 catalog 条目集合一致。
    expect(readCatalog(dirB).entries.map(e => e.id)).toEqual(readCatalog(dirA).entries.map(e => e.id))
    expect(existsSync(join(dirB, 'catalog.json'))).toBe(true)
    rmSync(hostB, { recursive: true, force: true })
  })
})

describe('export doc shape', () => {
  it('carries kind, formatVersion, exportedAt, source, and full entries', () => {
    mkdirSync(join(dshHome, 'lmemory', 'global'), { recursive: true })
    appendImported(join(dshHome, 'lmemory', 'global'), [globalEntry()])
    const doc = buildGlobalExport(123)
    expect(doc).toEqual({
      kind: GLOBAL_EXPORT_KIND,
      formatVersion: GLOBAL_EXPORT_FORMAT_VERSION,
      exportedAt: 123,
      source: 'dsh-memory',
      entries: [globalEntry()],
    })
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportCollections, exportDirName } from '../src/collections.js'
import { refreshRegistry } from '../src/registry.js'

let dshHome: string
let agentsHome: string
let projectA: string
let projectB: string
let outDir: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-col-dsh-'))
  agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-col-agents-'))
  projectA = mkdtempSync(join(tmpdir(), 'dsh-memory-col-a-'))
  projectB = mkdtempSync(join(tmpdir(), 'dsh-memory-col-b-'))
  outDir = mkdtempSync(join(tmpdir(), 'dsh-memory-col-out-'))
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
})

afterEach(() => {
  for (const dir of [dshHome, agentsHome, projectA, projectB, outDir]) rmSync(dir, { recursive: true, force: true })
  if (saved.dsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.dsh
  if (saved.agents === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = saved.agents
})

const NOW = new Date(2026, 7, 14, 10, 30, 0) // 本地时间固定。

function seedJsonl(dir: string, entries: number, type = 'rules'): void {
  mkdirSync(dir, { recursive: true })
  const rows = Array.from({ length: entries }, (_, i) =>
    JSON.stringify({ id: `m-00000000${String(i).padStart(2, '0')}`, schemaVersion: 2, createdAt: 1750000000000, type, domain: 'Style', scope: '全项目', layer: 'user', entry: `条目 ${i}`, entryPoint: '-', references: '-' }))
  writeFileSync(join(dir, `2026-08-13.${type}.remember.jsonl`), `${rows.join('\n')}\n`, 'utf8')
  writeFileSync(join(dir, `2026-08-13.${type}.remember.md`), '| id |\n|---|---|', 'utf8')
}

describe('exportDirName', () => {
  it('formats the local timestamp suffix', () => {
    expect(exportDirName(NOW)).toBe('dsh-memory-20260814-103000')
  })
})

describe('exportCollections', () => {
  it('exports all registered roots with a manifest, isolated per root', () => {
    seedJsonl(join(projectA, '.dsh', 'lmemory'), 2)
    seedJsonl(join(projectB, '.dsh', 'lmemory'), 3, 'lessons')
    refreshRegistry(projectA, NOW.getTime())
    refreshRegistry(projectB, NOW.getTime())

    const result = exportCollections(projectA, { outDir }, NOW)
    expect(result.totalEntries).toBe(5)
    expect(result.rootsExported).toBe(2)
    expect(result.dir).toBe(join(outDir, 'dsh-memory-20260814-103000'))

    const manifest = JSON.parse(readFileSync(join(result.dir, 'manifest.json'), 'utf8'))
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.source).toBe('dsh-memory')
    expect(manifest.totalEntries).toBe(5)
    expect(manifest.roots).toHaveLength(2)
    expect(manifest.roots.map((root: { root: string }) => root.root)).toContain(join(projectA, '.dsh', 'lmemory'))
    // 每个根的文件已拷到隔离的 roots/<nn>/。
    const rootsDir = join(result.dir, 'roots')
    const subdirs = readdirSync(rootsDir).sort()
    expect(subdirs).toHaveLength(2)
    expect(existsSync(join(rootsDir, subdirs[0]!, '2026-08-13.rules.remember.jsonl'))).toBe(true)
    expect(readdirSync(join(rootsDir, subdirs[0]!))).toHaveLength(2) // jsonl + md
  })

  it('exports only the selected roots when --root is given', () => {
    seedJsonl(join(projectA, '.dsh', 'lmemory'), 2)
    seedJsonl(join(projectB, '.dsh', 'lmemory'), 3, 'lessons')

    const result = exportCollections(projectA, {
      outDir,
      roots: [join(projectB, '.dsh', 'lmemory')],
    }, NOW)
    expect(result.totalEntries).toBe(3)
    expect(result.rootsExported).toBe(1)
  })

  it('succeeds with an empty registry (rootsExported 0, manifest still written)', () => {
    const result = exportCollections(undefined, { outDir }, NOW)
    expect(result.totalEntries).toBe(0)
    expect(result.rootsExported).toBe(0)
    expect(existsSync(join(result.dir, 'manifest.json'))).toBe(true)
  })

  it('skips roots that exist but hold no memory files', () => {
    seedJsonl(join(projectA, '.dsh', 'lmemory'), 1)
    refreshRegistry(projectA, NOW.getTime())
    // 注册表里有一个空的(无记忆文件的)根。
    const empty = join(dshHome, 'lmemory')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'usage.jsonl'), '', 'utf8')
    refreshRegistry(undefined, NOW.getTime())

    const result = exportCollections(projectA, { outDir }, NOW)
    expect(result.rootsExported).toBe(1)
    expect(result.totalEntries).toBe(1)
  })
})

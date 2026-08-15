import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  forgetRoot,
  isMemoryRoot,
  loadRegistry,
  refreshRegistry,
  registerExplicitRoot,
  scanRootDetail,
  saveRegistry,
  scanRoot,
} from '../src/registry.js'
import { memoryWriteRoots } from '../src/memory-file.js'

let dshHome: string
let agentsHome: string
let project: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-reg-dsh-'))
  agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-reg-agents-'))
  project = mkdtempSync(join(tmpdir(), 'dsh-memory-reg-proj-'))
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(agentsHome, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  if (saved.dsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.dsh
  if (saved.agents === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = saved.agents
})

const NOW = 1750000000000

function seedJsonl(dir: string, entries: number): void {
  mkdirSync(dir, { recursive: true })
  const rows = Array.from({ length: entries }, (_, i) =>
    JSON.stringify({ id: `m-000000000${i}`, schemaVersion: 2, createdAt: NOW, type: 'rules', domain: 'Style', scope: '全项目', layer: 'user', entry: `条目 ${i}`, entryPoint: '-', references: '-' }))
  writeFileSync(join(dir, '2026-08-13.rules.remember.jsonl'), `${rows.join('\n')}\n`, 'utf8')
}

describe('registry load/save', () => {
  it('loads empty when the file is missing or corrupt', () => {
    expect(loadRegistry().roots).toHaveLength(0)
    saveRegistry({ formatVersion: 1, updatedAt: NOW, roots: [] })
    expect(loadRegistry().roots).toHaveLength(0)
    writeFileSync(join(dshHome, 'lmemory', 'registry.json'), '{not json', 'utf8')
    expect(loadRegistry().roots).toHaveLength(0)
  })

  it('persists and re-reads roots round-trip', () => {
    seedJsonl(join(dshHome, 'lmemory'), 1)
    refreshRegistry(project, NOW)
    const again = loadRegistry()
    expect(again.formatVersion).toBe(1)
    expect(again.roots.some(root => root.root === join(dshHome, 'lmemory'))).toBe(true)
  })
})

describe('scanRoot / isMemoryRoot', () => {
  it('counts entries and files, and recognizes memory roots', () => {
    const dir = join(dshHome, 'lmemory')
    expect(scanRoot(dir)).toEqual({ entries: 0, files: 0 })
    expect(isMemoryRoot(dir)).toBe(false)
    seedJsonl(dir, 3)
    expect(scanRoot(dir)).toEqual({ entries: 3, files: 1 })
    expect(isMemoryRoot(dir)).toBe(true)
    const empty = join(dshHome, 'empty-root')
    mkdirSync(empty)
    expect(isMemoryRoot(empty)).toBe(true)
  })
})

describe('scanRootDetail', () => {
  it('skips corrupt jsonl rows instead of throwing (registry counting is read-only)', () => {
    const dir = join(dshHome, 'lmemory')
    mkdirSync(dir, { recursive: true })
    const good = JSON.stringify({ id: 'm-0000000001', schemaVersion: 2, createdAt: NOW, type: 'rules', domain: 'Style', scope: '全项目', layer: 'user', entry: '好条目', entryPoint: '-', references: '-' })
    writeFileSync(join(dir, '2026-08-13.rules.remember.jsonl'), `${good}\n{broken json\n`, 'utf8')

    const detail = scanRootDetail(dir)
    expect(detail.entries).toBe(1)
    expect(detail.files).toBe(1)
    expect(detail.filesDetail).toEqual([{ file: '2026-08-13.rules.remember.jsonl', entries: 1 }])
    // 坏行存在时 refreshRegistry 也不抛(启动路径依赖这一点)。
    expect(refreshRegistry(project, NOW).roots.some(root => root.root === dir)).toBe(true)
  })

  it('treats an unreadable registered path as an empty scan', () => {
    const asFile = join(dshHome, 'lmemory')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(asFile, 'not a dir', 'utf8')
    expect(scanRootDetail(asFile)).toEqual({ entries: 0, files: 0, filesDetail: [] })
  })
})

describe('refreshRegistry', () => {
  it('registers fixed user roots that exist, and lazily registers project roots from cwd', () => {
    seedJsonl(join(dshHome, 'lmemory'), 2)
    seedJsonl(join(project, '.dsh', 'lmemory'), 4)

    const registry = refreshRegistry(project, NOW)
    const user = registry.roots.find(root => root.kind === 'user')!
    expect(user.root).toBe(join(dshHome, 'lmemory'))
    expect(user.entries).toBe(2)
    expect(user.lastSeenAt).toBe(NOW)

    const proj = registry.roots.find(root => root.kind === 'project')!
    expect(proj.root).toBe(join(project, '.dsh', 'lmemory'))
    expect(proj.entries).toBe(4)
    expect(proj.firstSeenAt).toBe(NOW)
  })

  it('registers project roots even before the dir exists (async extraction ordering)', () => {
    // session-start 时刻项目 lmemory 尚未创建(提取是异步的):先按路径登记 0/0。
    const registry = refreshRegistry(project, NOW)
    const proj = registry.roots.find(root => root.root === join(project, '.dsh', 'lmemory'))!
    expect(proj.kind).toBe('project')
    expect(proj.entries).toBe(0)
    expect(proj.files).toBe(0)

    // 提取写盘后目录出现,再次刷新更新计数。
    seedJsonl(join(project, '.dsh', 'lmemory'), 3)
    const refreshed = refreshRegistry(project, NOW + 1)
    const updated = refreshed.roots.find(root => root.root === join(project, '.dsh', 'lmemory'))!
    expect(updated.entries).toBe(3)
    expect(updated.files).toBe(1)
    expect(updated.firstSeenAt).toBe(NOW) // 首次登记时间保持。
    expect(updated.lastSeenAt).toBe(NOW + 1)
  })

  it('keeps historical roots with last-known counts when they disappear', () => {
    seedJsonl(join(project, '.dsh', 'lmemory'), 4)
    refreshRegistry(project, NOW)
    // 项目根消失(目录删除)。
    rmSync(join(project, '.dsh', 'lmemory'), { recursive: true, force: true })

    const registry = refreshRegistry(undefined, NOW + 1000)
    const proj = registry.roots.find(root => root.root === join(project, '.dsh', 'lmemory'))!
    expect(proj.entries).toBe(4) // 最后已知计数保留。
    expect(proj.lastSeenAt).toBe(NOW) // lastSeenAt 不更新。
  })
})

describe('registerExplicitRoot / forgetRoot', () => {
  it('adds an explicit root (project kind) and removes it without touching data', () => {
    const root = join(project, '.dsh', 'lmemory')
    seedJsonl(root, 1)
    const registry = registerExplicitRoot(root, NOW)
    expect(registry.roots.some(entry => entry.root === root && entry.kind === 'project')).toBe(true)

    expect(forgetRoot(root, NOW + 1)).toBe(true)
    expect(loadRegistry().roots.some(entry => entry.root === root)).toBe(false)
    // 数据未动。
    expect(existsSync(join(root, '2026-08-13.rules.remember.jsonl'))).toBe(true)
    expect(forgetRoot(root, NOW + 2)).toBe(false)
  })

  it('classifies the fixed user roots as kind user', () => {
    const registry = registerExplicitRoot(join(dshHome, 'lmemory'), NOW)
    expect(registry.roots.find(entry => entry.root === join(dshHome, 'lmemory'))!.kind).toBe('user')
  })
})

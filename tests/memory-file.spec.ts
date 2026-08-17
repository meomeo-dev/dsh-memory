import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalProjectRoot,
  discoverEntries,
  discoverGlobalEntries,
  memoryWriteRoots,
  migrateLegacyGlobalEntries,
  migrateLegacyMemoryDirs,
  resolveRecalled,
  visibleGlobalDir,
  visibleMemoryDirs,
  writeRootFor,
} from '../src/memory-file.js'
import { rebuild } from '../src/store.js'
import { isMemoryId } from '../src/schema.js'

let dshHome: string
let agentsHome: string
let project: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-dsh-'))
  agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-agents-'))
  // 项目根会被 canonicalProjectRoot realpath 化(macOS /tmp → /private/tmp),测试侧先归一。
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-memory-proj-')))
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

describe('memoryWriteRoots', () => {
  it('routes user and project to their write roots', () => {
    const roots = memoryWriteRoots(project)
    expect(roots.user).toBe(join(dshHome, 'lmemory'))
    expect(roots.project).toBe(join(project, '.dsh', 'lmemory'))
  })
})

describe('visibleMemoryDirs', () => {
  it('lists user-level dirs without a cwd and adds project dirs with one', () => {
    const withoutProject = visibleMemoryDirs()
    expect(withoutProject).toHaveLength(3)
    expect(withoutProject[1]).toBe(join(agentsHome, 'lmemory'))
    expect(withoutProject[2]).toBe(join(dshHome, 'lmemory'))

    const withProject = visibleMemoryDirs(project)
    expect(withProject).toHaveLength(5)
    expect(withProject[3]).toBe(join(project, '.agents', 'lmemory'))
    expect(withProject[4]).toBe(join(project, '.dsh', 'lmemory'))
  })
})

describe('discoverEntries (migrating read of legacy rows)', () => {
  it('migrates a jsonl row without an id and keeps its id stable across reads', () => {
    const dir = join(dshHome, 'lmemory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '2026-08-13.rules.remember.jsonl'),
      '{"type":"rules","domain":"Style","scope":"全项目","layer":"user","entry":"两空格缩进","entryPoint":"-","references":"-"}\n',
      'utf8',
    )
    const first = discoverEntries(project)
    expect(first.map(e => e.entry)).toEqual(['两空格缩进'])
    expect(isMemoryId(first[0]!.id)).toBe(true)
    expect(first[0]!.schemaVersion).toBe(2)
    // createdAt 按文件名日期回填(本地零点)。
    expect(first[0]!.createdAt).toBe(new Date(2026, 7, 13).getTime())

    // 迁移已落盘,再次读取补出同一 id(而非每次读生成临时 id)。
    const second = discoverEntries(project)
    expect(second[0]!.id).toBe(first[0]!.id)
  })
})

describe('resolveRecalled', () => {
  function seed(entry: string, entryPoint = '-', references = '-'): void {
    const dir = join(project, '.dsh', 'lmemory')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '2026-08-14.lessons.remember.jsonl'),
      `${JSON.stringify({ id: 'm-0000000001', schemaVersion: 2, createdAt: 1750000000000, type: 'lessons', domain: 'PromotedPitfalls', scope: '样本库', layer: 'project', entry, entryPoint, references })}\n`,
      'utf8',
    )
  }

  it('resolves a recalled line by id into the full entry from the truth source', () => {
    seed('某坑根因', 'src/index.ts', 'docs/a.md')
    const resolved = resolveRecalled(project, ['[m-0000000001|lessons|PromotedPitfalls|样本库] 某坑根因'])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toEqual({
      id: 'm-0000000001',
      file: '2026-08-14.lessons.remember.jsonl',
      type: 'lessons',
      domain: 'PromotedPitfalls',
      scope: '样本库',
      layer: 'project',
      entry: '某坑根因',
      entryPoint: 'src/index.ts',
      references: 'docs/a.md',
    })
  })

  it('degrades to in-line fields with `-` placeholders when the id misses', () => {
    seed('某坑根因')
    const resolved = resolveRecalled(project, ['[m-9999999999|rules|Style|全项目] 不存在的条目'])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.id).toBe('m-9999999999')
    expect(resolved[0]!.type).toBe('rules')
    expect(resolved[0]!.entry).toBe('不存在的条目')
    expect(resolved[0]!.file).toBe('-')
    expect(resolved[0]!.layer).toBe('-')
    expect(resolved[0]!.entryPoint).toBe('-')
    expect(resolved[0]!.references).toBe('-')
  })

  it('degrades a bare-text line (model did not copy the whole line) to entry only', () => {
    seed('某坑根因')
    const resolved = resolveRecalled(project, ['某坑根因'])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.id).toBe('-')
    expect(resolved[0]!.entry).toBe('某坑根因')
    expect(resolved[0]!.entryPoint).toBe('-')
  })

  it('preserves input order and resolves duplicates by id into distinct entries', () => {
    const dir = join(project, '.dsh', 'lmemory')
    mkdirSync(dir, { recursive: true })
    const row = (id: string, entry: string) => `${JSON.stringify({ id, schemaVersion: 2, createdAt: 1750000000000, type: 'rules', domain: 'Style', scope: '全项目', layer: 'project', entry, entryPoint: '-', references: '-' })}\n`
    writeFileSync(
      join(dir, '2026-08-14.rules.remember.jsonl'),
      row('m-0000000001', '第一条') + row('m-0000000002', '第二条'),
      'utf8',
    )
    const resolved = resolveRecalled(project, [
      '[m-0000000002|rules|Style|全项目] 第二条',
      '[m-0000000001|rules|Style|全项目] 第一条',
    ])
    expect(resolved.map(r => r.entry)).toEqual(['第二条', '第一条'])
  })
})

describe('legacy memory/ dir migration (one-time rename to lmemory/)', () => {
  const row = '{"type":"rules","domain":"Style","scope":"全项目","layer":"user","entry":"旧目录条目","entryPoint":"-","references":"-"}\n'

  it('renames a legacy user memory dir with data intact, idempotently', () => {
    const legacy = join(dshHome, 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '2026-08-13.rules.remember.jsonl'), row, 'utf8')

    const report = migrateLegacyMemoryDirs()
    expect(report.moved).toEqual([legacy])
    expect(report.skipped).toEqual([])
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(dshHome, 'lmemory', '2026-08-13.rules.remember.jsonl'), 'utf8')).toBe(row)

    // 幂等:第二次无迁移发生。
    const again = migrateLegacyMemoryDirs()
    expect(again.moved).toEqual([])
    expect(again.skipped).toEqual([])
  })

  it('skips a non-empty legacy dir that does not contain memory artifacts', () => {
    const legacy = join(dshHome, 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'other-tool.db'), 'x', 'utf8')

    const report = migrateLegacyMemoryDirs()
    expect(report.moved).toEqual([])
    expect(report.skipped).toEqual([legacy])
    expect(existsSync(legacy)).toBe(true)
  })

  it('leaves the legacy dir untouched when the new dir already exists', () => {
    mkdirSync(join(dshHome, 'memory'), { recursive: true })
    writeFileSync(join(dshHome, 'memory', 'old.jsonl'), row, 'utf8')
    mkdirSync(join(dshHome, 'lmemory'), { recursive: true })
    writeFileSync(join(dshHome, 'lmemory', 'new.jsonl'), row, 'utf8')

    const report = migrateLegacyMemoryDirs()
    expect(report.moved).toEqual([])
    expect(existsSync(join(dshHome, 'memory'))).toBe(true)
  })

  it('migrates project-layer dirs when a cwd is provided', () => {
    const legacy = join(project, '.dsh', 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '2026-08-14.rules.remember.jsonl'), row, 'utf8')

    const report = migrateLegacyMemoryDirs(project)
    expect(report.moved).toContain(legacy)
    expect(existsSync(join(project, '.dsh', 'lmemory', '2026-08-14.rules.remember.jsonl'))).toBe(true)

    // 发现路径也自动迁移:visibleMemoryDirs(cwd) 后新目录可见、旧目录消失。
    const dirs = visibleMemoryDirs(project)
    expect(dirs).toContain(join(project, '.dsh', 'lmemory'))
    expect(existsSync(legacy)).toBe(false)
  })

  it('migrates before write-root resolution (no dual-dir writes)', () => {
    const legacy = join(dshHome, 'memory')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, '2026-08-13.rules.remember.jsonl'), row, 'utf8')

    const roots = memoryWriteRoots(project)
    expect(roots.user).toBe(join(dshHome, 'lmemory'))
    expect(existsSync(legacy)).toBe(false)
  })
})

describe('project-layer precedence', () => {
  it('project file shadows a same-basename user file', () => {
    const roots = memoryWriteRoots(project)
    mkdirSync(join(project, '.dsh', 'lmemory'), { recursive: true })
    // 先在用户层写一条。
    const userDir = roots.user
    mkdirSync(userDir, { recursive: true })
    const base = '2026-08-13.rules.remember'
    writeFileSync(
      join(userDir, `${base}.jsonl`),
      '{"id":"m-0000000000","schemaVersion":2,"createdAt":1750000000000,"type":"rules","domain":"Style","scope":"全项目","layer":"user","entry":"用户层条目","entryPoint":"-","references":"-"}\n',
      'utf8',
    )
    // 项目层同名文件覆盖。
    writeFileSync(
      join(project, '.dsh', 'lmemory', `${base}.jsonl`),
      '{"id":"m-0000000001","schemaVersion":2,"createdAt":1750000000000,"type":"rules","domain":"Style","scope":"全项目","layer":"project","entry":"项目层条目","entryPoint":"-","references":"-"}\n',
      'utf8',
    )
    const entries = discoverEntries(project)
    expect(entries.map(e => e.entry)).toEqual(['项目层条目'])
  })
})

describe('global write roots', () => {
  it('routes global to the global dir regardless of cwd, and exposes all three roots', () => {
    const withCwd = memoryWriteRoots(project)
    expect(withCwd.global).toBe(visibleGlobalDir())
    expect(writeRootFor(project, 'global')).toBe(visibleGlobalDir())
    expect(writeRootFor(undefined, 'global')).toBe(visibleGlobalDir())
    expect(writeRootFor(project, 'user')).toBe(join(dshHome, 'lmemory'))
  })

  it('without a cwd the project write root is empty while global stays available', () => {
    const roots = memoryWriteRoots(undefined)
    expect(roots.project).toBe('')
    expect(roots.global).toBe(visibleGlobalDir())
  })
})

describe('discoverGlobalEntries', () => {
  it('reads only layer=global rows from the global dir', () => {
    const dir = visibleGlobalDir()
    mkdirSync(dir, { recursive: true })
    const rows = [
      JSON.stringify({ id: 'm-0000000001', schemaVersion: 2, createdAt: 1750000000000, type: 'lessons', domain: 'PastFixes', scope: '全项目', layer: 'global', entry: '全局坑', entryPoint: '-', references: '-' }),
      JSON.stringify({ id: 'm-0000000002', schemaVersion: 2, createdAt: 1750000000000, type: 'lessons', domain: 'PastFixes', scope: '全项目', layer: 'user', entry: '混入行', entryPoint: '-', references: '-' }),
    ]
    writeFileSync(join(dir, '2026-08-14.lessons.remember.jsonl'), `${rows.join('\n')}\n`, 'utf8')
    expect(discoverGlobalEntries().map(e => e.entry)).toEqual(['全局坑'])
  })
})

describe('migrateLegacyGlobalEntries', () => {
  const globalRow = JSON.stringify({ id: 'm-0000000001', schemaVersion: 2, createdAt: 1750000000000, type: 'rules', domain: 'Style', scope: '全项目', layer: 'global', entry: '全局两空格', entryPoint: '-', references: '-' })
  const userRow = JSON.stringify({ id: 'm-0000000002', schemaVersion: 2, createdAt: 1750000000000, type: 'rules', domain: 'Style', scope: '全项目', layer: 'user', entry: '用户两空格', entryPoint: '-', references: '-' })

  it('moves legacy global rows into the global dir, rewrites both sides, and is idempotent', () => {
    const userDir = join(dshHome, 'lmemory')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, '2026-08-14.rules.remember.jsonl'), `${globalRow}\n${userRow}\n`, 'utf8')

    const report = migrateLegacyGlobalEntries()
    expect(report.moved).toBe(1)
    // 源文件只留 user 行;global 目录拿到 global 行。
    expect(readFileSync(join(userDir, '2026-08-14.rules.remember.jsonl'), 'utf8')).not.toContain('"layer":"global"')
    expect(discoverGlobalEntries().map(e => e.entry)).toEqual(['全局两空格'])
    // 用户根 catalog 同步重写(只剩 1 条)。
    const userCatalog = JSON.parse(readFileSync(join(userDir, 'catalog.json'), 'utf8'))
    expect(userCatalog.entries).toHaveLength(1)
    // 幂等:第二次零移动。
    expect(migrateLegacyGlobalEntries().moved).toBe(0)
    expect(discoverGlobalEntries()).toHaveLength(1)
  })

  it('produces a global catalog byte-identical to the store rebuild output', () => {
    const userDir = join(dshHome, 'lmemory')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, '2026-08-14.rules.remember.jsonl'), `${globalRow}\n`, 'utf8')

    migrateLegacyGlobalEntries()
    const migratedCatalog = readFileSync(join(visibleGlobalDir(), 'catalog.json'), 'utf8')
    rmSync(join(visibleGlobalDir(), 'catalog.json'))
    rebuild(undefined, [visibleGlobalDir()])
    expect(readFileSync(join(visibleGlobalDir(), 'catalog.json'), 'utf8')).toBe(migratedCatalog)
  })
})

describe('canonicalProjectRoot', () => {
  it('resolves symlink cwds to the real project root', () => {
    const link = join(tmpdir(), `dsh-memory-canon-link-${process.pid}`)
    symlinkSync(project, link)
    expect(canonicalProjectRoot(link)).toBe(project)
    rmSync(link, { force: true })
  })

  it('treats a git-file worktree as its own project root', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'dsh-memory-wt-'))
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/main.git\n', 'utf8')
    // .git 文件同样标记项目根;worktree 是独立 workspace(不做主仓合并)。
    expect(canonicalProjectRoot(worktree)).toBe(realpathSync(worktree))
    rmSync(worktree, { recursive: true, force: true })
  })
})

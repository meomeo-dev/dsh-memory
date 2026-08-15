import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkMarkdown } from '../src/check.js'
import { memoryWriteRoots } from '../src/memory-file.js'
import { isMemoryId } from '../src/schema.js'
import type { MemoryEntryInput, MemoryId } from '../src/schema.js'
import { append, find, rebuild, remove, removeByEntry, update } from '../src/store.js'

function candidate(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    type: 'rules',
    domain: 'DurablePrefs',
    scope: '全项目',
    layer: 'user',
    entry: '提交信息用 Conventional Commits',
    ...overrides,
  }
}

function readCatalog(dir: string): { version: number; entries: Array<Record<string, string>> } | undefined {
  const path = join(dir, 'catalog.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as { version: number; entries: Array<Record<string, string>> }
}

function readAllJsonlLines(dir: string): string[] {
  if (!existsSync(dir)) return []
  const lines: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.remember.jsonl')) continue
    lines.push(...readFileSync(join(dir, name), 'utf8').split('\n').filter(line => line.trim().length > 0))
  }
  return lines
}

let dshHome: string
let agentsHome: string
let project: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-store-dsh-'))
  agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-store-agents-'))
  project = mkdtempSync(join(tmpdir(), 'dsh-memory-store-proj-'))
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

describe('append', () => {
  it('writes an id-bearing jsonl row, a valid markdown twin, and a catalog entry', () => {
    const result = append(project, candidate())
    expect(result.duplicate).toBe(false)
    expect(isMemoryId(result.entry.id)).toBe(true)
    expect(result.jsonlPath).toBeDefined()
    expect(result.mdPath).toBeDefined()

    const jsonl = readFileSync(result.jsonlPath!, 'utf8')
    expect(jsonl).toContain(`"id":"${result.entry.id}"`)
    expect(jsonl).toContain('"schemaVersion":2')
    expect(jsonl).toContain(`"createdAt":${result.entry.createdAt}`)
    expect(Number.isInteger(result.entry.createdAt)).toBe(true)
    expect(jsonl).toContain('"entry":"提交信息用 Conventional Commits"')
    expect(checkMarkdown(readFileSync(result.mdPath!, 'utf8'))).toEqual([])

    const catalog = readCatalog(memoryWriteRoots(project).user)!
    expect(catalog.version).toBe(1)
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]!.id).toBe(result.entry.id)
    expect(catalog.entries[0]!.file).toMatch(/\.rules\.remember\.jsonl$/)
  })

  it('assigns a distinct id to every appended entry', () => {
    const first = append(project, candidate())
    const second = append(project, candidate({ type: 'lessons', domain: 'PromotedPitfalls', entry: '某坑' }))
    expect(first.entry.id).not.toBe(second.entry.id)
  })

  it('rejects a duplicate rules entry (append-only) without writing again', () => {
    const first = append(project, candidate())
    const again = append(project, candidate())
    expect(first.duplicate).toBe(false)
    expect(again.duplicate).toBe(true)
    expect(again.jsonlPath).toBeUndefined()
    expect(find(project, { type: 'rules' })).toHaveLength(1)
  })

  it('routes project-layer entries to the project write root', () => {
    const result = append(project, candidate({ layer: 'project' }))
    expect(result.jsonlPath).toContain(join(project, '.dsh', 'lmemory'))
    expect(readCatalog(memoryWriteRoots(project).project)!.entries).toHaveLength(1)
  })

  it('persists non-empty entryPoint and references through jsonl, md, and catalog', () => {
    const result = append(project, candidate({
      entryPoint: 'CLAUDE.md',
      references: '<repo>/docs/concept.md',
    }))
    // jsonl 真相源保留两个非空字段。
    const jsonl = readFileSync(result.jsonlPath!, 'utf8')
    expect(jsonl).toContain('"entryPoint":"CLAUDE.md"')
    expect(jsonl).toContain('"references":"<repo>/docs/concept.md"')
    // MD 渲染投影同样保留(表格单元格含这两个路径)。
    const md = readFileSync(result.mdPath!, 'utf8')
    expect(md).toContain('CLAUDE.md')
    expect(md).toContain('<repo>/docs/concept.md')
    // find 返回完整字段。
    const found = find(project, { id: result.entry.id })
    expect(found[0]!.entry.entryPoint).toBe('CLAUDE.md')
    expect(found[0]!.entry.references).toBe('<repo>/docs/concept.md')
  })
})

describe('update', () => {
  it('mutates allowed fields while keeping the id stable and syncing the catalog', () => {
    const appended = append(project, candidate())
    const updated = update(project, appended.entry.id, { entry: '新条目', scope: 'Web UI' })
    expect(updated.entry.id).toBe(appended.entry.id)
    expect(updated.entry.entry).toBe('新条目')
    expect(updated.entry.scope).toBe('Web UI')
    expect(updated.entry.type).toBe('rules')

    const found = find(project, { id: appended.entry.id })
    expect(found).toHaveLength(1)
    expect(found[0]!.entry.entry).toBe('新条目')

    const catalog = readCatalog(memoryWriteRoots(project).user)!
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]!.entry).toBe('新条目')
  })

  it('throws for an unknown id', () => {
    expect(() => update(project, 'm-0000000000' as MemoryId, { entry: 'x' })).toThrow(/no entry with id/)
  })
})

describe('remove', () => {
  it('deletes by id, empties the catalog entry, and keeps an empty table skeleton', () => {
    const appended = append(project, candidate())
    const result = remove(project, appended.entry.id)
    expect(result.removed).toBe(true)
    expect(find(project, { id: appended.entry.id })).toHaveLength(0)

    expect(readCatalog(memoryWriteRoots(project).user)!.entries).toHaveLength(0)

    const md = readFileSync(appended.mdPath!, 'utf8')
    expect(checkMarkdown(md)).toEqual([])
    expect(md.trimEnd().split('\n')).toHaveLength(2)
  })

  it('reports removed:false for an unknown id', () => {
    expect(remove(project, 'm-0000000000' as MemoryId).removed).toBe(false)
  })
})

describe('removeByEntry', () => {
  it('deletes exact-entry matches with an optional type filter', () => {
    append(project, candidate())
    append(project, candidate({ type: 'lessons', domain: 'PromotedPitfalls', entry: '某坑' }))

    expect(removeByEntry(project, '某坑', 'rules')).toBe(0)
    expect(removeByEntry(project, '某坑', 'lessons')).toBe(1)
    expect(find(project, { type: 'lessons' })).toHaveLength(0)
  })
})

describe('find', () => {
  it('locates by id and filters by type / domain / layer', () => {
    const rules = append(project, candidate())
    append(project, candidate({ type: 'lessons', domain: 'CodeFacts', scope: '样本库', layer: 'project', entry: '某模块在 X' }))

    const byId = find(project, { id: rules.entry.id })
    expect(byId).toHaveLength(1)
    expect(byId[0]!.file).toMatch(/\.remember\.jsonl$/)

    const lessons = find(project, { type: 'lessons' })
    expect(lessons).toHaveLength(1)
    expect(lessons[0]!.entry.domain).toBe('CodeFacts')

    const byLayer = find(project, { layer: 'project' })
    expect(byLayer).toHaveLength(1)
    expect(byLayer[0]!.entry.scope).toBe('样本库')
  })
})

describe('legacy migration + rebuild', () => {
  it('migrates id-less rows on read and rebuilds the catalog from jsonl', () => {
    const dir = memoryWriteRoots(project).user
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '2026-08-13.rules.remember.jsonl'),
      '{"type":"rules","domain":"Style","scope":"全项目","layer":"user","entry":"两空格缩进","entryPoint":"-","references":"-"}\n',
      'utf8',
    )

    const found = find(project, { type: 'rules' })
    expect(found).toHaveLength(1)
    expect(isMemoryId(found[0]!.entry.id)).toBe(true)
    // 补齐的 id / createdAt 已落盘(惰性迁移持久化);createdAt 按文件名日期回填(本地零点)。
    expect(found[0]!.entry.createdAt).toBe(new Date(2026, 7, 13).getTime())
    expect(readAllJsonlLines(dir).join('\n')).toContain(`"id":"${found[0]!.entry.id}"`)

    rebuild(project)
    const catalog = readCatalog(dir)!
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]!.id).toBe(found[0]!.entry.id)
  })

  it('makes jsonl authoritative on rebuild (manual jsonl edits win)', () => {
    const dir = memoryWriteRoots(project).user
    append(project, candidate())
    // 手动塞一行旧格式(无 id)模拟人编辑 jsonl。
    writeFileSync(
      join(dir, '2026-08-13.lessons.remember.jsonl'),
      '{"type":"lessons","domain":"PastFixes","scope":"全项目","layer":"user","entry":"某 bug 根因","entryPoint":"-","references":"-"}\n',
      'utf8',
    )

    rebuild(project)
    const catalog = readCatalog(dir)!
    expect(catalog.entries).toHaveLength(2)
    const lessons = catalog.entries.filter(e => e.type === 'lessons')
    expect(lessons).toHaveLength(1)
    expect(isMemoryId(lessons[0]!.id as MemoryId)).toBe(true)
  })
})

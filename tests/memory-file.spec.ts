import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendEntry,
  discoverEntries,
  discoverFiles,
  forget,
  memoryWriteRoots,
} from '../src/memory-file.js'
import { checkMarkdown } from '../src/check.js'
import type { MemoryEntry } from '../src/schema.js'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: 'rules',
    domain: 'DurablePrefs',
    scope: 'user',
    layer: 'user',
    entry: '提交信息用 Conventional Commits',
    entryPoint: '-',
    references: '-',
    ...overrides,
  }
}

let dshHome: string
let agentsHome: string
let project: string
const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-dsh-'))
  agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-agents-'))
  project = mkdtempSync(join(tmpdir(), 'dsh-memory-proj-'))
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
    expect(roots.user).toBe(join(dshHome, 'memory'))
    expect(roots.project).toBe(join(project, '.dsh', 'memory'))
  })
})

describe('appendEntry + discover', () => {
  it('writes a jsonl row and renders a valid markdown twin', () => {
    const { jsonlPath, mdPath } = appendEntry(project, entry())
    const jsonl = readFileSync(jsonlPath, 'utf8')
    const md = readFileSync(mdPath, 'utf8')
    expect(jsonl.trim().split('\n')).toHaveLength(1)
    expect(jsonl).toContain('"entry":"提交信息用 Conventional Commits"')
    expect(checkMarkdown(md)).toEqual([])
    expect(md).toContain('提交信息用 Conventional Commits')
  })

  it('discovers the written entry via user scope', () => {
    appendEntry(project, entry())
    const entries = discoverEntries(project)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.entry).toBe('提交信息用 Conventional Commits')
  })

  it('appends to the same day file rather than overwriting', () => {
    appendEntry(project, entry())
    appendEntry(project, entry({ type: 'lessons', entry: '某 API 已改签名', domain: 'PromotedPitfalls' }))
    // lessons 落到独立的 lessons 文件,故 rules 文件仍只有一条。
    const rules = discoverEntries(project).filter(e => e.type === 'rules')
    const lessons = discoverEntries(project).filter(e => e.type === 'lessons')
    expect(rules).toHaveLength(1)
    expect(lessons).toHaveLength(1)
  })
})

describe('forget', () => {
  it('removes an exact-entry match and re-renders the markdown', () => {
    appendEntry(project, entry())
    appendEntry(project, entry({ type: 'lessons', entry: '某坑', domain: 'PromotedPitfalls' }))

    const removed = forget(project, '某坑')
    expect(removed).toBe(1)
    expect(discoverEntries(project).map(e => e.entry)).toEqual(['提交信息用 Conventional Commits'])

    // 受影响文件的 md 仍通过静态检查。
    for (const file of discoverFiles(project)) {
      expect(checkMarkdown(readFileSync(file.mdPath, 'utf8'))).toEqual([])
    }
  })

  it('removes nothing for a non-matching entry', () => {
    appendEntry(project, entry())
    expect(forget(project, '不存在')).toBe(0)
  })

  it('filters by type', () => {
    appendEntry(project, entry())
    appendEntry(project, entry({ type: 'lessons', entry: '某坑', domain: 'PromotedPitfalls' }))
    expect(forget(project, '某坑', 'rules')).toBe(0)
    expect(forget(project, '某坑', 'lessons')).toBe(1)
  })
})

describe('project-layer precedence', () => {
  it('project file shadows a same-basename user file', () => {
    const roots = memoryWriteRoots(project)
    mkdirSync(join(project, '.dsh', 'memory'), { recursive: true })
    // 先在用户层写一条。
    const userDir = roots.user
    mkdirSync(userDir, { recursive: true })
    const base = '2026-08-13.rules.remember'
    writeFileSync(
      join(userDir, `${base}.jsonl`),
      '{"type":"rules","domain":"Style","scope":"user","layer":"user","entry":"用户层条目","entryPoint":"-","references":"-"}\n',
      'utf8',
    )
    // 项目层同名文件覆盖。
    writeFileSync(
      join(project, '.dsh', 'memory', `${base}.jsonl`),
      '{"type":"rules","domain":"Style","scope":"project","layer":"project","entry":"项目层条目","entryPoint":"-","references":"-"}\n',
      'utf8',
    )
    const entries = discoverEntries(project)
    expect(entries.map(e => e.entry)).toEqual(['项目层条目'])
  })
})

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GLOBAL_EXTRACT_LESSONS_SYSTEM,
  GLOBAL_EXTRACT_RULES_SYSTEM,
  GLOBAL_PROMOTE_SYSTEM,
  promoteSourceEntries,
  runGlobalExtractFanOut,
  runGlobalPromoteFanOut,
} from '../src/global-gate.js'
import type { MemoryEntry } from '../src/schema.js'
import { refreshRegistry } from '../src/registry.js'

const PASS_LINE = 'rules|Style|全项目|两空格缩进是跨项目共识|-|-|pass'
const REJECT_LINE = 'lessons|PastFixes|全项目|某坑但太局限于单项目|-|-|reject|太局限'

/** 只回显 pass 行的 mock 抽取器。 */
const echo = async (text: string): Promise<string> => `${PASS_LINE}\n${REJECT_LINE}\n`

describe('runGlobalExtractFanOut', () => {
  it('aggregates pass-only candidates; reject lines never reach the result set', async () => {
    const candidates = await runGlobalExtractFanOut(
      [{ id: 'chunk-1', text: '文档' }],
      echo,
      echo,
      () => {},
    )
    expect(candidates.map(candidate => candidate.entry)).toEqual(['两空格缩进是跨项目共识'])
    expect(candidates.every(candidate => candidate.verdict === 'pass')).toBe(true)
  })

  it('keeps each node type to its own rows', async () => {
    const rulesFn = async (): Promise<string> => PASS_LINE
    const lessonsFn = async (): Promise<string> => 'lessons|PastFixes|全项目|一个跨项目通用的坑根因|-|-|pass'
    const candidates = await runGlobalExtractFanOut([{ id: 'c', text: 'x' }], rulesFn, lessonsFn, () => {})
    expect(candidates.map(candidate => candidate.type)).toEqual(['rules', 'lessons'])
  })

  it('degrades per chunk: both-failed chunks warn and skip; all chunks failed throws', async () => {
    const failures: string[] = []
    const candidates = await runGlobalExtractFanOut(
      [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
      async (text) => text === 'x' ? Promise.reject(new Error('down')) : PASS_LINE,
      echo,
      (type, error) => failures.push(`${type}:${error instanceof Error ? error.message : String(error)}`),
    )
    expect(candidates).toHaveLength(1)
    expect(failures).toContain('rules:down')

    await expect(runGlobalExtractFanOut(
      [{ id: 'a', text: 'x' }],
      async () => Promise.reject(new Error('down')),
      async () => Promise.reject(new Error('down too')),
      () => {},
    )).rejects.toThrow(/all extractors failed/)
  })

  it('returns empty for no chunks without calling any extractor', async () => {
    let called = false
    const spy = async (): Promise<string> => { called = true; return '' }
    expect(await runGlobalExtractFanOut([], spy, spy, () => {})).toEqual([])
    expect(called).toBe(false)
  })
})

describe('runGlobalPromoteFanOut', () => {
  const entry = (i: number): MemoryEntry => ({
    id: `m-000000000${i}`, schemaVersion: 2, createdAt: 1750000000000,
    type: 'rules', domain: 'Style', scope: '全项目', layer: 'user',
    entry: `用户条目 ${i} 的内容足够长`, entryPoint: '-', references: '-',
  })

  it('parses per-node verdicts and aggregates pass-only with cross-node dedup', async () => {
    const nodeFn = async (): Promise<string> => `${PASS_LINE}\n${REJECT_LINE}\n${PASS_LINE}\n`
    const candidates = await runGlobalPromoteFanOut([entry(1), entry(2)], 600, nodeFn, () => {})
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.verdict).toBe('pass')
  })

  it('degrades per node and throws only when every node fails', async () => {
    // 超容量源独占一个节点(partitionNodes 打包器语义)→ 两条长条目 = 2 个节点。
    const long = (i: number): MemoryEntry => ({ ...entry(i), entry: `用户条目 ${i} ${'长内容'.repeat(200)}` })
    let calls = 0
    const flaky = async (): Promise<string> => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return PASS_LINE
    }
    const candidates = await runGlobalPromoteFanOut([long(1), long(2)], 1, flaky, () => {})
    expect(candidates).toHaveLength(1)

    await expect(runGlobalPromoteFanOut([entry(1)], 600, async () => { throw new Error('down') }, () => {}))
      .rejects.toThrow(/all nodes failed/)
  })

  it('never calls the node fn for empty sources (unconfirmed = zero calls)', async () => {
    let called = false
    const nodeFn = async (): Promise<string> => { called = true; return PASS_LINE }
    expect(await runGlobalPromoteFanOut([], 600, nodeFn, () => {})).toEqual([])
    expect(called).toBe(false)
  })
})

describe('promote read-only + source isolation', () => {
  let dshHome: string
  let project: string
  const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-flow-dsh-'))
    project = mkdtempSync(join(tmpdir(), 'dsh-memory-flow-proj-'))
    process.env.DSH_HOME = dshHome
    process.env.DSH_AGENTS_HOME = join(dshHome, 'agents')
  })

  afterEach(() => {
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    if (saved.dsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.dsh
    if (saved.agents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = saved.agents
  })

  it('promoteSourceEntries is read-only and only sees user/project layers', () => {
    const userDir = join(dshHome, 'lmemory')
    mkdirSync(userDir, { recursive: true })
    const row = (id: string, layer: string, entry: string): string =>
      JSON.stringify({ id, schemaVersion: 2, createdAt: 1750000000000, type: 'rules', domain: 'Style', scope: '全项目', layer, entry, entryPoint: '-', references: '-' })
    const userJsonl = join(userDir, '2026-08-14.rules.remember.jsonl')
    writeFileSync(userJsonl, `${row('m-0000000001', 'user', '用户条目内容足够长')}\n`)
    mkdirSync(join(project, '.dsh', 'lmemory'), { recursive: true })
    writeFileSync(join(project, '.dsh', 'lmemory', '2026-08-14.rules.remember.jsonl'), `${row('m-0000000002', 'project', '项目条目内容足够长')}\n`)
    mkdirSync(join(userDir, 'global'), { recursive: true })
    writeFileSync(join(userDir, 'global', '2026-08-14.rules.remember.jsonl'), `${row('m-0000000003', 'global', 'global 条目不得进入提升源')}\n`)
    refreshRegistry(project)

    const before = readFileSync(userJsonl, 'utf8')
    const entries = promoteSourceEntries()
    // 读后源文件字节不变(只读)。
    expect(readFileSync(userJsonl, 'utf8')).toBe(before)
    expect(entries.map(e => e.layer).sort()).toEqual(['project', 'user'])
    expect(entries.every(e => e.layer !== 'global')).toBe(true)
  })
})

describe('G3 invariants (grep-level source locks)', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
  const gateSource = readFileSync(fileURLToPath(new URL('../src/global-gate.ts', import.meta.url)), 'utf8')

  it('remember tool layer enum excludes global while memory-find keeps all three', () => {
    expect(indexSource).toContain("enum: ['user', 'project'], description: 'Storage layer")
    expect(indexSource).not.toContain("enum: ['global', 'user', 'project'], description: 'Storage layer")
    expect(indexSource).toContain("enum: ['global', 'user', 'project'], description: 'Filter by storage layer")
  })

  it('global-gate.ts is pure orchestration: no disk writes, no store mutations', () => {
    expect(gateSource).not.toContain('writeFileSync')
    expect(gateSource).not.toContain('append(')
    expect(gateSource).not.toContain("from './store.js'")
  })

  it('writeGlobalCandidates writes only via append (no update/remove paths)', () => {
    const start = indexSource.indexOf('function writeGlobalCandidates')
    const end = indexSource.indexOf('\nfunction ', start + 1)
    const body = indexSource.slice(start, end)
    expect(body).toContain('append(')
    expect(body).not.toContain('update(')
    expect(body).not.toContain('remove(')
  })

  it('extract prompts carry only global admission standards, not other-layer content', () => {
    for (const prompt of [GLOBAL_EXTRACT_RULES_SYSTEM, GLOBAL_EXTRACT_LESSONS_SYSTEM]) {
      expect(prompt).not.toMatch(/用户层|项目层/)
      expect(prompt).toContain('global 记忆')
      expect(prompt).toContain('verdict')
    }
    // 提升评审 prompt 声明其输入域(user/project),不含 global 目录条目作为输入。
    expect(GLOBAL_PROMOTE_SYSTEM).toContain('来自用户层与项目层的长期记忆条目')
  })
})

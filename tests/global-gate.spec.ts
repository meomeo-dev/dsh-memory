import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aggregateGlobalCandidates,
  checkGlobalGate,
  chunkDocument,
  GLOBAL_PROMOTE_MAX,
  MIN_GLOBAL_ENTRY_CHARS,
  parseGlobalCandidates,
  promoteSourceEntries,
  resolvePromotePlan,
} from '../src/global-gate.js'
import { loadRegistry, refreshRegistry, REGISTRY_FORMAT_VERSION, saveRegistry } from '../src/registry.js'

const gate = (overrides: Record<string, unknown> = {}): Parameters<typeof checkGlobalGate>[0] => ({
  type: 'rules',
  domain: 'Style',
  scope: '全项目',
  entry: '提交信息用 Conventional Commits 前缀',
  ...overrides,
})

describe('checkGlobalGate', () => {
  it('passes a well-formed candidate within size bounds', () => {
    expect(checkGlobalGate(gate())).toEqual({ pass: true })
  })

  it('rejects an illegal type', () => {
    expect(checkGlobalGate(gate({ type: 'bogus' }))).toEqual({ pass: false, reason: 'type "bogus" is not rules/lessons' })
  })

  it('rejects an unknown domain', () => {
    expect(checkGlobalGate(gate({ domain: 'Nope' }))).toEqual({ pass: false, reason: 'domain "Nope" is not a known domain' })
  })

  it('rejects a blank scope', () => {
    expect(checkGlobalGate(gate({ scope: '  ' }))).toEqual({ pass: false, reason: 'scope is empty' })
  })

  it('rejects entries below the minimum and above the maximum size', () => {
    expect(checkGlobalGate(gate({ entry: '太短' })).pass).toBe(false)
    expect(checkGlobalGate(gate({ entry: 'x'.repeat(MIN_GLOBAL_ENTRY_CHARS) })).pass).toBe(true)
    expect(checkGlobalGate(gate({ entry: 'x'.repeat(301) })).pass).toBe(false)
  })
})

describe('parseGlobalCandidates', () => {
  it('parses the 7-segment line with verdict and optional reason', () => {
    const parsed = parseGlobalCandidates(
      'rules|Style|全项目|两空格缩进是跨项目共识|src/index.ts|docs/a.md|pass\n'
      + 'lessons|PastFixes|全项目|某坑根因足够长跨项目通用|-|-|reject|太局限\n',
    )
    expect(parsed).toEqual([
      { type: 'rules', domain: 'Style', scope: '全项目', entry: '两空格缩进是跨项目共识', entryPoint: 'src/index.ts', references: 'docs/a.md', verdict: 'pass' },
      { type: 'lessons', domain: 'PastFixes', scope: '全项目', entry: '某坑根因足够长跨项目通用', verdict: 'reject', reason: '太局限' },
    ])
  })

  it('normalizes - paths to undefined and drops malformed lines without throwing', () => {
    const parsed = parseGlobalCandidates([
      'rules|Style|全项目|两空格缩进是跨项目共识|-|-|pass',
      'bogus|Style|全项目|非法 type 行|pass',
      'rules|Nope|全项目|非法 domain 行|pass',
      'rules|Style||空白 scope 行|pass',
      'rules|Style|全项目|两空格缩进是跨项目共识|pass|no verdict',
      '',
      'rules|Style|全项目|合法行|-|-|pass',
    ].join('\n'))
    expect(parsed.map(candidate => candidate.entry)).toEqual(['两空格缩进是跨项目共识', '合法行'])
    expect(parsed[0]!.entryPoint).toBeUndefined()
  })
})

describe('aggregateGlobalCandidates', () => {
  const cand = (entry: string, verdict: 'pass' | 'reject' = 'pass', type = 'rules' as const): ReturnType<typeof parseGlobalCandidates>[number] => ({
    type, domain: 'Style', scope: '全项目', entry, verdict,
  })

  it('keeps pass-only, dedupes by entry across nodes, and caps at max in stable order', () => {
    const aggregated = aggregateGlobalCandidates([
      [cand('条目 A'), cand('条目 B', 'reject'), cand('条目 C')],
      [cand('条目 A'), cand('条目 D')],
      [cand('条目 E')],
    ], 3)
    // 节点序 → 行序;A 第二次出现被去重;B 是 reject 不入集;取前 3。
    expect(aggregated.map(candidate => candidate.entry)).toEqual(['条目 A', '条目 C', '条目 D'])
  })

  it('defaults to GLOBAL_PROMOTE_MAX and returns fewer when fewer pass', () => {
    const many = Array.from({ length: GLOBAL_PROMOTE_MAX + 5 }, (_, i) => cand(`条目 ${i}`))
    expect(aggregateGlobalCandidates([many])).toHaveLength(GLOBAL_PROMOTE_MAX)
    expect(aggregateGlobalCandidates([])).toEqual([])
  })
})

describe('chunkDocument', () => {
  it('returns no sources for empty text', () => {
    expect(chunkDocument('', 100)).toEqual([])
  })

  it('keeps short text as one source', () => {
    const sources = chunkDocument('短文档', 100)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.text).toBe('短文档')
  })

  it('prefers paragraph boundaries, then sentence ends, then newlines, then hard cuts', () => {
    const text = 'A'.repeat(60) + '\n\n' + 'B'.repeat(80) + '\n\n' + 'C'.repeat(60)
    const sources = chunkDocument(text, 100)
    expect(sources.map(source => source.text)).toEqual(['A'.repeat(60) + '\n\n', 'B'.repeat(80) + '\n\n', 'C'.repeat(60)])

    const sentences = chunkDocument('甲'.repeat(80) + '。' + '乙'.repeat(120), 100)
    expect(sentences.map(source => source.text)).toEqual(['甲'.repeat(80) + '。', '乙'.repeat(100), '乙'.repeat(20)])

    const newline = chunkDocument('x'.repeat(90) + '\n' + 'y'.repeat(90), 100)
    expect(newline).toHaveLength(2)
    expect(newline[0]!.text).toBe('x'.repeat(90) + '\n')

    const hard = chunkDocument('z'.repeat(250), 100)
    expect(hard).toHaveLength(3)
    expect(hard[0]!.text).toBe('z'.repeat(100))
  })

  it('loses no characters across chunks', () => {
    const text = '段一\n\n段二段落比较长' + '。句末。'.repeat(30) + '\n尾行'
    const joined = chunkDocument(text, 40).map(source => source.text).join('')
    expect(joined).toBe(text)
  })
})

describe('promoteSourceEntries', () => {
  let dshHome: string
  let agentsHome: string
  let project: string
  const saved = { dsh: process.env.DSH_HOME, agents: process.env.DSH_AGENTS_HOME }

  const row = (id: string, layer: string, entry: string): string =>
    JSON.stringify({ id, schemaVersion: 2, createdAt: 1750000000000, type: 'rules', domain: 'Style', scope: '全项目', layer, entry, entryPoint: '-', references: '-' })

  beforeEach(() => {
    dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-gate-dsh-'))
    agentsHome = mkdtempSync(join(tmpdir(), 'dsh-memory-gate-agents-'))
    project = mkdtempSync(join(tmpdir(), 'dsh-memory-gate-proj-'))
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

  it('collects basename-merged user roots plus still-existing project roots, skipping global', () => {
    // 用户两层同名文件:dsh 覆盖 agents。
    mkdirSync(join(dshHome, 'lmemory'), { recursive: true })
    mkdirSync(join(agentsHome, 'lmemory'), { recursive: true })
    writeFileSync(join(dshHome, 'lmemory', '2026-08-14.rules.remember.jsonl'), `${row('m-0000000001', 'user', 'dsh 用户条目')}\n`)
    writeFileSync(join(agentsHome, 'lmemory', '2026-08-14.rules.remember.jsonl'), `${row('m-0000000002', 'user', 'agents 用户条目')}\n${row('m-0000000003', 'global', '不该出现的 global 行')}\n`)
    // 项目根经 registry 登记(存在);global 根与已消失的根跳过。
    mkdirSync(join(project, '.dsh', 'lmemory'), { recursive: true })
    writeFileSync(join(project, '.dsh', 'lmemory', '2026-08-14.lessons.remember.jsonl'), `${row('m-0000000004', 'project', '项目条目')}\n`)
    refreshRegistry(project)
    const gone = mkdtempSync(join(tmpdir(), 'dsh-memory-gate-gone-'))
    saveRegistry({
      formatVersion: REGISTRY_FORMAT_VERSION,
      updatedAt: 1750000000000,
      roots: [...loadRegistry().roots, { root: join(gone, '.dsh', 'lmemory'), kind: 'project' as const, firstSeenAt: 1, lastSeenAt: 1, entries: 9, files: 1 }],
    })
    mkdirSync(join(dshHome, 'lmemory', 'global'), { recursive: true })
    writeFileSync(join(dshHome, 'lmemory', 'global', '2026-08-14.rules.remember.jsonl'), `${row('m-0000000005', 'global', 'global 目录条目')}\n`)
    rmSync(gone, { recursive: true, force: true })

    const entries = promoteSourceEntries()
    expect(entries.map(entry => entry.entry)).toEqual(['dsh 用户条目', '项目条目'])
    expect(entries.every(entry => entry.layer !== 'global')).toBe(true)
  })
})

describe('resolvePromotePlan', () => {
  it('computes node count from capacity without any model parameters (structural guarantee)', () => {
    const entry = (i: number) => ({
      id: `m-000000000${i}`, schemaVersion: 2, createdAt: 1750000000000,
      type: 'rules' as const, domain: 'Style' as const, scope: '全项目', layer: 'user' as const,
      entry: `条目 ${i} 跨项目通用内容`.repeat(20), entryPoint: '-', references: '-',
    })
    const plan = resolvePromotePlan(Array.from({ length: 5 }, (_, i) => entry(i)), 1)
    expect(plan.nodeCount).toBeGreaterThan(0)
    expect(plan.sources).toHaveLength(5)
    expect(resolvePromotePlan([], 1)).toEqual({ nodeCount: 0, sources: [] })
    // 返回面不含任何模型 / 回调参数:未确认发调用在类型层面不可能。
    expect(Object.keys(plan)).toEqual(['nodeCount', 'sources'])
  })
})

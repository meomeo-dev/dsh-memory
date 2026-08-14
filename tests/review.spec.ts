import { describe, expect, it } from 'vitest'
import { warmUp } from '../src/team.js'
import {
  dedupeFindings,
  parseFindings,
  renderReviewReport,
  reviewEntryLine,
  reviewSourcesFor,
  reviewTeam,
  runReview,
} from '../src/review.js'
import type { CrossNodeReviewFn, NodeReviewFn, ReviewFinding } from '../src/review.js'
import type { MemoryEntry, MemoryId } from '../src/schema.js'

function entry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: id as MemoryId,
    type: 'rules',
    domain: 'DurablePrefs',
    scope: '全项目',
    layer: 'user',
    entry: '用户偏好使用 pnpm 管理依赖',
    entryPoint: '-',
    references: '-',
    ...overrides,
  }
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'm-0000000000' as MemoryId,
    problem: 'contradiction',
    related: [],
    note: '互相矛盾',
    suggest: 'update',
    ...overrides,
  }
}

describe('reviewEntryLine', () => {
  it('renders an entry with id, type, domain, and scope', () => {
    const line = reviewEntryLine(entry('m-3k9f2x8q1a', { type: 'lessons', domain: 'CodeFacts', scope: '样本库' }))
    expect(line).toBe('[m-3k9f2x8q1a|lessons|CodeFacts|样本库] 用户偏好使用 pnpm 管理依赖')
  })
})

describe('reviewSourcesFor / reviewTeam', () => {
  it('turns each entry into an id-bearing source and partitions them into nodes', () => {
    const entries = [entry('m-0000000000'), entry('m-0000000001')]
    const sources = reviewSourcesFor(entries)
    expect(sources).toHaveLength(2)
    expect(sources[0]!.id).toBe('m-0000000000')
    expect(sources[0]!.text).toContain('[m-0000000000|rules|DurablePrefs|全项目]')

    // maxNodeKb=1 → 每源 1024 字节上限;两条小源装进一个节点。
    const team = reviewTeam(entries, 1)
    expect(team.nodes).toHaveLength(1)
    expect(team.nodes[0]!.text).toContain('[m-0000000000|')
    expect(team.nodes[0]!.text).toContain('[m-0000000001|')
  })
})

describe('runReview', () => {
  it('fans out to every node and merges intra-node findings', async () => {
    const entries = [entry('m-0000000000'), entry('m-0000000001'), entry('m-0000000002')]
    const pad = 'x'.repeat(1024)
    // 三个超容量源各占一个节点。
    const team = warmUp([
      { id: 'm-0000000000', text: `${pad} [m-0000000000|rules|DurablePrefs|全项目] 用 pnpm` },
      { id: 'm-0000000001', text: `${pad} [m-0000000001|rules|DurablePrefs|全项目] 用 npm` },
      { id: 'm-0000000002', text: `${pad} [m-0000000002|rules|DurablePrefs|全项目] 两空格缩进` },
    ], 1)
    expect(team.nodes).toHaveLength(3)

    const nodeReviewFn: NodeReviewFn = async (node) =>
      node.text.includes('npm')
        ? [finding({ id: 'm-0000000000', related: ['m-0000000001' as MemoryId] })]
        : []
    const crossNodeReviewFn: CrossNodeReviewFn = async () => []
    const result = await runReview(team, entries, nodeReviewFn, crossNodeReviewFn)
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('m-0000000000')
    expect(result[0]!.related).toEqual(['m-0000000001'])
  })

  it('captures cross-node contradictions/duplicates when entries span nodes', async () => {
    const entries = [entry('m-0000000000'), entry('m-0000000001')]
    const pad = 'x'.repeat(1024)
    const team = warmUp([
      { id: 'a', text: pad },
      { id: 'b', text: pad },
    ], 1)

    const nodeReviewFn: NodeReviewFn = async () => []
    const crossNodeReviewFn: CrossNodeReviewFn = async () => [
      finding({ id: 'm-0000000000', problem: 'duplicate', related: ['m-0000000001' as MemoryId], suggest: 'merge' }),
    ]
    const result = await runReview(team, entries, nodeReviewFn, crossNodeReviewFn)
    expect(result).toHaveLength(1)
    expect(result[0]!.problem).toBe('duplicate')
  })

  it('skips cross-node judgement when there is a single node', async () => {
    const entries = [entry('m-0000000000')]
    const team = warmUp([{ id: 'a', text: 'x' }], 1)
    let crossCalled = false
    const crossNodeReviewFn: CrossNodeReviewFn = async () => {
      crossCalled = true
      return []
    }
    await runReview(team, entries, async () => [], crossNodeReviewFn)
    expect(crossCalled).toBe(false)
  })

  it('dedupes a finding reported by both intra-node and cross-node passes', async () => {
    const entries = [entry('m-0000000000'), entry('m-0000000001')]
    const pad = 'x'.repeat(1024)
    const team = warmUp([{ id: 'a', text: pad }, { id: 'b', text: pad }], 1)
    const shared = finding({ id: 'm-0000000000', related: ['m-0000000001' as MemoryId] })
    const nodeReviewFn: NodeReviewFn = async () => [shared]
    const crossNodeReviewFn: CrossNodeReviewFn = async () => [shared]
    const result = await runReview(team, entries, nodeReviewFn, crossNodeReviewFn)
    expect(result).toHaveLength(1)
  })
})

describe('dedupeFindings', () => {
  it('keeps the first of same-problem same-id-set findings', () => {
    const a = finding({ id: 'm-0000000000', related: ['m-0000000001' as MemoryId] })
    const b = finding({ id: 'm-0000000001', related: ['m-0000000000' as MemoryId] })
    const c = finding({ id: 'm-0000000000', problem: 'outdated', related: [] })
    expect(dedupeFindings([a, b, c])).toEqual([a, c])
  })
})

describe('parseFindings', () => {
  const ids = new Set(['m-0000000000', 'm-0000000001'] as MemoryId[])

  it('parses a JSON array of findings and drops invalid ids/problems/suggests', () => {
    const text = JSON.stringify([
      { id: 'm-0000000000', problem: 'contradiction', related: ['m-0000000001'], note: '冲突', suggest: 'update', suggestedEntry: '用 pnpm' },
      { id: 'm-madeupid!', problem: 'contradiction', related: [], note: '非法 id', suggest: 'update' },
      { id: 'm-0000000001', problem: 'bogus', related: [], note: '非法类别', suggest: 'update' },
      { id: 'm-0000000001', problem: 'outdated', related: [], note: '过时', suggest: 'delete' },
    ])
    const findings = parseFindings(text, ids)
    expect(findings).toHaveLength(2)
    expect(findings[0]!.suggestedEntry).toBe('用 pnpm')
    expect(findings[1]!.problem).toBe('outdated')
  })

  it('extracts the first balanced array even with surrounding prose', () => {
    const text = `Here are the issues:\n${JSON.stringify([
      { id: 'm-0000000000', problem: 'divergence', related: [], note: '背离', suggest: 'update' },
    ])}\nThat is all.`
    const findings = parseFindings(text, ids)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.problem).toBe('divergence')
  })

  it('filters related ids that are unknown', () => {
    const text = JSON.stringify([
      { id: 'm-0000000000', problem: 'duplicate', related: ['m-0000000001', 'm-nope00000'], note: '重复', suggest: 'merge' },
    ])
    const findings = parseFindings(text, ids)
    expect(findings[0]!.related).toEqual(['m-0000000001'])
  })

  it('returns empty for non-JSON or non-array output', () => {
    expect(parseFindings('not json at all', ids)).toEqual([])
    expect(parseFindings('{"a":1}', ids)).toEqual([])
  })
})

describe('renderReviewReport', () => {
  it('renders an empty report', () => {
    expect(renderReviewReport([])).toBe('Memory review found no issues.')
  })

  it('renders each finding with id, problem, suggest, and suggestedEntry', () => {
    const report = renderReviewReport([
      finding({ id: 'm-0000000000', related: ['m-0000000001' as MemoryId], suggest: 'merge' }),
      finding({ id: 'm-0000000002', problem: 'outdated', related: [], suggest: 'update', suggestedEntry: '新条目' }),
    ])
    expect(report).toContain('Memory review found 2 issue(s)')
    expect(report).toContain('1. [contradiction] m-0000000000 (related: m-0000000001)')
    expect(report).toContain('2. [outdated] m-0000000002')
    expect(report).toContain('suggestedEntry: 新条目')
  })
})

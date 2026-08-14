import { describe, expect, it } from 'vitest'
import {
  byteLength,
  dedupe,
  partitionNodes,
  recall,
  warmUp,
} from '../src/team.js'
import type { MemoryNode, MemorySource, NodeRecallFn, RerankFn } from '../src/team.js'

function source(id: string, text: string): MemorySource {
  return { id, text }
}

/** 让每个节点按「文本包含 query 中某个词」返回候选,便于验证 fan-out。 */
function containRecall(keyword: string): NodeRecallFn {
  return async (node: MemoryNode) => node.text.split('\n\n').filter(line => line.includes(keyword))
}

const identityRerank: RerankFn = async (_query, candidates) => candidates

describe('byteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(byteLength('a')).toBe(1)
    expect(byteLength('中')).toBe(3)
  })
})

describe('partitionNodes', () => {
  it('packs sources into one node when under capacity', () => {
    const nodes = partitionNodes([source('a', 'hello'), source('b', 'world')], 10)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.text).toBe('hello\n\nworld')
  })

  it('spills into a second node when capacity is exceeded', () => {
    // maxNodeKb = 1 → 1024 bytes; two 700-byte sources exceed one node.
    const big = 'x'.repeat(700)
    const nodes = partitionNodes([source('a', big), source('b', big)], 1)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.id).toBe('node-1')
    expect(nodes[1]!.id).toBe('node-2')
  })

  it('keeps an oversized single source alone in its own node', () => {
    const huge = 'x'.repeat(2048)
    const nodes = partitionNodes([source('a', huge), source('b', 'small')], 1)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.text).toBe(huge)
    expect(nodes[1]!.text).toBe('small')
  })

  it('returns no nodes for no sources', () => {
    expect(partitionNodes([], 10)).toEqual([])
  })
})

describe('dedupe', () => {
  it('dedupes exact matches and keeps first-seen order', () => {
    expect(dedupe(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('trims and skips empty candidates', () => {
    expect(dedupe([' a ', '', 'b', '  '])).toEqual(['a', 'b'])
  })
})

describe('warmUp / recall', () => {
  it('fans out to every node and dedupes the aggregate', async () => {
    // 三个超容量源各占一个节点,便于验证 fan-out 覆盖全部节点。
    const pad = `${'x'.repeat(1024)} `
    const team = warmUp([source('a', `${pad}alpha`), source('b', `${pad}alpha`), source('c', `${pad}beta`)], 1)
    const recallFn: NodeRecallFn = async node =>
      node.text.includes('alpha') ? ['alpha'] : ['beta']
    const result = await recall(team, 'q', recallFn, identityRerank, 10)
    expect(result).toEqual(['alpha', 'beta'])
  })

  it('reranks and truncates to topK', async () => {
    const team = warmUp([source('a', 'one\n\ntwo\n\nthree')], 1)
    const recallFn: NodeRecallFn = async node => node.text.split('\n\n')
    const rerank: RerankFn = async (_query, candidates) => [...candidates].reverse()
    const result = await recall(team, 'q', recallFn, rerank, 2)
    expect(result).toEqual(['three', 'two'])
  })

  it('skips rerank when at most one candidate survives', async () => {
    const team = warmUp([source('a', 'only')], 1)
    const recallFn: NodeRecallFn = async node => [node.text]
    let reranked = false
    const rerank: RerankFn = async (_q, candidates) => {
      reranked = true
      return candidates
    }
    const result = await recall(team, 'q', recallFn, rerank, 10)
    expect(result).toEqual(['only'])
    expect(reranked).toBe(false)
  })

  it('returns empty for no candidates', async () => {
    const team = warmUp([source('a', 'x')], 1)
    const recallFn: NodeRecallFn = async () => []
    expect(await recall(team, 'q', recallFn, identityRerank, 10)).toEqual([])
  })

  it('runs node recalls concurrently', async () => {
    const pad = `${'x'.repeat(1024)} `
    const team = warmUp([source('a', `${pad}a`), source('b', `${pad}b`), source('c', `${pad}c`)], 1)
    let active = 0
    let maxActive = 0
    const recallFn: NodeRecallFn = async (node) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      return [node.text.trim()]
    }
    await recall(team, 'q', recallFn, identityRerank, 10)
    expect(maxActive).toBe(3)
  })
})

describe('containRecall helper', () => {
  it('returns matching lines', async () => {
    const fn = containRecall('beta')
    expect(await fn({ id: 'n', sizeBytes: 1, text: 'alpha\n\nbeta' }, 'ignored')).toEqual(['beta'])
  })
})

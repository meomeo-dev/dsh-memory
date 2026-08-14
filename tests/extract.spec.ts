import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  annealError,
  annealSessionStart,
  annealTurnStopping,
  buildTranscript,
  deriveLayer,
  extractBoth,
  filterNovel,
  parseExtraction,
} from '../src/extract.js'
import type { ExtractFn } from '../src/extract.js'

/** 抽取节点失败告警 noop。 */
const noopFailure = (): void => {}

describe('parseExtraction', () => {
  it('parses `domain|scope|entry` lines into candidates', () => {
    const text = 'DurablePrefs|全项目|提交信息用 Conventional Commits\nStyle|Web UI|两空格缩进'
    const rules = parseExtraction(text, 'rules')
    expect(rules).toHaveLength(2)
    expect(rules[0]).toEqual({ type: 'rules', domain: 'DurablePrefs', scope: '全项目', entry: '提交信息用 Conventional Commits' })
    expect(rules[1]).toEqual({ type: 'rules', domain: 'Style', scope: 'Web UI', entry: '两空格缩进' })
  })

  it('returns empty for blank output', () => {
    expect(parseExtraction('', 'rules')).toEqual([])
    expect(parseExtraction('\n  \n', 'lessons')).toEqual([])
  })

  it('drops invalid domains, blank scope/entry, and malformed lines', () => {
    const text = [
      'BogusDomain|全项目|不该被记录', // 非法 domain
      'DurablePrefs||空 scope', // 空 scope
      'Style|全项目', // 缺 entry
      '|全项目|空 domain', // 空 domain
      'DurablePrefs|全项目|有效条目', // 有效
    ].join('\n')
    const rules = parseExtraction(text, 'rules')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.entry).toBe('有效条目')
  })

  it('keeps `|` inside the entry text (only the first two separators split)', () => {
    const rules = parseExtraction('Style|全项目|a|b|c', 'rules')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.entry).toBe('a|b|c')
  })

  it('drops lessons entries over the 300-character cap', () => {
    const long = 'x'.repeat(301)
    const lessons = parseExtraction(`PromotedPitfalls|样本库|${long}\nPastFixes|样本库|正常教训`, 'lessons')
    expect(lessons).toHaveLength(1)
    expect(lessons[0]!.entry).toBe('正常教训')
  })

  it('dedupes exact duplicate entries within a batch (first seen wins)', () => {
    const rules = parseExtraction('DurablePrefs|全项目|用 pnpm\nStyle|Web UI|用 pnpm', 'rules')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.domain).toBe('DurablePrefs')
  })
})

describe('extractBoth', () => {
  it('fans out to two nodes and parses each type independently', async () => {
    const rulesFn: ExtractFn = async transcript => {
      expect(transcript).toContain('用 pnpm')
      return 'DurablePrefs|全项目|用 pnpm 管理依赖'
    }
    const lessonsFn: ExtractFn = async transcript => {
      expect(transcript).toContain('用 pnpm')
      return 'PromotedPitfalls|样本库|某模块在 X 平台有坑'
    }
    const result = await extractBoth('user: 用 pnpm', rulesFn, lessonsFn, noopFailure)
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]!.type).toBe('rules')
    expect(result.lessons).toHaveLength(1)
    expect(result.lessons[0]!.type).toBe('lessons')
    expect(result.lessons[0]!.domain).toBe('PromotedPitfalls')
  })

  it('runs the two nodes concurrently', async () => {
    let active = 0
    let maxActive = 0
    const node: ExtractFn = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      return ''
    }
    await extractBoth('x', node, node, noopFailure)
    expect(maxActive).toBe(2)
  })

  it('returns empty for a failed type and keeps the other type', async () => {
    const rulesFn: ExtractFn = async () => 'DurablePrefs|全项目|用 pnpm'
    const lessonsFn: ExtractFn = async () => { throw new Error('lessons down') }
    const failed: string[] = []
    const result = await extractBoth('x', rulesFn, lessonsFn, (type) => { failed.push(type) })
    expect(result.rules).toHaveLength(1)
    expect(result.lessons).toEqual([])
    expect(failed).toEqual(['lessons'])
  })

  it('throws when both extractors fail', async () => {
    const down: ExtractFn = async () => { throw new Error('down') }
    await expect(extractBoth('x', down, down, noopFailure)).rejects.toThrow(/all extractors failed/)
  })
})

describe('filterNovel', () => {
  it('skips candidates whose entry already exists, keeps the novel ones', () => {
    const candidates = [
      { type: 'lessons', domain: 'PastFixes', scope: '样本库', entry: '已存在的坑' },
      { type: 'lessons', domain: 'CodeFacts', scope: '样本库', entry: '新坑' },
    ] as const
    const existing = new Set(['已存在的坑'])
    const novel = filterNovel(candidates, existing)
    expect(novel).toHaveLength(1)
    expect(novel[0]!.entry).toBe('新坑')
  })
})

describe('annealing gate', () => {
  it('turn-stopping releases only after the cooldown interval, then resets', () => {
    const interval = 3
    let turns = 0
    const releases: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const decision = annealTurnStopping(turns, interval)
      turns = decision.turnsSince
      releases.push(decision.released)
    }
    expect(releases).toEqual([false, false, true, false, false])
    expect(turns).toBe(2)
  })

  it('error suppresses while cooling and releases once past the interval', () => {
    expect(annealError(0, 5).released).toBe(false)
    expect(annealError(4, 5).released).toBe(false)
    expect(annealError(5, 5).released).toBe(true)
    // 释放后归零。
    expect(annealError(5, 5).turnsSince).toBe(0)
  })

  it('session-start always releases and resets the counter', () => {
    expect(annealSessionStart()).toEqual({ released: true, turnsSince: 0 })
  })
})

describe('buildTranscript', () => {
  it('joins role:text lines', () => {
    const transcript = buildTranscript([
      { role: 'user', text: '记住用 pnpm' },
      { role: 'assistant', text: '已记录' },
    ])
    expect(transcript).toBe('user: 记住用 pnpm\nassistant: 已记录')
  })
})

describe('deriveLayer', () => {
  let project: string
  let user: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'dsh-memory-extract-proj-'))
    mkdirSync(join(project, '.git'))
    user = mkdtempSync(join(tmpdir(), 'dsh-memory-extract-user-'))
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(user, { recursive: true, force: true })
  })

  it('returns project when a .git ancestor exists', () => {
    expect(deriveLayer(project)).toBe('project')
    // 项目子目录也推导为 project。
    const sub = join(project, 'src')
    mkdirSync(sub, { recursive: true })
    expect(deriveLayer(sub)).toBe('project')
  })

  it('returns user when no .git ancestor exists', () => {
    expect(deriveLayer(user)).toBe('user')
  })
})

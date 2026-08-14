import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRuntimeState,
  DEFAULT_CONFIG,
  ensureTeam,
  restartTeam,
  sourcesFor,
  stopTeams,
  teamStatus,
} from '../src/memory-runtime.js'

let dshHome: string
let project: string
const saved = { dsh: process.env.DSH_HOME }

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-rt-dsh-'))
  project = mkdtempSync(join(tmpdir(), 'dsh-memory-rt-proj-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  if (saved.dsh === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.dsh
})

function seedProjectFile(entry: string): void {
  const dir = join(project, '.dsh', 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '2026-08-13.rules.remember.jsonl'),
    `${JSON.stringify({ type: 'rules', domain: 'Style', scope: '全项目', layer: 'project', entry, entryPoint: '-', references: '-' })}\n`,
    'utf8',
  )
}

describe('sourcesFor', () => {
  it('turns each file into a source of one entry line per entry', () => {
    seedProjectFile('两空格缩进')
    const sources = sourcesFor(project)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.text).toBe('[rules|Style] 两空格缩进')
  })
})

describe('ensureTeam / team lifecycle', () => {
  it('warms a team on first ensure and caches it (no re-read)', () => {
    const state = createRuntimeState()
    seedProjectFile('两空格缩进')

    const first = ensureTeam(state, project, DEFAULT_CONFIG)
    expect(first.nodes).toHaveLength(1)
    expect(teamStatus(state)).toEqual([{ root: project, nodes: 1, warmed: true }])

    // 同一 root 再次 ensure 返回同一 team(引用相等 = 未重读盘)。
    expect(ensureTeam(state, project, DEFAULT_CONFIG)).toBe(first)
  })

  it('stop releases all teams; restart rebuilds one root', () => {
    const state = createRuntimeState()
    seedProjectFile('两空格缩进')
    ensureTeam(state, project, DEFAULT_CONFIG)
    expect(teamStatus(state)).toHaveLength(1)

    stopTeams(state)
    expect(teamStatus(state)).toEqual([])

    const rebuilt = restartTeam(state, project, DEFAULT_CONFIG)
    expect(rebuilt.nodes).toHaveLength(1)
    expect(teamStatus(state)).toHaveLength(1)
  })
})

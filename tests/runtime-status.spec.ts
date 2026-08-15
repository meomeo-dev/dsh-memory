import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_PURGE_MS,
  beginNode,
  createNodeStates,
  endNode,
  listProcesses,
  publishRuntime,
  removeRuntimeFile,
  runtimeDir,
  runtimeFilePath,
} from '../src/runtime-status.js'
import type { RuntimeStatus } from '../src/runtime-status.js'

let dshHome: string
const saved = process.env.DSH_HOME

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-memory-runtime-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  rmSync(dshHome, { recursive: true, force: true })
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
})

const NOW = 1755234599000

function status(overrides: Partial<RuntimeStatus>): RuntimeStatus {
  const nodes = createNodeStates()
  return {
    formatVersion: 1,
    pid: 100,
    startedAt: NOW - 5000,
    cwd: '/proj',
    lastSeenAt: NOW,
    teams: [{ root: '', nodes: 3, chars: 1200 }],
    summaryChars: 800,
    nodes,
    ...overrides,
  }
}

describe('node runtime state machine', () => {
  it('begin marks running with runningSince; concurrent calls keep earliest start', () => {
    const states = createNodeStates()
    beginNode(states, 'recall', NOW)
    expect(states.recall.running).toBe(1)
    expect(states.recall.runningSince).toBe(NOW)
    beginNode(states, 'recall', NOW + 100)
    expect(states.recall.running).toBe(2)
    expect(states.recall.runningSince).toBe(NOW) // 保持最早一个在飞调用
    endNode(states, 'recall', NOW, NOW + 500)
    expect(states.recall.running).toBe(1)
    // 仍保最早已知在飞起始(不跟踪单次调用,指示「至少运行了多久」)。
    expect(states.recall.runningSince).toBe(NOW)
    endNode(states, 'recall', NOW + 100, NOW + 900)
    expect(states.recall.running).toBe(0)
    expect(states.recall.runningSince).toBeUndefined()
    expect(states.recall.lastAt).toBe(NOW + 100)
    expect(states.recall.lastDurationMs).toBe(800)
    expect(states.recall.lastOk).toBe(true)
  })

  it('end records failure text and clears it on later success; running never negative', () => {
    const states = createNodeStates()
    beginNode(states, 'extract', NOW)
    endNode(states, 'extract', NOW, NOW + 300, 'timeout')
    expect(states.extract.lastOk).toBe(false)
    expect(states.extract.lastError).toBe('timeout')
    beginNode(states, 'extract', NOW + 1000)
    endNode(states, 'extract', NOW + 1000, NOW + 1100)
    expect(states.extract.lastOk).toBe(true)
    expect(states.extract.lastError).toBeUndefined()
    // 防御:未 begin 的 end 不产生负 running。
    endNode(states, 'review', NOW, NOW + 10)
    expect(states.review.running).toBe(0)
    expect(states.review.lastAt).toBe(NOW)
  })
})

describe('runtime status files', () => {
  it('publishes atomically and lists with derived stale/isCurrent and sorting', () => {
    publishRuntime(status({ pid: 101, startedAt: NOW - 5000 }))
    publishRuntime(status({ pid: 102, startedAt: NOW - 10000 }))
    const rows = listProcesses(NOW, 102)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ pid: 102, isCurrent: true, stale: false })
    expect(rows[1]).toMatchObject({ pid: 101, isCurrent: false, stale: false })
    expect(rows[1]!.teams).toEqual([{ root: '', nodes: 3, chars: 1200 }])
  })

  it('adds in-flight calls to completed calls in listed rows (display semantics)', () => {
    const running = status({ pid: 401, startedAt: NOW - 1000 })
    running.nodes.recall.running = 2
    running.nodes.recall.calls = 5
    publishRuntime(running)
    const [row] = listProcesses(NOW, 999)
    expect(row).toBeDefined()
    expect(row!.nodes.recall.calls).toBe(7) // 已完成 5 + 在飞 2
    expect(row!.nodes.extract.calls).toBe(0)
    expect(row!.nodes.review.calls).toBe(0)
  })

  it('marks heartbeat-aged files stale (kept) and purges >24h files', () => {
    publishRuntime(status({ pid: 201, startedAt: NOW - 1000, lastSeenAt: NOW - 90_000 }))
    publishRuntime(status({ pid: 202, startedAt: NOW - RUNTIME_PURGE_MS, lastSeenAt: NOW - RUNTIME_PURGE_MS - 1 }))
    const rows = listProcesses(NOW, 999)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 201, stale: true, isCurrent: false })
    // 超龄文件已被读取端清理。
    expect(readdirSync(runtimeDir())).toHaveLength(1)
  })

  it('skips corrupt or wrong-format files without failing', () => {
    publishRuntime(status({ pid: 301, startedAt: NOW - 1000 }))
    writeFileSync(join(runtimeDir(), '302-1.json'), '{not json')
    writeFileSync(join(runtimeDir(), '303-1.json'), JSON.stringify({ formatVersion: 99, pid: 303 }))
    const rows = listProcesses(NOW, 999)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.pid).toBe(301)
  })

  it('removeRuntimeFile deletes only its own file', () => {
    publishRuntime(status({ pid: 401, startedAt: NOW - 1000 }))
    publishRuntime(status({ pid: 402, startedAt: NOW - 2000 }))
    removeRuntimeFile(401, NOW - 1000)
    expect(readdirSync(runtimeDir())).toEqual([`402-${NOW - 2000}.json`])
    // 不存在则静默。
    removeRuntimeFile(404, NOW)
  })

  it('returns empty when the runtime dir is missing', () => {
    expect(listProcesses(NOW, 999)).toHaveLength(0)
    expect(runtimeFilePath(501, NOW)).toBe(join(dshHome, 'lmemory', 'runtime', `501-${NOW}.json`))
  })
})

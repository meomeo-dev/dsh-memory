/**
 * 进程运行时状态发布与读取:`~/.dsh/lmemory/runtime/<pid>-<startedAtMs>.json`
 * (纯逻辑,不 import cordis)。设计见 docs/node-status.md。
 *
 * 文件即跨进程协议:每进程只写自己的文件(原子写),读取端列目录聚合;心跳失效
 * 判「已退出」,超龄文件清理。节点运行状态机(空闲/运行中/最近一次)也在此,
 * 供 callFlash 钩子驱动。
 *
 * @module dsh-memory/runtime-status
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './memory-file.js'

/** 状态文件格式版本(结构变化时递增;读取端只认格式,不认识则跳过)。 */
export const RUNTIME_FORMAT_VERSION = 1

/** 心跳间隔(毫秒):活进程至少每 15s 写一次,顺带刷新 team 装载快照。 */
export const RUNTIME_HEARTBEAT_MS = 15_000

/** 失效阈值(毫秒):lastSeenAt 距今超过 60s 判「已退出」。 */
export const RUNTIME_STALE_MS = 60_000

/** 清理阈值(毫秒):超过 24h 无心跳的文件在读取端删除(只可能是死进程残留)。 */
export const RUNTIME_PURGE_MS = 24 * 60 * 60 * 1000

/** 节点职责分类(与 stats.ts 的 UsageLabel 对应)。 */
export type NodeStatusKey = 'recall' | 'extract' | 'review'

/** 单个节点的运行时状态(状态机只管 running 与最近一次;calls 在快照时由 usage 计数填充)。 */
export interface NodeRuntimeState {
  /** 在飞调用数(并发 fan-out 时可 >1)。 */
  running: number
  /** 最早一个在飞调用的起始时刻(epoch 毫秒);仅 running > 0 时存在。 */
  runningSince?: number
  /** 已完成的累计调用次数(状态文件值 = usage 计数;{@link listProcesses} 返回时已加在飞数)。 */
  calls: number
  /** 最近一次完成的调用起始时刻;0 = 从未调用。 */
  lastAt: number
  /** 最近一次调用的耗时(毫秒)。 */
  lastDurationMs: number
  /** 最近一次调用是否成功。 */
  lastOk: boolean
  /** 最近一次失败的错误文本。 */
  lastError?: string
}

/** 单个 project root 的预热 team 装载快照。 */
export interface TeamRuntimeRow {
  /** project root;空串 = 无项目 cwd。 */
  root: string
  /** 节点数。 */
  nodes: number
  /** 节点文本总字符数。 */
  chars: number
}

/** 进程运行时状态(状态文件全文;读取端在文件内容上派生 stale / isCurrent)。 */
export interface RuntimeStatus {
  /** 格式版本。 */
  formatVersion: number
  /** 进程 pid。 */
  pid: number
  /** 进程启动时刻(epoch 毫秒)。 */
  startedAt: number
  /** 进程工作目录。 */
  cwd: string
  /** dsh web 监听端口(web 模式);headless 进程缺省。 */
  port?: number
  /** 最近一次心跳(epoch 毫秒)。 */
  lastSeenAt: number
  /** 已预热 team(按 root)。 */
  teams: readonly TeamRuntimeRow[]
  /** system prompt 摘要文本字符数。 */
  summaryChars: number
  /** 3 类节点的运行状态。 */
  nodes: Record<NodeStatusKey, NodeRuntimeState>
}

/** 面板进程行:状态文件内容 + 读取端派生字段。 */
export interface ProcessRow extends RuntimeStatus {
  /** 心跳是否已失效(进程已退出或崩溃)。 */
  stale: boolean
  /** 是否为当前进程。 */
  isCurrent: boolean
}

/** 运行时状态目录(用户 lmemory 根内,随用户根一起备份)。 */
export function runtimeDir(): string {
  return join(dshHome(), 'lmemory', 'runtime')
}

/** 某进程的状态文件路径。 */
export function runtimeFilePath(pid: number, startedAt: number): string {
  return join(runtimeDir(), `${pid}-${startedAt}.json`)
}

/** 空的节点状态表。 */
export function createNodeStates(): Record<NodeStatusKey, NodeRuntimeState> {
  const idle = (): NodeRuntimeState => ({ running: 0, calls: 0, lastAt: 0, lastDurationMs: 0, lastOk: true })
  return { recall: idle(), extract: idle(), review: idle() }
}

/**
 * 标记一次节点调用开始:running +1;首个在飞调用记录 runningSince。
 * @param states - 节点状态表。
 * @param key - 节点职责。
 * @param now - 起始时刻(测试注入)。
 */
export function beginNode(states: Record<NodeStatusKey, NodeRuntimeState>, key: NodeStatusKey, now: number): void {
  const state = states[key]
  if (state.running === 0) state.runningSince = now
  state.running += 1
}

/**
 * 标记一次节点调用结束:running -1(不为负),记录最近一次的时间 / 耗时 / 成败。
 * @param states - 节点状态表。
 * @param key - 节点职责。
 * @param startAt - 该次调用的起始时刻。
 * @param now - 结束时刻(测试注入)。
 * @param error - 失败错误文本;成功缺省。
 */
export function endNode(
  states: Record<NodeStatusKey, NodeRuntimeState>,
  key: NodeStatusKey,
  startAt: number,
  now: number,
  error?: string,
): void {
  const state = states[key]
  state.running = Math.max(0, state.running - 1)
  if (state.running === 0) delete state.runningSince
  state.lastAt = startAt
  state.lastDurationMs = now - startAt
  state.lastOk = error === undefined
  if (error !== undefined) state.lastError = error
  else delete state.lastError
}

/**
 * 原子写状态文件(临时文件 + rename;目录不存在时创建)。
 * @param status - 要落盘的状态。
 */
export function publishRuntime(status: RuntimeStatus): void {
  const path = runtimeFilePath(status.pid, status.startedAt)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** 删除本进程的状态文件(dispose 时调用;文件不存在则静默)。 */
export function removeRuntimeFile(pid: number, startedAt: number): void {
  rmSync(runtimeFilePath(pid, startedAt), { force: true })
}

/** 解析一个状态文件;JSON 非法或结构不符返回 undefined(读取端跳过)。 */
function parseStatus(text: string): RuntimeStatus | undefined {
  try {
    const doc = JSON.parse(text) as unknown
    if (typeof doc !== 'object' || doc === null) return undefined
    const value = doc as Record<string, unknown>
    if (value.formatVersion !== RUNTIME_FORMAT_VERSION) return undefined
    if (typeof value.pid !== 'number' || typeof value.startedAt !== 'number') return undefined
    if (typeof value.cwd !== 'string' || typeof value.lastSeenAt !== 'number') return undefined
    if (typeof value.summaryChars !== 'number' || !Array.isArray(value.teams)) return undefined
    if (typeof value.nodes !== 'object' || value.nodes === null) return undefined
    const teams: TeamRuntimeRow[] = []
    for (const team of value.teams) {
      if (typeof team !== 'object' || team === null) continue
      const { root, nodes, chars } = team as Record<string, unknown>
      if (typeof root !== 'string' || typeof nodes !== 'number' || typeof chars !== 'number') continue
      teams.push({ root, nodes, chars })
    }
    const nodes: Partial<Record<NodeStatusKey, NodeRuntimeState>> = {}
    for (const key of ['recall', 'extract', 'review'] as const) {
      const raw = (value.nodes as Record<string, unknown>)[key]
      if (typeof raw !== 'object' || raw === null) continue
      const { running, runningSince, calls, lastAt, lastDurationMs, lastOk, lastError } = raw as Record<string, unknown>
      if (typeof running !== 'number' || typeof calls !== 'number' || typeof lastAt !== 'number' || typeof lastDurationMs !== 'number' || typeof lastOk !== 'boolean') continue
      const parsed: NodeRuntimeState = { running, calls, lastAt, lastDurationMs, lastOk }
      if (typeof runningSince === 'number') parsed.runningSince = runningSince
      if (typeof lastError === 'string') parsed.lastError = lastError
      nodes[key] = parsed
    }
    if (nodes.recall === undefined || nodes.extract === undefined || nodes.review === undefined) return undefined
    const status: RuntimeStatus = {
      formatVersion: RUNTIME_FORMAT_VERSION,
      pid: value.pid,
      startedAt: value.startedAt,
      cwd: value.cwd,
      lastSeenAt: value.lastSeenAt,
      teams,
      summaryChars: value.summaryChars,
      nodes: nodes as Record<NodeStatusKey, NodeRuntimeState>,
    }
    if (typeof value.port === 'number') status.port = value.port
    return status
  } catch {
    return undefined
  }
}

/** 按文件内容提取进程快照(坏文件 / 格式不符跳过,返回空)。 */
function readProcesses(now: number): ProcessRow[] {
  const dir = runtimeDir()
  if (!existsSync(dir)) return []
  const rows: ProcessRow[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const status = parseStatus(readFileSync(path, 'utf8'))
      if (status === undefined) continue
      if (now - status.lastSeenAt > RUNTIME_PURGE_MS) {
        // 只可能是死进程残留(活进程心跳 15s 一次),读取端顺手清理。
        rmSync(path, { force: true })
        continue
      }
      rows.push({
        ...status,
        stale: now - status.lastSeenAt > RUNTIME_STALE_MS,
        isCurrent: status.pid === process.pid,
      })
    } catch {
      // 读取瞬间被并发删除 / 写入半截:跳过,下次轮询再聚合。
    }
  }
  return rows
}

/** 展示语义:累计调用 = 已完成(usage 计数)+ 在飞(未完成的调用也是调用)。 */
function withInFlight(state: NodeRuntimeState): NodeRuntimeState {
  return { ...state, calls: state.calls + state.running }
}

/**
 * 读取全部进程的运行状态:清理超龄文件、标记失效、把在飞调用计入累计 calls、
 * 排序(本进程 → 在线按启动时间倒序 → 已退出按最后心跳倒序)。
 * @param now - 读取时刻(测试注入)。
 * @param currentPid - 当前进程 pid(测试注入;缺省 process.pid)。
 * @returns 进程行列表(calls 含在飞调用数)。
 */
export function listProcesses(now: number = Date.now(), currentPid: number = process.pid): ProcessRow[] {
  const rows = readProcesses(now).map(row => ({
    ...row,
    nodes: {
      recall: withInFlight(row.nodes.recall),
      extract: withInFlight(row.nodes.extract),
      review: withInFlight(row.nodes.review),
    },
    isCurrent: row.pid === currentPid,
  }))
  return rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.stale !== b.stale) return a.stale ? 1 : -1
    return a.stale ? b.lastSeenAt - a.lastSeenAt : b.startedAt - a.startedAt
  })
}

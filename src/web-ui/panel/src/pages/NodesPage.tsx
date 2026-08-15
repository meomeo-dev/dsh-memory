/**
 * 节点状态页:host 上全部 dsh-memory 进程的运行时状态(身份 / 装载 / 3 类节点
 * 运行状态),5s 自动轮询。设计(docs/node-status.md):本进程置顶高亮,已退出
 * 沉底置灰;渲染只走 React 文本节点。样式在 ./nodes.css。
 */
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, NodeRuntimeDto, ProcessRowDto } from '../api'
import { formatAgo, formatBytes, formatDuration, formatElapsed, formatTime } from '../format'
import './nodes.css'

/** 轮询间隔:运行状态是活数据(host 心跳 15s,前端 5s 拉取)。 */
const POLL_MS = 5_000

const NODE_LABELS = {
  recall: 'recall (召回)',
  extract: 'extract (抽取)',
  review: 'review (质检)',
} as const

/** 一行节点状态:状态点 + 运行中指示 + 累计调用 + 最近一次(时间/耗时/错误)。 */
function NodeRow({ label, state, stale }: { readonly label: string; readonly state: NodeRuntimeDto; readonly stale: boolean }): JSX.Element {
  const running = state.running > 0
  const dotClass = stale ? 'idle' : running ? 'running' : 'idle'
  const never = state.lastAt === 0
  return (
    <div className="node-row">
      <span className={`node-dot ${dotClass}`} />
      <span className="node-label">{label}</span>
      <span className={`node-running${running ? '' : ' hidden'}`}>
        {running && state.runningSince !== undefined
          ? `运行中 ×${state.running} · ${formatElapsed(state.runningSince)}`
          : '空闲'}
      </span>
      <span className="node-calls mono">{state.calls.toLocaleString()} calls</span>
      <span className={`node-last${!state.lastOk ? ' error' : ''}`}>
        {never
          ? '从未调用'
          : state.lastOk
            ? `${formatAgo(state.lastAt)} · ${formatDuration(state.lastDurationMs)}`
            : `失败 ${formatAgo(state.lastAt)} · ${state.lastError ?? 'unknown error'}`}
      </span>
    </div>
  )
}

/** 一个进程卡片:身份带 → 装载带 → 3 类节点带。 */
function ProcessCard({ row }: { readonly row: ProcessRowDto }): JSX.Element {
  const identity = [
    `pid ${row.pid}`,
    ...(row.port !== undefined ? [`port ${row.port}`] : []),
    `启动于 ${formatTime(row.startedAt)}`,
  ]
  const totalChars = row.teams.reduce((sum, team) => sum + team.chars, 0)
  return (
    <section className={`card proc-card${row.stale ? ' stale' : ''}`}>
      <header className="proc-head">
        <span className="badges">
          {row.isCurrent && <span className="badge rules">本进程</span>}
          {row.stale && <span className="badge layer">已退出</span>}
          <span className="proc-id mono">{identity.join(' · ')}</span>
        </span>
      </header>
      <p className="meta proc-cwd">
        <span className="mono">{row.cwd}</span>
        <span>心跳: {formatAgo(row.lastSeenAt)}</span>
      </p>

      <div className="proc-load">
        <span className="section-title">装载状态</span>
        {row.teams.length === 0
          ? <p className="meta">未预热 (no warm team)</p>
          : row.teams.map(team => (
            <div className="team-load-row" key={team.root}>
              <span className="mono team-load-root">{team.root === '' ? '(no project)' : team.root}</span>
              <span>{team.nodes} node(s) · {formatBytes(team.chars)}</span>
            </div>
          ))}
        <p className="meta">system prompt 摘要: {formatBytes(row.summaryChars)} · 节点文本合计 {formatBytes(totalChars)}</p>
      </div>

      <div className="proc-nodes">
        <span className="section-title">节点运行状态</span>
        {(Object.keys(NODE_LABELS) as (keyof typeof NODE_LABELS)[]).map(key => (
          <NodeRow key={key} label={NODE_LABELS[key]} state={row.nodes[key]} stale={row.stale} />
        ))}
      </div>
    </section>
  )
}

/** 节点状态页:全部进程卡片 + 5s 自动轮询 + 手动刷新。 */
export function NodesPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [processes, setProcesses] = useState<readonly ProcessRowDto[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    rpc<{ processes: ProcessRowDto[] }>(bootstrap, 'nodes-get')
      .then(value => { setProcesses(value.processes); setError(undefined) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  return (
    <div className="page">
      <div className="status-head">
        <span className="status-title">节点状态 (Nodes)</span>
        <span className="meta">每 5s 自动刷新;heartbeat 失效 60s 判「已退出」,残留 &gt;24h 自动清理</span>
        <button type="button" className="refresh" onClick={load}>刷新 (Refresh)</button>
      </div>
      {error !== undefined && <div className="banner error">加载失败: {error}</div>}
      {processes.length === 0
        ? <div className="empty">暂无进程状态 (No process status)。<br />打开面板的 dsh-memory 进程会发布自身状态到 ~/.dsh/lmemory/runtime/。</div>
        : processes.map(row => <ProcessCard key={`${row.pid}-${row.startedAt}`} row={row} />)}
    </div>
  )
}

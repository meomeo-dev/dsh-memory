/**
 * 目录页:全部已登记记忆根 + 汇总 + 添加/移除/导出管理。
 * 用户故事与信息结构见 docs/web-panel.md「目录页」;样式在 ./collections.css。
 */
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, RootsView } from '../api'
import { formatTime } from '../format'
import './collections.css'

/** 目录页:全部已登记记忆根 + 汇总 + 添加/移除/导出管理。 */
export function CollectionsPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [view, setView] = useState<RootsView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [addPath, setAddPath] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    rpc<{ roots: RootsView }>(bootstrap, 'roots-get')
      .then(value => { setView(value.roots); setError(undefined) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  useEffect(() => { load() }, [load])

  const apply = useCallback((next: RootsView, okText: string) => {
    setView(next)
    setBanner({ kind: 'ok', text: okText })
  }, [])

  const doExport = useCallback((root: string | undefined) => {
    setBusy(true)
    rpc<{ export: { dir: string; totalEntries: number; rootsExported: number } }>(bootstrap, 'root-export', root === undefined ? {} : { root })
      .then(value => {
        const info = value.export
        setBanner({ kind: 'ok', text: `已导出 ${info.rootsExported} 根 / ${info.totalEntries} 条 → ${info.dir}` })
      })
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusy(false))
  }, [bootstrap])

  const doForget = useCallback((root: string) => {
    if (!window.confirm(`从注册表移除该根(不动磁盘数据)?\n${root}`)) return
    setBusy(true)
    rpc<{ roots: RootsView }>(bootstrap, 'root-forget', { root })
      .then(value => apply(value.roots, `已移除登记: ${root}`))
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusy(false))
  }, [bootstrap, apply])

  const doAdd = useCallback(() => {
    const path = addPath.trim()
    if (path.length === 0) return
    setBusy(true)
    rpc<{ roots: RootsView }>(bootstrap, 'root-add', { root: path })
      .then(value => {
        apply(value.roots, `已登记: ${path}`)
        setAddPath('')
      })
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setBusy(false))
  }, [bootstrap, apply, addPath])

  const toggleExpand = useCallback((root: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  }, [])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  if (view === undefined) {
    return <div className="page"><div className="banner error">加载失败: {error}</div></div>
  }

  const metrics = [
    { label: '已登记根', value: view.summary.roots.toLocaleString() },
    { label: '总条目', value: view.summary.totalEntries.toLocaleString() },
    { label: '总文件', value: view.summary.totalFiles.toLocaleString() },
  ]

  return (
    <div className="page">
      <div className="status-head">
        <span className="status-title">记忆目录 (Collections)</span>
        <button type="button" className="primary" disabled={busy || view.summary.roots === 0} onClick={() => doExport(undefined)}>导出全部 (Export all)</button>
      </div>
      {banner !== undefined && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <section className="metric-grid">
        {metrics.map(metric => (
          <div className="metric-card" key={metric.label}>
            <span className="metric-value">{metric.value}</span>
            <span className="metric-label">{metric.label}</span>
          </div>
        ))}
      </section>

      <form className="card add-root" onSubmit={(event) => { event.preventDefault(); doAdd() }}>
        <span className="section-title">登记记忆根 (Add root)</span>
        <div className="add-root-row">
          <input type="text" className="add-root-input" placeholder="lmemory 目录的绝对路径(如 /path/to/proj/.dsh/lmemory)" value={addPath} onChange={event => setAddPath(event.target.value)} />
          <button type="submit" className="primary" disabled={busy || addPath.trim().length === 0}>登记 (Add)</button>
        </div>
        <p className="meta">目录须含 *.remember.jsonl / catalog.json,或为空目录;登记后纳入整体管理与导出。</p>
      </form>

      {view.roots.length === 0
        ? <div className="empty">暂无已登记的记忆根 (No registered memory roots)。<br />记忆根会在会话开始时自动登记,或在上方手动添加。</div>
        : view.roots.map(root => (
          <section className="card root-card" key={root.root}>
            <header>
              <span className={`badge ${root.kind === 'user' ? 'rules' : 'lessons'}`}>{root.kind}</span>
              <span className="mono root-path">{root.root}</span>
              <span className={`state-dot ${root.exists ? 'ok' : 'gone'}`} title={root.exists ? '目录存在' : '目录已消失(保留最后已知计数)'} />
            </header>
            <p className="meta">
              <span>{root.entries} entries</span>
              <span>{root.files} files</span>
              <span>首次登记: {formatTime(root.firstSeenAt)}</span>
              <span>最近可见: {root.lastSeenAt > 0 ? formatTime(root.lastSeenAt) : 'never'}</span>
            </p>
            <div className="root-actions">
              <button type="button" className="refresh" disabled={busy} onClick={() => doExport(root.root)}>导出 (Export)</button>
              <button type="button" className="refresh danger" disabled={busy} onClick={() => doForget(root.root)}>移除登记 (Forget)</button>
              <button type="button" className="refresh" onClick={() => toggleExpand(root.root)}>
                {expanded.has(root.root) ? '收起明细' : '文件明细'}
              </button>
            </div>
            {expanded.has(root.root) && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>文件</th><th>条目数</th></tr>
                  </thead>
                  <tbody>
                    {root.filesDetail.length === 0
                      ? <tr><td colSpan={2} className="meta">(无 .remember.jsonl 文件)</td></tr>
                      : root.filesDetail.map(detail => (
                        <tr key={detail.file}>
                          <td className="mono">{detail.file}</td>
                          <td className="mono">{detail.entries}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
    </div>
  )
}

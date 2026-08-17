/**
 * Global 页:global 条目只读列表 + 动作区(文档抽取两阶段 / 提升评审预估→确认 /
 * 质检报告 / 导出下载 / 导入报告)。样式在 ./global.css;渲染只走 React 文本节点。
 */
import { useEffect, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, EntryRow, GlobalCandidateDto, GlobalImportDto, GlobalPromotePlanDto } from '../api'
import { formatTime } from '../format'
import './global.css'

/** 单条候选的展示(verdict + gate 结论由服务端口径回显)。 */
function CandidateRow({ candidate }: { readonly candidate: GlobalCandidateDto }): JSX.Element {
  return (
    <li className="candidate-row">
      <span className={`badge ${candidate.verdict === 'pass' ? 'rules' : 'lessons'}`}>{candidate.verdict}</span>
      <span className="badge domain">{candidate.domain}</span>
      <span className="badge layer">{candidate.type}</span>
      <span className="candidate-entry">{candidate.entry}</span>
      {candidate.reason !== undefined && <span className="candidate-reason">({candidate.reason})</span>}
    </li>
  )
}

/** global 条目只读列表(复用记忆页卡片形态)。 */
function EntryList({ rows }: { readonly rows: readonly EntryRow[] }): JSX.Element {
  if (rows.length === 0) return <div className="empty">暂无 global 记忆条目 (No global entries)</div>
  return (
    <div className="global-list">
      {rows.map(row => (
        <article key={row.entry.id} className="card">
          <header>
            <span className="badges">
              <span className={`badge ${row.entry.type}`}>{row.entry.type}</span>
              <span className="badge domain">{row.entry.domain}</span>
              <span className="badge layer">{row.entry.layer}</span>
            </span>
            <time className="time">{formatTime(row.entry.createdAt)}</time>
          </header>
          <p className="entry">{row.entry.entry}</p>
          <p className="meta">
            <span>scope: {row.entry.scope}</span>
            <span>file: {row.file}</span>
            {row.entry.entryPoint !== '-' && <span>entryPoint: {row.entry.entryPoint}</span>}
            {row.entry.references !== '-' && <span>references: {row.entry.references}</span>}
          </p>
        </article>
      ))}
    </div>
  )
}

/** 动作区结果横幅(ok / error 两态,复用目录页 banner 形态)。 */
function Banner({ state }: { readonly state?: { kind: 'ok' | 'error'; text: string } }): JSX.Element | null {
  if (state === undefined) return null
  return <div className={`banner ${state.kind}`}>{state.text}</div>
}

/** Global 页:顶部只读条目列表 + 五个动作区(§9.1)。 */
export function GlobalPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [rows, setRows] = useState<readonly EntryRow[]>([])
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  // 抽取:文档文本 + 候选(阶段 1)与写盘结果(阶段 2)。
  const [docText, setDocText] = useState('')
  const [candidates, setCandidates] = useState<readonly GlobalCandidateDto[] | undefined>(undefined)
  const [wrote, setWrote] = useState<{ wrote: number; skipped: number } | undefined>(undefined)
  // 提升:计划回显(未确认不发调用)与执行结果。
  const [plan, setPlan] = useState<GlobalPromotePlanDto | undefined>(undefined)
  const [promoted, setPromoted] = useState<{ wrote: number; skipped: number } | undefined>(undefined)
  // 质检报告。
  const [report, setReport] = useState<string | undefined>(undefined)
  const [findings, setFindings] = useState(0)
  // 导入结果。
  const [imported, setImported] = useState<GlobalImportDto | undefined>(undefined)

  useEffect(() => {
    rpc<{ entries: readonly EntryRow[] }>(bootstrap, 'global-entries')
      .then(value => setRows(value.entries))
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [bootstrap])

  const extract = async (): Promise<void> => {
    setBanner(undefined)
    setCandidates(undefined)
    setWrote(undefined)
    try {
      const value = await rpc<{ candidates: readonly GlobalCandidateDto[] }>(bootstrap, 'global-extract', { text: docText })
      setCandidates(value.candidates)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const confirmExtract = async (): Promise<void> => {
    setBanner(undefined)
    try {
      const value = await rpc<{ wrote: number; skipped: number }>(bootstrap, 'global-extract', { text: docText, confirm: true, candidates: candidates ?? [] })
      setWrote(value)
      setCandidates(undefined)
      const refreshed = await rpc<{ entries: readonly EntryRow[] }>(bootstrap, 'global-entries')
      setRows(refreshed.entries)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const planPromote = async (): Promise<void> => {
    setBanner(undefined)
    setPlan(undefined)
    setPromoted(undefined)
    try {
      const value = await rpc<{ plan: GlobalPromotePlanDto }>(bootstrap, 'global-promote')
      setPlan(value.plan)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const runPromote = async (): Promise<void> => {
    setBanner(undefined)
    try {
      const value = await rpc<{ wrote: number; skipped: number }>(bootstrap, 'global-promote', { confirm: true })
      setPromoted(value)
      setPlan(undefined)
      const refreshed = await rpc<{ entries: readonly EntryRow[] }>(bootstrap, 'global-entries')
      setRows(refreshed.entries)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const runReview = async (): Promise<void> => {
    setBanner(undefined)
    setReport(undefined)
    try {
      const value = await rpc<{ findings: number; report: string }>(bootstrap, 'global-review')
      setFindings(value.findings)
      setReport(value.report)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const downloadExport = async (): Promise<void> => {
    setBanner(undefined)
    try {
      const value = await rpc<{ export: string }>(bootstrap, 'global-export')
      const blob = new Blob([value.export], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'dsh-memory-global-export.json'
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const importFile = async (file: File): Promise<void> => {
    setBanner(undefined)
    setImported(undefined)
    try {
      const text = await file.text()
      const value = await rpc<GlobalImportDto>(bootstrap, 'global-import', { text })
      setImported(value)
      if (value.ok) {
        const refreshed = await rpc<{ entries: readonly EntryRow[] }>(bootstrap, 'global-entries')
        setRows(refreshed.entries)
      }
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="page">
      <section>
        <h2>global 条目 (Global entries,只读)</h2>
        <EntryList rows={rows} />
      </section>

      <section>
        <h2>文档抽取 (extract&lt;global-type1&gt;)</h2>
        <p className="hint">粘贴文档文本(≤ 1 MiB)或从文件读入;先回显候选与结论,确认后才写盘(确认阶段服务端重跑 gate)。</p>
        <div className="action-row">
          <textarea
            className="doc-input"
            placeholder="粘贴文档全文,或点击下方按钮选择文件"
            value={docText}
            onChange={event => { setDocText(event.target.value); setCandidates(undefined); setWrote(undefined) }}
          />
          <input
            type="file"
            accept=".txt,.md,.json,.jsonl,.yaml,.yml,.ts,.js,.py,.log"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file === undefined) return
              file.text().then(setDocText).catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
            }}
          />
        </div>
        <div className="action-row">
          <button type="button" disabled={docText.trim().length === 0} onClick={extract}>抽取 (Extract)</button>
          {candidates !== undefined && (
            <button type="button" disabled={candidates.length === 0} onClick={confirmExtract}>确认写盘 (Write)</button>
          )}
        </div>
        {candidates !== undefined && (
          <div className="result-block">
            {candidates.length === 0
              ? <div className="empty">0 条候选:文档无可提升内容 (0 candidates)</div>
              : <ul className="candidate-list">{candidates.map((candidate, index) => <CandidateRow key={index} candidate={candidate} />)}</ul>}
          </div>
        )}
        {wrote !== undefined && <div className="result-block">已写入 {wrote.wrote} 条,跳过 {wrote.skipped} 条(gate 拒绝或重复)。</div>}
      </section>

      <section>
        <h2>提升评审 (review&lt;global-type2&gt;)</h2>
        <p className="hint">对全部 user/project 记忆严格评估并总结提炼为 global 候选;先看预估节点数与成本,确认后才发调用。</p>
        <div className="action-row">
          <button type="button" onClick={planPromote}>预估 (Estimate)</button>
          {plan !== undefined && (
            <button type="button" onClick={runPromote}>确认执行 (Execute)</button>
          )}
        </div>
        {plan !== undefined && (
          <div className="result-block">
            {plan.sourceEntries} 条源条目 → {plan.nodeCount} 个节点;预计成本 {plan.costYuan !== undefined ? `¥${plan.costYuan.toFixed(4)}` : `未知 (${plan.costError ?? 'pricing unavailable'})`}
          </div>
        )}
        {promoted !== undefined && <div className="result-block">已写入 {promoted.wrote} 条,跳过 {promoted.skipped} 条(gate 拒绝或重复)。</div>}
      </section>

      <section>
        <h2>global 质检 (review&lt;global-type1&gt;)</h2>
        <div className="action-row">
          <button type="button" onClick={runReview}>运行质检 (Review)</button>
        </div>
        {report !== undefined && (
          <div className="result-block">
            <p>发现 {findings} 处缺陷</p>
            <pre className="report-text">{report}</pre>
          </div>
        )}
      </section>

      <section>
        <h2>导出 / 导入 (Export / Import)</h2>
        <p className="hint">导出为单文件 JSON 包(kind + formatVersion 标记);导入逐条过防线:kind → 版本 → schema 迁移 → gate → layer=global → 两轮去重。</p>
        <div className="action-row">
          <button type="button" onClick={downloadExport}>导出 (Export)</button>
          <input
            type="file"
            accept=".json"
            onChange={event => {
              const file = event.target.files?.[0]
              if (file !== undefined) importFile(file)
            }}
          />
        </div>
        {imported !== undefined && (
          imported.ok
            ? (
              <div className="result-block">
                导入 {imported.imported} 条,重复 {imported.duplicates} 条,跳过 {imported.skipped.length} 条,异常 {imported.errors.length} 条。
                {imported.skipped.length > 0 && (
                  <ul className="candidate-list">
                    {imported.skipped.map((item, index) => (
                      <li key={index} className="candidate-row">
                        <span className="candidate-entry">{item.entry}</span>
                        <span className="candidate-reason">({item.reason})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
            : <div className="result-block">导入被拒绝:{imported.reason}</div>
        )}
      </section>

      <Banner state={banner} />
    </div>
  )
}

/**
 * 状态页:顶部 team 状态 → 中部统计指标块 → 正文 usage 图表(三张小图并列 +
 * 两张整行大图)+ 用量明细表。图表组件在 ../charts,样式在 ./status.css。
 */
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, Dashboard } from '../api'
import { formatCompact, formatBytes } from '../format'
import { CalendarHeatmap, CHART_COLORS, DailyBars, Donut, StackedBars, StaticBars } from '../charts'
import './status.css'

/** 状态页:顶部 team 状态 → 中部统计指标块 → 正文 usage 图表。 */
export function StatusPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [dashboard, setDashboard] = useState<Dashboard | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    rpc<{ dashboard: Dashboard }>(bootstrap, 'dashboard-get')
      .then(value => { setDashboard(value.dashboard); setError(undefined) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  if (dashboard === undefined) {
    return <div className="page"><div className="banner error">加载失败: {error}</div></div>
  }

  const { status, stats, usage } = dashboard
  const metrics = [
    { label: '总条目', value: stats.total.toLocaleString() },
    { label: 'rules', value: stats.rules.toLocaleString() },
    { label: 'lessons', value: stats.lessons.toLocaleString() },
    { label: 'global 层', value: stats.layers.global.toLocaleString() },
    { label: 'user 层', value: stats.layers.user.toLocaleString() },
    { label: 'project 层', value: stats.layers.project.toLocaleString() },
    { label: '有记忆的领域', value: stats.domains.length.toLocaleString() },
    { label: '记忆文件', value: stats.files.toLocaleString() },
    { label: 'jsonl 体积', value: formatBytes(stats.jsonlBytes) },
    { label: 'md 体积', value: formatBytes(stats.mdBytes) },
    { label: 'catalog 条目', value: stats.catalogEntries.toLocaleString() },
  ]
  const tokenSegments = usage.totals.map(counter => ({
    label: counter.label,
    value: counter.inputTokens + counter.outputTokens + counter.cacheReadTokens,
    color: CHART_COLORS[counter.label as 'recall' | 'extract' | 'review'] ?? CHART_COLORS.recall,
  }))
  const totalCalls = usage.totals.reduce((sum, counter) => sum + counter.calls, 0)

  return (
    <div className="page">
      <div className="status-head">
        <span className="status-title">记忆状态与用量 (Status &amp; Usage)</span>
        <button type="button" className="refresh" onClick={load}>刷新 (Refresh)</button>
      </div>
      {error !== undefined && <div className="banner error">刷新失败: {error}</div>}

      {/* 顶部:team 状态(本进程)。 */}
      <section className="card status-card">
        <header>
          <span className="section-title">Team 状态(本进程)</span>
          <span className="chip">maxNodeKb = {status.maxNodeKb}</span>
        </header>
        {status.teams.length === 0
          ? <p className="meta">No warm memory team. maxNodeKb={status.maxNodeKb}</p>
          : status.teams.map(team => (
            <div className="team-row" key={team.root}>
              <span className="mono team-root">{team.root === '' ? '(内置 + 用户层, no project)' : team.root}</span>
              <span className="team-nodes">{team.nodes} node(s)</span>
            </div>
          ))}
      </section>

      {/* 中部:统计指标块 */}
      <section className="metric-grid">
        {metrics.map(metric => (
          <div className="metric-card" key={metric.label}>
            <span className="metric-value">{metric.value}</span>
            <span className="metric-label">{metric.label}</span>
          </div>
        ))}
      </section>

      {/* 正文:usage 图表 —— 消耗类图表与每日图同源 usage.jsonl(近 14 天,host 级
          跨进程/跨重启);静态上下文成本是本进程实时装载(docs/status-page-usage.md)。 */}
      <section className="charts">
        <div className="card chart-card">
          <span className="section-title">Token 分布(按职责,近 14 天)</span>
          {totalCalls === 0
            ? <p className="meta">近 14 天尚无 LLM 调用 (recall / extract / review)。</p>
            : <Donut segments={tokenSegments} />}
        </div>
        <div className="card chart-card">
          <span className="section-title">LLM 调用消耗(输入 / 输出 / 缓存读,近 14 天)</span>
          {totalCalls === 0
            ? <p className="meta">近 14 天尚无 LLM 调用。</p>
            : <StackedBars rows={usage.totals} />}
        </div>
        <div className="card chart-card">
          <span className="section-title">静态上下文成本估算(本进程)</span>
          <StaticBars usage={usage} />
        </div>
      </section>
      <section className="charts-wide">
        <div className="card chart-card">
          <span className="section-title">近 14 天每日用量(host 级持久)</span>
          <DailyBars daily={usage.daily} />
        </div>
        <div className="card chart-card">
          <span className="section-title">近 12 周日历热力图(host 级持久)</span>
          <CalendarHeatmap daily={usage.daily} />
        </div>
      </section>

      {/* usage 明细表(近 14 天窗口,与上方消耗图同源);估算成本即时计算、不落盘,
          价格表随时可改,成本自动重算(docs/pricing-and-cost.md)。
          costs 字段缺省时(旧 host 进程 + 新面板资产的版本错配)优雅降级:不渲染成本列,
          而不是白屏——升级后重启进程即恢复完整功能。 */}
      <section className="card">
        <span className="section-title">用量明细 (Usage, 近 14 天)</span>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>职责</th>
                <th>调用次数</th>
                <th>输入 tokens</th>
                <th>输出 tokens</th>
                <th>缓存读 tokens</th>
                <th>合计 tokens</th>
                {usage.costs !== undefined && <th>估算成本 (¥)</th>}
              </tr>
            </thead>
            <tbody>
              {usage.totals.map(counter => {
                const costRow = usage.costs?.perLabel.find(row => row.label === counter.label)
                return (
                  <tr key={counter.label}>
                    <td>{counter.label}</td>
                    <td className="mono">{counter.calls.toLocaleString()}</td>
                    <td className="mono">{counter.inputTokens.toLocaleString()}</td>
                    <td className="mono">{counter.outputTokens.toLocaleString()}</td>
                    <td className="mono">{counter.cacheReadTokens.toLocaleString()}</td>
                    <td className="mono">{formatCompact(counter.inputTokens + counter.outputTokens + counter.cacheReadTokens)}</td>
                    {usage.costs !== undefined && (
                      <td className="mono">
                        {usage.costs.error !== undefined
                          ? '—(价格表不可用)'
                          : costRow?.yuan !== undefined
                            ? costRow.yuan.toFixed(2)
                            : costRow !== undefined && costRow.missingPricingRows > 0
                              ? `—(缺价 ${costRow.missingPricingRows} 行)`
                              : '—'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {usage.costs !== undefined && (
          <p className="meta">
            近 14 天估算成本合计:{usage.costs.error !== undefined
              ? `价格表不可用 (${usage.costs.error})`
              : `¥${usage.costs.totalYuan.toFixed(2)}${usage.costs.incomplete ? '(部分职责缺价,未计入)' : ''}`}
            · 依据 ~/.dsh/lmemory/pricing.json,改表即重算,成本不落盘
          </p>
        )}
      </section>
    </div>
  )
}

/**
 * 状态页:顶部 team 状态 → 中部统计指标块 → 正文 usage 图表(三张小图并列 +
 * 两张整行大图)+ 用量明细表。图表组件在 ../charts,样式在 ./status.css。
 */
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, Dashboard } from '../api'
import { formatCompact, formatBytes } from '../format'
import { CalendarHeatmap, CHART_COLORS, DailyBars, Donut, hourCostText, StackedBars, StaticBars, TodayBars } from '../charts'
import { ActivityTable } from './ActivityTable'
import './status.css'

/** 状态页自动刷新间隔:记忆活动大表是实时视图(docs/memory-activity.md)。 */
const POLL_MS = 60_000

/** 状态页:顶部 team 状态 → 中部统计指标块 → 正文 usage 图表。 */
export function StatusPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [dashboard, setDashboard] = useState<Dashboard | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  /** 每日图/明细表共享的选中天:点日行展开该天 24 小时视图(docs/status-page-usage.md)。 */
  const [selectedDay, setSelectedDay] = useState<string | undefined>(undefined)

  const load = useCallback(() => {
    setLoading(true)
    rpc<{ dashboard: Dashboard }>(bootstrap, 'dashboard-get')
      .then(value => { setDashboard(value.dashboard); setError(undefined) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

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
        <span className="meta">每 60s 自动刷新</span>
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

      {/* 顶部大表:记忆活动(近 24h × 15min),位于统计指标块上方。 */}
      {dashboard.activity !== undefined && <ActivityTable activity={dashboard.activity} />}

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
          <DailyBars
            daily={usage.daily}
            hourly={usage.hourly}
            costs={usage.costs}
            selectedDay={selectedDay}
            onSelect={setSelectedDay}
          />
        </div>
      </section>
      <section className="charts-pair">
        <div className="card chart-card">
          <span className="section-title">LLM 调用消耗(输入 / 输出 / 缓存读,今天(按日期))</span>
          <TodayBars hourly={usage.hourly} />
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
        {/* 日期胶囊(位于按职责汇总表下方):点击某天展开该天 24 小时二级表
            (与上方每日用量图共享选中态);选中态高亮,用户看到日期即知已点。 */}
        <div className="day-chips">
          {usage.daily.slice(-14).map(day => (
            <button
              key={day.day}
              type="button"
              className={`day-chip${selectedDay === day.day ? ' selected' : ''}`}
              title={`展开 ${day.day} 24 小时明细`}
              onClick={() => setSelectedDay(selectedDay === day.day ? undefined : day.day)}
            >
              {day.day.slice(5)}
            </button>
          ))}
        </div>
        <p className="meta">点击日期胶囊或上方每日用量图的某天,展开该天 24 小时二级明细表(两处选中态联动)。</p>
        {selectedDay !== undefined && usage.hourly !== undefined && (
          <div className="detail-wrap">
            {/* 二级表控件头:高亮选中日期 + 收起按钮(明确的展开状态与关闭入口)。 */}
            <div className="detail-head">
              <span className="detail-title">▾ {selectedDay} 24 小时明细</span>
              <button type="button" className="detail-close" onClick={() => setSelectedDay(undefined)}>收起 (Close)</button>
            </div>
            <div className="table-wrap">
              <table className="detail-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>调用次数</th>
                    <th>输入 tokens</th>
                    <th>输出 tokens</th>
                    <th>缓存读 tokens</th>
                    <th>合计 tokens</th>
                    {usage.costs !== undefined && <th>估算成本 (¥)</th>}
                  </tr>
                </thead>
                <tbody>
                  {usage.hourly.filter(bucket => bucket.day === selectedDay).map(bucket => {
                    const calls = bucket.recall.calls + bucket.extract.calls + bucket.review.calls
                    const input = bucket.recall.inputTokens + bucket.extract.inputTokens + bucket.review.inputTokens
                    const output = bucket.recall.outputTokens + bucket.extract.outputTokens + bucket.review.outputTokens
                    const cacheRead = bucket.recall.cacheReadTokens + bucket.extract.cacheReadTokens + bucket.review.cacheReadTokens
                    return (
                      <tr key={bucket.hour}>
                        <td className="mono">{bucket.day.slice(5)} {String(bucket.hour).padStart(2, '0')}:00</td>
                        <td className="mono">{calls.toLocaleString()}</td>
                        <td className="mono">{input.toLocaleString()}</td>
                        <td className="mono">{output.toLocaleString()}</td>
                        <td className="mono">{cacheRead.toLocaleString()}</td>
                        <td className="mono">{formatCompact(bucket.total)}</td>
                        {usage.costs !== undefined && <td className="mono">{hourCostText(bucket)}</td>}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
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

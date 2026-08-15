/**
 * 面板根组件:读 bootstrap,按 page 渲染记忆页或设置页。
 * 渲染只走 React 文本节点(无 dangerouslySetInnerHTML),记忆内容不会进入 HTML
 * 执行路径;样式令牌镜像 dsh 设计系统(见 styles.css)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DISPLAY, readBootstrap, rpc } from './api'
import type { Bootstrap, ConfigItem, Dashboard, DayUsage, EntryRow, Filters } from './api'

/** 渲染本地时间 `YYYY-MM-DD HH:mm:ss`。 */
function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 本地日期 `YYYY-MM-DD`(Timeline 分组键)。 */
function dateKey(epochMs: number): string {
  return formatTime(epochMs).slice(0, 10)
}

/** 大数紧凑化:>=1M → `1.2M`,>=1k → `3.4k`,否则千分位。 */
function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString()
}

/** 字节数人类化(Kb / Mb,与 host 侧 renderBytes 同口径)。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kb`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mb`
}

/** 面板页面(导航 tab 的恒等集合)。 */
const PAGES = ['memory', 'status', 'settings'] as const

const PAGE_LABELS: Readonly<Record<(typeof PAGES)[number], string>> = {
  memory: '记忆 (Memory)',
  status: '状态 (Status)',
  settings: '设置 (Settings)',
}

const PAGE_PATHS: Readonly<Record<(typeof PAGES)[number], string>> = {
  memory: '/memory',
  status: '/memory/status',
  settings: '/memory/settings',
}

/** 页面导航(三页互链,恒带 ac_token)。 */
function Nav({ page, token }: { readonly page: Bootstrap['page']; readonly token: string }): JSX.Element {
  const target = (next: Bootstrap['page']) => next === page
    ? undefined
    : `${PAGE_PATHS[next]}?ac_token=${encodeURIComponent(token)}`
  return (
    <nav className="tabs">
      {PAGES.map(next => (
        <span key={next}>
          {target(next) === undefined
            ? <span className="tab active">{PAGE_LABELS[next]}</span>
            : <a className="tab" href={target(next)}>{PAGE_LABELS[next]}</a>}
        </span>
      ))}
    </nav>
  )
}

// ---- 记忆页 ----

/** 过滤条 + 布局切换 + 计数。 */
function FilterBar(props: {
  readonly filters: Filters
  readonly onChange: (next: Filters) => void
  readonly layout: 'timeline' | 'table'
  readonly onLayout: (next: 'timeline' | 'table') => void
  readonly total: number
}): JSX.Element {
  const { filters, onChange, layout, onLayout, total } = props
  return (
    <div className="filter-bar">
      <input
        className="search"
        type="search"
        placeholder="搜索 entry / scope / domain"
        value={filters.query ?? ''}
        onChange={event => onChange({ ...filters, query: event.target.value })}
      />
      <select value={filters.type ?? ''} onChange={event => onChange({ ...filters, type: event.target.value })}>
        <option value="">全部类型</option>
        {DISPLAY.types.map(type => <option key={type} value={type}>{type}</option>)}
      </select>
      <select value={filters.domain ?? ''} onChange={event => onChange({ ...filters, domain: event.target.value })}>
        <option value="">全部领域</option>
        {DISPLAY.domains.map(domain => <option key={domain} value={domain}>{domain}</option>)}
      </select>
      <select value={filters.layer ?? ''} onChange={event => onChange({ ...filters, layer: event.target.value })}>
        <option value="">全部层</option>
        {DISPLAY.layers.map(layer => <option key={layer} value={layer}>{layer}</option>)}
      </select>
      <span className="count">{total} 条</span>
      <div className="layout-toggle">
        <button type="button" className={layout === 'timeline' ? 'active' : ''} onClick={() => onLayout('timeline')}>Timeline</button>
        <button type="button" className={layout === 'table' ? 'active' : ''} onClick={() => onLayout('table')}>Table</button>
      </div>
    </div>
  )
}

/** 条目徽标:type 与 domain 的颜色来自 dsh 状态色板。 */
function Badges({ entry }: { readonly entry: EntryRow['entry'] }): JSX.Element {
  return (
    <span className="badges">
      <span className={`badge ${entry.type}`}>{entry.type}</span>
      <span className="badge domain">{entry.domain}</span>
      <span className="badge layer">{entry.layer}</span>
    </span>
  )
}

/** Timeline:按本地日期分组(降序),每天一组卡片。 */
function TimelineView({ rows }: { readonly rows: readonly EntryRow[] }): JSX.Element {
  const groups = useMemo(() => {
    const map = new Map<string, EntryRow[]>()
    for (const row of rows) {
      const key = dateKey(row.entry.createdAt)
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [row])
      else bucket.push(row)
    }
    return [...map.entries()]
  }, [rows])
  if (groups.length === 0) return <div className="empty">暂无记忆条目 (No memory entries)</div>
  return (
    <div className="timeline">
      {groups.map(([day, group]) => (
        <section key={day}>
          <h2 className="day">{day} <span className="day-count">{group.length} 条</span></h2>
          {group.map(row => (
            <article key={row.entry.id} className="card">
              <header>
                <Badges entry={row.entry} />
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
        </section>
      ))}
    </div>
  )
}

/** Table:完整字段平铺。 */
function TableView({ rows }: { readonly rows: readonly EntryRow[] }): JSX.Element {
  if (rows.length === 0) return <div className="empty">暂无记忆条目 (No memory entries)</div>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>创建时间 (createdAt)</th>
            <th>类型</th>
            <th>所属知识领域 (domain)</th>
            <th>影响范围 (Scope)</th>
            <th>Layer (落点层)</th>
            <th>条目</th>
            <th>entry point</th>
            <th>references</th>
            <th>file</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.entry.id}>
              <td className="mono">{row.entry.id}</td>
              <td className="mono nowrap">{formatTime(row.entry.createdAt)}</td>
              <td>{row.entry.type}</td>
              <td>{row.entry.domain}</td>
              <td>{row.entry.scope}</td>
              <td>{row.entry.layer}</td>
              <td className="entry-cell">{row.entry.entry}</td>
              <td className="mono">{row.entry.entryPoint}</td>
              <td className="mono">{row.entry.references}</td>
              <td className="mono">{row.file}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 记忆页:过滤条 + Timeline/Table 布局切换。 */
function MemoryPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [filters, setFilters] = useState<Filters>({})
  const [layout, setLayout] = useState<'timeline' | 'table'>('timeline')
  const [rows, setRows] = useState<readonly EntryRow[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 查询词防抖 300ms;其余过滤即时。
    const timer = setTimeout(() => {
      setLoading(true)
      const payload: Record<string, unknown> = { filters: {} }
      const wire = payload.filters as Record<string, unknown>
      if (filters.type !== undefined && filters.type !== '') wire.type = filters.type
      if (filters.domain !== undefined && filters.domain !== '') wire.domain = filters.domain
      if (filters.layer !== undefined && filters.layer !== '') wire.layer = filters.layer
      if (filters.query !== undefined && filters.query !== '') wire.query = filters.query
      rpc<{ entries: EntryRow[] }>(bootstrap, 'entries', payload)
        .then(value => { setRows(value.entries); setError(undefined) })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false))
    }, filters.query === undefined || filters.query === '' ? 0 : 300)
    return () => clearTimeout(timer)
  }, [bootstrap, filters])

  return (
    <div className="page">
      <FilterBar filters={filters} onChange={setFilters} layout={layout} onLayout={setLayout} total={rows.length} />
      {error !== undefined && <div className="banner error">加载失败: {error}</div>}
      {loading
        ? <div className="empty">加载中 (Loading)…</div>
        : layout === 'timeline' ? <TimelineView rows={rows} /> : <TableView rows={rows} />}
    </div>
  )
}

// ---- 状态页 ----

/** 图表配色(镜像 dsh 设计令牌:deepseek 蓝系 + amber,三个职责分类各一色)。 */
const CHART_COLORS = {
  recall: 'rgb(65, 118, 230)', // --dsw-static-deepseek-500
  extract: 'rgb(103, 158, 254)', // --dsw-static-deepseek-400
  review: 'rgb(245, 158, 11)', // --dsw-static-amber-500
  input: 'rgb(65, 118, 230)',
  output: 'rgb(103, 158, 254)',
  cache: 'rgb(245, 158, 11)',
  warm: 'rgb(65, 118, 230)',
  summary: 'rgb(103, 158, 254)',
} as const

/** 纯 SVG 甜甜圈:各职责分类的 token 占比(无外部图表库)。 */
function Donut({ segments }: { readonly segments: readonly { readonly label: string; readonly value: number; readonly color: string }[] }): JSX.Element {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const radius = 54
  const circumference = 2 * Math.PI * radius
  let accumulated = 0
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="token 分布">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--chart-track)" strokeWidth="14" />
        {segments.map(segment => {
          const fraction = total > 0 ? segment.value / total : 0
          const dash = fraction * circumference
          const arc = (
            <circle key={segment.label} cx="70" cy="70" r={radius} fill="none"
              stroke={segment.color} strokeWidth="14"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-accumulated}
              transform="rotate(-90 70 70)" />
          )
          accumulated += dash
          return arc
        })}
        <text x="70" y="66" textAnchor="middle" className="donut-center">{formatCompact(total)}</text>
        <text x="70" y="82" textAnchor="middle" className="donut-sub">tokens</text>
      </svg>
      <div className="legend">
        {segments.map(segment => (
          <div className="legend-row" key={segment.label}>
            <span className="legend-dot" style={{ background: segment.color }} />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-value">{formatCompact(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 水平堆叠条:每个职责分类的输入 / 输出 / 缓存读 token(组/类 → 条 → 指标,图例在下)。 */
function StackedBars({ rows }: { readonly rows: Dashboard['usage']['counters'] }): JSX.Element {
  const maxTotal = Math.max(1, ...rows.map(row => row.inputTokens + row.outputTokens + row.cacheReadTokens))
  const width = (value: number): string => `${(value / maxTotal) * 100}%`
  return (
    <div className="bars">
      {rows.map(row => (
        <div className="bar-row" key={row.label}>
          <span className="bar-label">{row.label}</span>
          <div className="bar-track">
            <span className="bar-seg" style={{ width: width(row.inputTokens), background: CHART_COLORS.input }} title={`input ${row.inputTokens.toLocaleString()}`} />
            <span className="bar-seg" style={{ width: width(row.outputTokens), background: CHART_COLORS.output }} title={`output ${row.outputTokens.toLocaleString()}`} />
            <span className="bar-seg" style={{ width: width(row.cacheReadTokens), background: CHART_COLORS.cache }} title={`cacheRead ${row.cacheReadTokens.toLocaleString()}`} />
          </div>
          <span className="bar-metric">
            {formatCompact(row.inputTokens + row.outputTokens + row.cacheReadTokens)} tok · {row.calls} calls
          </span>
        </div>
      ))}
      <div className="legend">
        {([['input', '输入 input'], ['output', '输出 output'], ['cache', '缓存读 cacheRead']] as const).map(([key, label]) => (
          <div className="legend-row" key={key}>
            <span className="legend-dot" style={{ background: CHART_COLORS[key] }} />
            <span className="legend-label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 水平对比条:静态上下文成本(预热 team vs system prompt 摘要;组/类 → 条 → 指标)。 */
function StaticBars({ usage }: { readonly usage: Dashboard['usage'] }): JSX.Element {
  const max = Math.max(1, usage.warmTeams.tokens, usage.summary.tokens)
  const width = (value: number): string => `${(value / max) * 100}%`
  const rows = [
    { label: `预热 team (${usage.warmTeams.nodes} nodes)`, tokens: usage.warmTeams.tokens, chars: usage.warmTeams.chars, color: CHART_COLORS.warm },
    { label: 'system prompt 摘要', tokens: usage.summary.tokens, chars: usage.summary.chars, color: CHART_COLORS.summary },
  ]
  return (
    <div className="bars">
      {rows.map(row => (
        <div className="bar-row" key={row.label}>
          <span className="bar-label">{row.label}</span>
          <div className="bar-track">
            <span className="bar-seg" style={{ width: width(row.tokens), background: row.color }} />
          </div>
          <span className="bar-metric">{formatCompact(row.tokens)} tok est. · {formatBytes(row.chars)}</span>
        </div>
      ))}
    </div>
  )
}

/** 近 14 天堆叠柱状图:每天一列,recall/extract/review 三色分段。 */
function DailyBars({ daily }: { readonly daily: readonly DayUsage[] }): JSX.Element {
  const windowDays = daily.slice(-14)
  const maxTotal = Math.max(1, ...windowDays.map(day => day.total))
  const width = (value: number): string => `${(value / maxTotal) * 100}%`
  const labelOf = (usage: DayUsage['recall']): number => usage.totalTokens
  return (
    <div className="bars">
      {windowDays.map(day => (
        <div className="bar-row" key={day.day}>
          <span className="bar-label mono">{day.day.slice(5)}</span>
          <div className="bar-track">
            <span className="bar-seg" style={{ width: width(labelOf(day.recall)), background: CHART_COLORS.recall }} title={`recall ${day.recall.totalTokens.toLocaleString()}`} />
            <span className="bar-seg" style={{ width: width(labelOf(day.extract)), background: CHART_COLORS.extract }} title={`extract ${day.extract.totalTokens.toLocaleString()}`} />
            <span className="bar-seg" style={{ width: width(labelOf(day.review)), background: CHART_COLORS.review }} title={`review ${day.review.totalTokens.toLocaleString()}`} />
          </div>
          <span className="bar-metric">{day.total > 0 ? formatCompact(day.total) : '—'}</span>
        </div>
      ))}
    </div>
  )
}

/** 日总 token → 热力强度档(5 档)。 */
function heatLevel(total: number): 0 | 1 | 2 | 3 | 4 {
  if (total <= 0) return 0
  if (total < 1_000) return 1
  if (total < 10_000) return 2
  if (total < 100_000) return 3
  return 4
}

/** 热力档 → 底色(dsh deepseek 蓝系)。 */
function heatColor(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0: return 'var(--heat-0)'
    case 1: return 'var(--heat-1)'
    case 2: return 'var(--heat-2)'
    case 3: return 'var(--heat-3)'
    default: return 'var(--heat-4)'
  }
}

/** 把 `YYYY-MM-DD` 解析为本地 Date(不带时刻)。 */
function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

/** 本地日期 → `YYYY-MM-DD`。 */
function dayKey(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 近 12 周日历热力图(GitHub 风格:列=周,行=周一..周日,5 档强度)。 */
function CalendarHeatmap({ daily }: { readonly daily: readonly DayUsage[] }): JSX.Element {
  const byDay = useMemo(() => new Map(daily.map(day => [day.day, day])), [daily])
  const today = daily.length > 0 ? parseDay(daily[daily.length - 1]!.day) : new Date()
  const weeks = 12
  const cells: { key: string; level: 0 | 1 | 2 | 3 | 4; title: string; inWindow: boolean }[] = []
  for (let col = 0; col < weeks; col++) {
    const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (weeks - 1 - col) * 7)
    for (let row = 0; row < 7; row++) {
      const date = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - (6 - row))
      const key = dayKey(date)
      const bucket = byDay.get(key)
      const inWindow = bucket !== undefined
      const total = bucket?.total ?? 0
      cells.push({
        key: `${col}-${row}`,
        level: inWindow ? heatLevel(total) : 0,
        title: inWindow ? `${key}: ${total.toLocaleString()} tokens` : key,
        inWindow,
      })
    }
  }
  return (
    <div className="heatmap-wrap">
      <div className="heatmap" role="img" aria-label="近 12 周每日 token 热力图">
        {cells.map(cell => (
          <span
            key={cell.key}
            className={`heat-cell${cell.inWindow ? '' : ' out'}`}
            style={{ background: heatColor(cell.level) }}
            title={cell.title}
          />
        ))}
      </div>
      <div className="heat-legend">
        <span className="heat-legend-label">少</span>
        {([0, 1, 2, 3, 4] as const).map(level => (
          <span key={level} className="heat-cell" style={{ background: heatColor(level) }} />
        ))}
        <span className="heat-legend-label">多</span>
      </div>
    </div>
  )
}

/** 状态页:顶部 team 状态 → 中部统计指标块 → 正文 usage 图表。 */
function StatusPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
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
  const tokenSegments = usage.counters.map(counter => ({
    label: counter.label,
    value: counter.inputTokens + counter.outputTokens + counter.cacheReadTokens,
    color: CHART_COLORS[counter.label as 'recall' | 'extract' | 'review'] ?? CHART_COLORS.recall,
  }))
  const totalCalls = usage.counters.reduce((sum, counter) => sum + counter.calls, 0)

  return (
    <div className="page">
      <div className="status-head">
        <span className="status-title">记忆状态与用量 (Status &amp; Usage)</span>
        <button type="button" className="refresh" onClick={load}>刷新 (Refresh)</button>
      </div>
      {error !== undefined && <div className="banner error">刷新失败: {error}</div>}

      {/* 顶部:team 状态 */}
      <section className="card status-card">
        <header>
          <span className="section-title">Team 状态</span>
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

      {/* 正文:usage 图表 */}
      <section className="charts">
        <div className="card chart-card">
          <span className="section-title">Token 分布(按职责)</span>
          {totalCalls === 0
            ? <p className="meta">本进程尚无 LLM 调用 (recall / extract / review)。</p>
            : <Donut segments={tokenSegments} />}
        </div>
        <div className="card chart-card">
          <span className="section-title">LLM 调用消耗(输入 / 输出 / 缓存读)</span>
          {totalCalls === 0
            ? <p className="meta">本进程尚无 LLM 调用。</p>
            : <StackedBars rows={usage.counters} />}
        </div>
        <div className="card chart-card">
          <span className="section-title">静态上下文成本估算</span>
          <StaticBars usage={usage} />
        </div>
        <div className="card chart-card">
          <span className="section-title">近 14 天每日用量</span>
          <DailyBars daily={usage.daily} />
        </div>
        <div className="card chart-card">
          <span className="section-title">近 12 周日历热力图</span>
          <CalendarHeatmap daily={usage.daily} />
        </div>
      </section>

      {/* usage 明细表 */}
      <section className="card">
        <span className="section-title">用量明细 (Usage)</span>
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
              </tr>
            </thead>
            <tbody>
              {usage.counters.map(counter => (
                <tr key={counter.label}>
                  <td>{counter.label}</td>
                  <td className="mono">{counter.calls.toLocaleString()}</td>
                  <td className="mono">{counter.inputTokens.toLocaleString()}</td>
                  <td className="mono">{counter.outputTokens.toLocaleString()}</td>
                  <td className="mono">{counter.cacheReadTokens.toLocaleString()}</td>
                  <td className="mono">{formatCompact(counter.inputTokens + counter.outputTokens + counter.cacheReadTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ---- 设置页 ----

/** 单个配置项的编辑控件(按 kind 出表单控件)。 */
function ConfigField(props: {
  readonly item: ConfigItem
  readonly value: string
  readonly onChange: (next: string) => void
}): JSX.Element {
  const { item, value, onChange } = props
  switch (item.meta.kind) {
    case 'boolean':
      return (
        <label className="check">
          <input type="checkbox" checked={value === 'true'} onChange={event => onChange(String(event.target.checked))} />
          <span>{item.key}</span>
        </label>
      )
    case 'enum':
      return (
        <select value={value} onChange={event => onChange(event.target.value)}>
          {(item.meta.options ?? []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      )
    case 'number':
      return <input type="number" step="1" min="1" value={value} onChange={event => onChange(event.target.value)} />
    case 'textarea':
      return <textarea rows={5} value={value} onChange={event => onChange(event.target.value)} />
    default:
      return <input type="text" value={value} onChange={event => onChange(event.target.value)} />
  }
}

/** 设置页:13 个配置键的表单,统一保存(config-set)。 */
function SettingsPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
  const [items, setItems] = useState<readonly ConfigItem[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    rpc<{ config: ConfigItem[] }>(bootstrap, 'config-get')
      .then(value => {
        setItems(value.config)
        const next: Record<string, string> = {}
        for (const item of value.config) next[item.key] = String(item.value)
        setValues(next)
        setBanner(undefined)
      })
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLoading(false))
  }, [bootstrap])

  /** 变化的键 → 按 kind 转回 JS 值,组成 config-set 的 patch。 */
  const patch = useMemo(() => {
    const next: Record<string, unknown> = {}
    for (const item of items) {
      const raw = values[item.key]
      if (raw === undefined || raw === String(item.value)) continue
      if (item.meta.kind === 'number') {
        const num = Number(raw)
        if (!Number.isFinite(num)) continue
        next[item.key] = num
      } else if (item.meta.kind === 'boolean') {
        next[item.key] = raw === 'true'
      } else {
        next[item.key] = raw
      }
    }
    return next
  }, [items, values])

  const save = useCallback(() => {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    rpc<{ config: ConfigItem[] }>(bootstrap, 'config-set', { patch })
      .then(value => {
        setItems(value.config)
        const next: Record<string, string> = {}
        for (const item of value.config) next[item.key] = String(item.value)
        setValues(next)
        setBanner({ kind: 'ok', text: `已保存 (Saved): ${keys.join(', ')}` })
      })
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [bootstrap, patch])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  return (
    <div className="page narrow">
      {banner !== undefined && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      <form className="card form" onSubmit={(event) => { event.preventDefault(); save() }}>
        {items.map(item => (
          <div className="field" key={item.key}>
            <label className="field-head">
              <span className="mono key">{item.key}</span>
              <span className="desc">{item.meta.description}</span>
            </label>
            <ConfigField item={item} value={values[item.key] ?? ''} onChange={next => setValues(prev => ({ ...prev, [item.key]: next }))} />
          </div>
        ))}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={Object.keys(patch).length === 0}>保存 (Save)</button>
          {Object.keys(patch).length > 0 && <span className="desc">{Object.keys(patch).length} 项已修改</span>}
        </div>
      </form>
    </div>
  )
}

// ---- 根组件 ----

/** 根组件:bootstrap → 页头(导航)→ 记忆页 / 设置页。 */
export function App(): JSX.Element {
  const [bootstrap] = useState(readBootstrap)
  if (bootstrap === undefined) {
    return <div className="empty">引导数据缺失 (bootstrap missing): 请从 /lmemory ui 的链接打开面板</div>
  }
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">dsh-memory</span>
        <Nav page={bootstrap.page} token={bootstrap.token} />
      </header>
      {bootstrap.page === 'memory'
        ? <MemoryPage bootstrap={bootstrap} />
        : bootstrap.page === 'status'
          ? <StatusPage bootstrap={bootstrap} />
          : <SettingsPage bootstrap={bootstrap} />}
    </div>
  )
}

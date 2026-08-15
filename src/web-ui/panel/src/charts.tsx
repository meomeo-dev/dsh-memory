/**
 * 状态页图表组件:纯 SVG/div 实现(零外部图表库,满足 CSP `default-src 'none'`),
 * 配色镜像 dsh 设计令牌(deepseek 蓝系 + amber)。样式在 ./charts.css。
 */
import { useMemo } from 'react'
import type { Dashboard, DayUsage, HourUsage } from './api'
import { formatCompact, formatBytes } from './format'
import './charts.css'

/** 图表配色(镜像 dsh 设计令牌:deepseek 蓝系 + amber,三个职责分类各一色)。 */
export const CHART_COLORS = {
  recall: 'rgb(65, 118, 230)', // --dsw-static-deepseek-500
  extract: 'rgb(103, 158, 254)', // --dsw-static-deepseek-400
  review: 'rgb(245, 158, 11)', // --dsw-static-amber-500
  input: 'rgb(65, 118, 230)',
  output: 'rgb(103, 158, 254)',
  cache: 'rgb(245, 158, 11)',
  warm: 'rgb(65, 118, 230)',
  summary: 'rgb(103, 158, 254)',
} as const

/** 纯 SVG 甜甜圈:各职责分类的 token 占比。 */
export function Donut({ segments }: { readonly segments: readonly { readonly label: string; readonly value: number; readonly color: string }[] }): JSX.Element {
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
export function StackedBars({ rows }: { readonly rows: Dashboard['usage']['totals'] }): JSX.Element {
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
export function StaticBars({ usage }: { readonly usage: Dashboard['usage'] }): JSX.Element {
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

/** 某天的成本文案:无调用显示 `—`,缺价显示 `—(缺价 N 行)`,否则两位小数。 */
function dayCostText(day: DayUsage, cost: { readonly yuan?: number; readonly missingPricingRows: number } | undefined): string {
  if (day.total === 0) return '—'
  if (cost === undefined) return '—'
  if (cost.yuan === undefined) return `—(缺价 ${cost.missingPricingRows} 行)`
  return `¥${cost.yuan.toFixed(2)}`
}

/** 小时桶成本文案:无调用 `—`;缺价 `—(缺价 N 行)`;小值 4 位小数(时级金额常小于 0.01 元),否则两位。 */
export function hourCostText(bucket: HourUsage): string {
  if (bucket.total === 0) return '—'
  if (bucket.missingPricingRows !== undefined && bucket.missingPricingRows > 0) return `—(缺价 ${bucket.missingPricingRows} 行)`
  if (bucket.yuan !== undefined) return bucket.yuan < 0.01 ? `¥${bucket.yuan.toFixed(4)}` : `¥${bucket.yuan.toFixed(2)}`
  return '—'
}

/** 近 14 天每日用量:紧凑水平条形图(日期 | 三段条 | 总 token | 当日成本,单行一项)。
 *  行可点击:选中某天后在其下方就地展开该天 24 小时水平柱状图(行高收窄);
 *  底部合计行在总 token 右侧显示近 14 天成本合计(docs/status-page-usage.md)。 */
export function DailyBars({ daily, hourly, costs, selectedDay, onSelect }: {
  readonly daily: readonly DayUsage[]
  readonly hourly?: readonly HourUsage[]
  readonly costs?: Dashboard['usage']['costs']
  readonly selectedDay: string | undefined
  readonly onSelect: (day: string | undefined) => void
}): JSX.Element {
  const windowDays = daily.slice(-14)
  const maxTotal = Math.max(1, ...windowDays.map(day => day.total))
  const width = (value: number): string => `${(value / maxTotal) * 100}%`
  const hoursOf = (day: string): HourUsage[] => (hourly ?? []).filter(bucket => bucket.day === day)
  const totalTokens = windowDays.reduce((sum, day) => sum + day.total, 0)
  const totalCalls = windowDays.reduce((sum, day) => sum + day.recall.calls + day.extract.calls + day.review.calls, 0)
  return (
    <div className="hbars">
      {windowDays.map(day => {
        const selected = selectedDay === day.day
        const dayCost = costs?.daily?.find(entry => entry.day === day.day)
        return (
          <div className="hbar-group" key={day.day}>
            <div
              className={`hbar-row clickable${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              title={selected ? '收起该天 24 小时视图' : '展开该天 24 小时视图'}
              onClick={() => onSelect(selected ? undefined : day.day)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(selected ? undefined : day.day)
                }
              }}
            >
              <span className="hbar-label mono">{day.day.slice(5)}</span>
              <div className="hbar-track">
                <span className="hbar-seg" style={{ width: width(day.recall.totalTokens), background: CHART_COLORS.recall }} title={`recall ${day.recall.totalTokens.toLocaleString()}`} />
                <span className="hbar-seg" style={{ width: width(day.extract.totalTokens), background: CHART_COLORS.extract }} title={`extract ${day.extract.totalTokens.toLocaleString()}`} />
                <span className="hbar-seg" style={{ width: width(day.review.totalTokens), background: CHART_COLORS.review }} title={`review ${day.review.totalTokens.toLocaleString()}`} />
              </div>
              <span className="hbar-metric">{day.total > 0 ? formatCompact(day.total) : '—'}</span>
              {costs !== undefined && <span className="hbar-cost">{dayCostText(day, dayCost)}</span>}
            </div>
            {selected && (
              <div className="hour-bars">
                {hoursOf(day.day).map(bucket => (
                  <div className="hour-row" key={bucket.hour}>
                    <span className="hbar-label mono">{String(bucket.hour).padStart(2, '0')}:00</span>
                    <div className="hbar-track">
                      <span className="hbar-seg" style={{ width: width(bucket.recall.totalTokens), background: CHART_COLORS.recall }} title={`recall ${bucket.recall.totalTokens.toLocaleString()}`} />
                      <span className="hbar-seg" style={{ width: width(bucket.extract.totalTokens), background: CHART_COLORS.extract }} title={`extract ${bucket.extract.totalTokens.toLocaleString()}`} />
                      <span className="hbar-seg" style={{ width: width(bucket.review.totalTokens), background: CHART_COLORS.review }} title={`review ${bucket.review.totalTokens.toLocaleString()}`} />
                    </div>
                    <span className="hbar-metric">{bucket.total > 0 ? formatCompact(bucket.total) : '—'}</span>
                    {costs !== undefined && <span className="hbar-cost">{hourCostText(bucket)}</span>}
                  </div>
                ))}
                {hoursOf(day.day).length === 0 && <p className="meta">该天无小时数据(旧 host 进程,重启后可用)。</p>}
              </div>
            )}
          </div>
        )
      })}
      <div className="daily-total">
        <span className="daily-total-label">合计</span>
        <span className="daily-total-metric">{formatCompact(totalTokens)} tok · {totalCalls.toLocaleString()} calls</span>
        {costs !== undefined && (
          <span className="daily-total-cost">
            {costs.error !== undefined
              ? '—(价格表不可用)'
              : `¥${costs.totalYuan.toFixed(2)}${costs.incomplete ? '(部分职责缺价,未计入)' : ''}`}
          </span>
        )}
      </div>
      <div className="legend">
        {([['recall', 'recall'], ['extract', 'extract'], ['review', 'review']] as const).map(([key, label]) => (
          <div className="legend-row" key={key}>
            <span className="legend-dot" style={{ background: CHART_COLORS[key] }} />
            <span className="legend-label">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 今天(自然日,00:00 起)的 LLM 调用消耗小图:与「近 14 天」小图同款 StackedBars,
 *  数据 = 今天 24 个 hourly 桶按职责汇总(docs/status-page-usage.md)。 */
export function TodayBars({ hourly }: { readonly hourly?: readonly HourUsage[] }): JSX.Element {
  const buckets = hourly ?? []
  const today = buckets.length > 0 ? buckets[buckets.length - 1]!.day : undefined
  const dayBuckets = today === undefined ? [] : buckets.filter(bucket => bucket.day === today)
  const rows = (['recall', 'extract', 'review'] as const).map(label => ({
    label,
    calls: dayBuckets.reduce((sum, bucket) => sum + bucket[label].calls, 0),
    inputTokens: dayBuckets.reduce((sum, bucket) => sum + bucket[label].inputTokens, 0),
    outputTokens: dayBuckets.reduce((sum, bucket) => sum + bucket[label].outputTokens, 0),
    cacheReadTokens: dayBuckets.reduce((sum, bucket) => sum + bucket[label].cacheReadTokens, 0),
  }))
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0)
  if (totalCalls === 0) return <p className="meta">今天尚无 LLM 调用。</p>
  return <StackedBars rows={rows} />
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
function dayKeyOf(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** 近 12 周日历热力图(table 布局:列=周(表头 MM-DD),行=周一..周日(左列标签),
 *  5 档强度;格子随卡片宽度自适应,不再固定 12px)。 */
export function CalendarHeatmap({ daily }: { readonly daily: readonly DayUsage[] }): JSX.Element {
  const byDay = useMemo(() => new Map(daily.map(day => [day.day, day])), [daily])
  const today = daily.length > 0 ? parseDay(daily[daily.length - 1]!.day) : new Date()
  const weeks = 12
  const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const
  const columns: { monday: string; cells: { key: string; level: 0 | 1 | 2 | 3 | 4; title: string; inWindow: boolean }[] }[] = []
  for (let col = 0; col < weeks; col++) {
    const weekEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (weeks - 1 - col) * 7)
    const monday = dayKeyOf(new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - 6))
    const cells: { key: string; level: 0 | 1 | 2 | 3 | 4; title: string; inWindow: boolean }[] = []
    for (let row = 0; row < 7; row++) {
      const date = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - (6 - row))
      const key = dayKeyOf(date)
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
    columns.push({ monday, cells })
  }
  return (
    <div className="heatmap-wrap">
      <table className="heatmap-table" role="img" aria-label="近 12 周每日 token 热力图">
        <thead>
          <tr>
            <th className="heatmap-corner" />
            {columns.map(column => (
              <th key={column.monday} className="heatmap-week">{column.monday.slice(5)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weekdayLabels.map((label, row) => (
            <tr key={label}>
              <th className="heatmap-weekday">{label}</th>
              {columns.map(column => {
                const cell = column.cells[row]!
                return (
                  <td key={cell.key} className={`heatmap-cell${cell.inWindow ? '' : ' out'}`}>
                    <span className="heat-dot" style={{ background: heatColor(cell.level) }} title={cell.title} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
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

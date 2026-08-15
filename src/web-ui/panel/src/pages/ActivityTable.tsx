/**
 * 记忆活动大表(docs/memory-activity.md):最近 24 小时、1 小时一格,X 轴时间、
 * Y 轴 rules/lessons × domain 组合轴(42 行),格子显示该窗口内新写入条目数。
 * 样式在 ./status.css;渲染只走 React 文本节点。
 */
import type { Dashboard } from '../api'
import { DISPLAY } from '../api'

/** 3 字符封顶显示(镜像 host 侧 memory-activity.formatActivityCount):≤999 原值,以上量级封顶。 */
export function formatActivityCount(value: number): string {
  if (value < 1000) return String(value)
  if (value >= 1e15) return '99T'
  if (value >= 1e12) return '99B'
  if (value >= 1e9) return '99G'
  if (value >= 1e6) return '99M'
  return '99K'
}

/** 格子底色强度档(镜像 host 侧 activityLevel)。 */
function activityLevel(value: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0
  if (value < 3) return 1
  if (value < 10) return 2
  if (value < 100) return 3
  return 4
}

/** 组合键(与 host 侧 activityKey 同规则)。 */
function keyOf(type: string, domain: string): string {
  return `${type}/${domain}`
}

/** 本地时刻 `HH`(刻度行)。 */
function hourOf(epochMs: number): string {
  return String(new Date(epochMs).getHours()).padStart(2, '0')
}

/** 桶时间窗 `MM-DD HH:mm–HH:mm`(tooltip)。 */
function windowLabel(start: number, bucketMinutes: number): string {
  const begin = new Date(start)
  const end = new Date(start + bucketMinutes * 60_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(begin.getMonth() + 1)}-${p(begin.getDate())} ${p(begin.getHours())}:${p(begin.getMinutes())}–${p(end.getHours())}:${p(end.getMinutes())}`
}

/** 桶宽文案:整小时显示 `N 小时`,否则 `N 分钟`(标题与 meta 行)。 */
function bucketLabel(bucketMinutes: number): string {
  return bucketMinutes % 60 === 0 ? `${bucketMinutes / 60} 小时` : `${bucketMinutes} 分钟`
}

/** 记忆活动大表:42 行 × 桶数列,固定格宽横向滚动,sticky 标签列,小时刻度行(刻度跨距由 DTO 桶宽派生)。 */
export function ActivityTable({ activity }: { readonly activity: NonNullable<Dashboard['activity']> }): JSX.Element {
  const { buckets, bucketMinutes } = activity
  const rows = DISPLAY.types.flatMap(type => DISPLAY.domains.map(domain => ({ type, domain })))
  // 刻度跨距:每小时一 tick;桶宽不足 1 小时时多桶共用一个 tick(向下兼容旧 DTO)。
  const cellsPerTick = Math.max(1, Math.round(60 / bucketMinutes))
  const tickCount = Math.ceil(buckets.length / cellsPerTick)
  return (
    <section className="card">
      <span className="section-title">记忆活动 (近 24 小时,每 {bucketLabel(bucketMinutes)}一格)</span>
      <div className="activity-wrap">
        <table className="activity-table">
          <thead>
            <tr>
              <th className="activity-label" />
              {Array.from({ length: tickCount }, (_, i) => (
                <th key={i} className="activity-tick" colSpan={cellsPerTick}>
                  {hourOf(buckets[i * cellsPerTick]!.start)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ type, domain }) => (
              <tr key={keyOf(type, domain)}>
                <th className="activity-label mono" title={`${type} · ${domain}`}>
                  {type === 'rules' ? 'r' : 'l'}/{domain}
                </th>
                {buckets.map(bucket => {
                  const value = bucket.counts[keyOf(type, domain)] ?? 0
                  return (
                    <td
                      key={bucket.start}
                      className={`activity-cell level-${activityLevel(value)}`}
                      title={value > 0 ? `${windowLabel(bucket.start, bucketMinutes)} ${type}/${domain} × ${value}` : undefined}
                    >
                      {value > 0 ? formatActivityCount(value) : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta">格子 = 该 {bucketLabel(bucketMinutes)}窗口内新写入的记忆条目数;≤999 原值,以上按量级封顶显示(99K/M/G/B/T),精确值悬停查看。按条目 createdAt 实时聚合,不落盘。</p>
    </section>
  )
}

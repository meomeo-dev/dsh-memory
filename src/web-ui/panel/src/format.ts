/** 面板共享的格式化纯函数(时间 / 数字 / 字节)。 */

/** 渲染本地时间 `YYYY-MM-DD HH:mm:ss`。 */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 本地日期 `YYYY-MM-DD`(Timeline 分组键等)。 */
export function dateKey(epochMs: number): string {
  return formatTime(epochMs).slice(0, 10)
}

/** 大数紧凑化:>=1M → `1.2M`,>=1k → `3.4k`,否则千分位。 */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString()
}

/** 字节数人类化(Kb / Mb,与 host 侧 renderBytes 同口径)。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kb`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mb`
}

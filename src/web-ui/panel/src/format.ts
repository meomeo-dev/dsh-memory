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

/** 相对时间(`3s ago` / `5m ago` / `2h ago` / `3d ago`;节点页活状态用)。 */
export function formatAgo(epochMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** 运行时长(节点页「运行中 · Xs」;<1s 显示 `<1s`)。 */
export function formatElapsed(epochMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000))
  return seconds < 1 ? '<1s' : `${seconds}s`
}

/** 耗时(`812ms` / `3.4s`;节点页最近一次调用用)。 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

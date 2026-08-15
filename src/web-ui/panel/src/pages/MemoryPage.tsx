/**
 * 记忆页:顶部筛选组件 + Timeline/Table 布局切换。
 * 样式在 ./memory.css;条目渲染只走 React 文本节点(无 innerHTML)。
 */
import { useEffect, useMemo, useState } from 'react'
import { DISPLAY, rpc } from '../api'
import type { Bootstrap, EntryRow, Filters } from '../api'
import { dateKey, formatTime } from '../format'
import './memory.css'

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
export function MemoryPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
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

/**
 * 面板根组件:读 bootstrap,按 page 渲染记忆页或设置页。
 * 渲染只走 React 文本节点(无 dangerouslySetInnerHTML),记忆内容不会进入 HTML
 * 执行路径;样式令牌镜像 dsh 设计系统(见 styles.css)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DISPLAY, readBootstrap, rpc } from './api'
import type { Bootstrap, ConfigItem, EntryRow, Filters } from './api'

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

/** 页面导航(两页互链,恒带 ac_token)。 */
function Nav({ page, token }: { readonly page: 'memory' | 'settings'; readonly token: string }): JSX.Element {
  const target = (next: 'memory' | 'settings') => next === page
    ? undefined
    : `${next === 'memory' ? '/memory' : '/memory/settings'}?ac_token=${encodeURIComponent(token)}`
  return (
    <nav className="tabs">
      {(['memory', 'settings'] as const).map(next => (
        <span key={next}>
          {target(next) === undefined
            ? <span className="tab active">{next === 'memory' ? '记忆 (Memory)' : '设置 (Settings)'}</span>
            : <a className="tab" href={target(next)}>{next === 'memory' ? '记忆 (Memory)' : '设置 (Settings)'}</a>}
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
        : <SettingsPage bootstrap={bootstrap} />}
    </div>
  )
}

/**
 * 设置页:13 个配置键的表单,统一保存(config-set)。样式在 ./settings.css。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { rpc } from '../api'
import type { Bootstrap, ConfigItem } from '../api'
import './settings.css'

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
export function SettingsPage({ bootstrap }: { readonly bootstrap: Bootstrap }): JSX.Element {
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

/**
 * 面板根组件:读 bootstrap,渲染页头导航 + 当前页。
 * 渲染只走 React 文本节点(无 dangerouslySetInnerHTML),记忆内容不会进入 HTML
 * 执行路径;样式令牌镜像 dsh 设计系统(见 styles.css)。
 * 各页面组件在 pages/ 各自成模块,图表组件在 charts.tsx,格式化在 format.ts。
 */
import { useState } from 'react'
import { readBootstrap } from './api'
import type { Bootstrap } from './api'
import { CollectionsPage } from './pages/CollectionsPage'
import { GlobalPage } from './pages/GlobalPage'
import { MemoryPage } from './pages/MemoryPage'
import { NodesPage } from './pages/NodesPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatusPage } from './pages/StatusPage'

/** 面板页面(导航 tab 的恒等集合)。 */
const PAGES = ['memory', 'status', 'collections', 'nodes', 'settings', 'global'] as const

const PAGE_LABELS: Readonly<Record<(typeof PAGES)[number], string>> = {
  memory: '记忆 (Memory)',
  status: '状态 (Status)',
  collections: '目录 (Collections)',
  nodes: '节点 (Nodes)',
  settings: '设置 (Settings)',
  global: 'Global',
}

const PAGE_PATHS: Readonly<Record<(typeof PAGES)[number], string>> = {
  memory: '/memory',
  status: '/memory/status',
  collections: '/memory/collections',
  nodes: '/memory/nodes',
  settings: '/memory/settings',
  global: '/memory/global',
}

/** 页面导航(六页互链,恒带 ac_token)。 */
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

/** 根组件:bootstrap → 页头(导航)→ 当前页组件。 */
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
          : bootstrap.page === 'collections'
            ? <CollectionsPage bootstrap={bootstrap} />
            : bootstrap.page === 'nodes'
              ? <NodesPage bootstrap={bootstrap} />
              : bootstrap.page === 'global'
                ? <GlobalPage bootstrap={bootstrap} />
                : <SettingsPage bootstrap={bootstrap} />}
    </div>
  )
}

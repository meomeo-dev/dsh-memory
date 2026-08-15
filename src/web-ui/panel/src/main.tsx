/**
 * 面板入口:挂 React 应用到 HTML 壳的 #root。
 */
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const rootElement = document.getElementById('root')
if (rootElement !== null) {
  createRoot(rootElement).render(<App />)
}

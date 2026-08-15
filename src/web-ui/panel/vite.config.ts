/**
 * 面板自包含构建:React 打进单文件,产物只含 panel.js + style.css。
 * 产物落到包根 panel/dist(与 package.json 的 files 字段一致),由 host 侧
 * renderPanelShell 的 HTML 壳经 /memory-assets/ 引用;零外部依赖、零 CDN。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: {
    // 相对 root(src/web-ui/panel)上溯三级到包根,再落 panel/dist。
    outDir: '../../../panel/dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/main.tsx',
      // Vite 5 的 lib 模式以 `name` 命名 CSS 产物(style.css);JS 名由 fileName 钉死。
      name: 'style',
      formats: ['es'],
      fileName: () => 'panel.js',
    },
    rollupOptions: {
      // React 打进 bundle:面板零外部依赖。
      external: [],
    },
  },
})

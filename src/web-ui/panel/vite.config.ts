/**
 * 面板自包含构建:React 打进单文件,产物只含 panel.js + style.css。
 * 产物落到包根 panel/dist(与 package.json 的 files 字段一致),由 host 侧
 * renderPanelShell 的 HTML 壳经 /memory-assets/ 引用;零外部依赖、零 CDN。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 门禁:浏览器 bundle 里任何残留的 `process.env` 都会在运行时抛
 * ReferenceError(React CJS 产物曾因此整页空白)。Vite 5 不再默认替换依赖里的
 * process.env.NODE_ENV,故显式 define;本插件在产物落盘前断言替换已生效。
 */
const assertNoProcessEnv = (): Plugin => ({
  name: 'assert-no-process-env',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'chunk') continue
      if (output.code.includes('process.env')) {
        throw new Error('panel bundle contains unreplaced process.env — browser bundle would crash at load')
      }
    }
  },
})

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react(), assertNoProcessEnv()],
  define: {
    // React 走 CJS 产物(包 main 是 CJS);Vite 5 对依赖不做默认替换,须显式 define,
    // 否则 process.env.NODE_ENV 原样进 bundle,浏览器读 process 直接 ReferenceError。
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
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

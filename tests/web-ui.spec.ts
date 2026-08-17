import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASSET_PREFIX,
  PANEL_CHANNEL,
  assetContentType,
  describeConfig,
  generatePanelToken,
  handlePanelRpc,
  matchesPanelQuery,
  panelPath,
  panelUrl,
  queryToken,
  readPanelAsset,
  renderPanelShell,
  resolvePanelAsset,
  safeTokenEqual,
} from '../src/web-ui/ui.js'
import type { PanelDeps } from '../src/web-ui/ui.js'
import { CONFIG_KEYS, DEFAULT_CONFIG } from '../src/memory-runtime.js'
import type { MemoryEntry } from '../src/schema.js'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm-0000000000',
    schemaVersion: 2,
    createdAt: 1750000000000,
    type: 'rules',
    domain: 'DurablePrefs',
    scope: '全项目',
    layer: 'user',
    entry: '提交信息用 Conventional Commits',
    entryPoint: '-',
    references: '-',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PanelDeps> = {}): PanelDeps {
  const emptyView = { roots: [], summary: { roots: 0, totalEntries: 0, totalFiles: 0 } }
  return {
    entries: () => [],
    roots: () => emptyView,
    addRoot: () => emptyView,
    forgetRoot: () => emptyView,
    exportRoots: () => ({ dir: '/out/x', totalEntries: 0, rootsExported: 0 }),
    nodes: () => [],
    getConfig: () => describeConfig(DEFAULT_CONFIG),
    setConfig: async () => describeConfig(DEFAULT_CONFIG),
    globalEntries: () => [],
    globalExtract: async () => [],
    globalExtractConfirm: () => ({ wrote: 0, skipped: 0 }),
    globalPromotePlan: () => ({ sourceEntries: 0, nodeCount: 0 }),
    globalPromote: async () => ({ wrote: 0, skipped: 0 }),
    globalReview: async () => ({ findings: 0, report: '' }),
    globalExport: () => '{}',
    globalImport: () => ({ ok: true, imported: 0, duplicates: 0, skipped: [], errors: [] }),
    ...overrides,
  }
}

let panelDir: string

beforeEach(() => {
  panelDir = mkdtempSync(join(tmpdir(), 'dsh-memory-panel-'))
  mkdirSync(panelDir, { recursive: true })
  writeFileSync(join(panelDir, 'panel.js'), 'console.log("panel")', 'utf8')
})

afterEach(() => {
  rmSync(panelDir, { recursive: true, force: true })
})

describe('panel token', () => {
  it('generates a 64-char hex token, unique per call', () => {
    const token = generatePanelToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(generatePanelToken()).not.toBe(token)
  })

  it('compares tokens in constant time, including length mismatch', () => {
    const token = generatePanelToken()
    expect(safeTokenEqual(token, token)).toBe(true)
    expect(safeTokenEqual(token, generatePanelToken())).toBe(false)
    expect(safeTokenEqual('short', token)).toBe(false)
    expect(safeTokenEqual(token, 'short')).toBe(false)
    expect(safeTokenEqual('', '')).toBe(true)
  })

  it('extracts ac_token from request URLs', () => {
    expect(queryToken('/memory?ac_token=abc123')).toBe('abc123')
    expect(queryToken('/memory?ac_token=abc123&x=1')).toBe('abc123')
    expect(queryToken('/memory')).toBeUndefined()
    expect(queryToken(undefined)).toBeUndefined()
  })
})

describe('panel URLs', () => {
  it('builds page paths and token-bearing URLs', () => {
    expect(panelPath('memory')).toBe('/memory')
    expect(panelPath('status')).toBe('/memory/status')
    expect(panelPath('collections')).toBe('/memory/collections')
    expect(panelPath('nodes')).toBe('/memory/nodes')
    expect(panelPath('settings')).toBe('/memory/settings')
    expect(panelPath('global')).toBe('/memory/global')
    expect(panelUrl(39140, 'memory', 'tok')).toBe('http://127.0.0.1:39140/memory?ac_token=tok')
    expect(panelUrl(39140, 'status', 'tok')).toBe('http://127.0.0.1:39140/memory/status?ac_token=tok')
    expect(panelUrl(39140, 'collections', 'tok')).toBe('http://127.0.0.1:39140/memory/collections?ac_token=tok')
    expect(panelUrl(39140, 'nodes', 'tok')).toBe('http://127.0.0.1:39140/memory/nodes?ac_token=tok')
    expect(panelUrl(39140, 'settings', 'tok')).toBe('http://127.0.0.1:39140/memory/settings?ac_token=tok')
    expect(panelUrl(39140, 'global', 'tok')).toBe('http://127.0.0.1:39140/memory/global?ac_token=tok')
  })
})

describe('asset serving', () => {
  it('resolves a whitelisted single-segment asset inside the panel dir', () => {
    const file = resolvePanelAsset(panelDir, `${ASSET_PREFIX}panel.js`)
    expect(file).toBe(join(panelDir, 'panel.js'))
    expect(readPanelAsset(panelDir, `${ASSET_PREFIX}panel.js`)?.toString('utf8')).toBe('console.log("panel")')
  })

  it('rejects path traversal, absolute paths, and unknown extensions', () => {
    // '..' 段(含编码穿越解码后的形式)、分隔符、反斜杠一律拒绝。
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}../secret.txt`)).toBeUndefined()
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}..%2F..%2Fetc%2Fpasswd`)).toBeUndefined()
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}a/b.js`)).toBeUndefined()
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}a\\b.js`)).toBeUndefined()
    expect(resolvePanelAsset(panelDir, '/etc/passwd')).toBeUndefined()
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}secret.exe`)).toBeUndefined()
    expect(resolvePanelAsset(panelDir, `${ASSET_PREFIX}`)).toBeUndefined()
  })

  it('maps extensions to content types', () => {
    expect(assetContentType('panel.js')).toContain('javascript')
    expect(assetContentType('style.css')).toContain('css')
    expect(assetContentType('panel.js.map')).toContain('json')
    expect(assetContentType('icon.svg')).toContain('svg')
    expect(assetContentType('icon.png')).toBe('image/png')
    expect(assetContentType('font.woff2')).toBe('font/woff2')
    expect(assetContentType('x.bin')).toBe('application/octet-stream')
  })
})

describe('panel HTML shell', () => {
  it('emits a CSP-tightened shell with the bootstrap JSON and token-bearing asset URLs', () => {
    const html = renderPanelShell({ page: 'memory', token: 'tok-64', channel: PANEL_CHANNEL })
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('id="dsh-memory-bootstrap"')
    expect(html).toContain('?ac_token=tok-64')
    expect(html).toContain('<div id="root"></div>')
    const match = /<script id="dsh-memory-bootstrap" type="application\/json">([^<]*)<\/script>/.exec(html)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!)).toEqual({ page: 'memory', token: 'tok-64', channel: '/memory-api' })
  })

  it('escapes `<` in the bootstrap JSON so content cannot break the script boundary', () => {
    const html = renderPanelShell({ page: 'memory', token: '<evil>', channel: PANEL_CHANNEL })
    expect(html).not.toContain('"token":"<evil>"')
    // 只需转义 `<`(`</script` 终止符);`>` 不破坏 script 边界,保持原样。
    expect(html).toContain('\\u003cevil>')
  })
})

describe('settings page description', () => {
  it('describes exactly the 14 config keys with a label, description, and control kind', () => {
    const items = describeConfig(DEFAULT_CONFIG)
    expect(items.map(item => item.key)).toEqual([...CONFIG_KEYS])
    for (const item of items) {
      expect(item.meta.label).toBeTruthy()
      expect(item.meta.description).toBeTruthy()
      expect(['number', 'boolean', 'enum', 'string', 'textarea']).toContain(item.meta.kind)
      if (item.meta.kind === 'enum') expect(item.meta.options).toBeDefined()
    }
  })
})

describe('matchesPanelQuery', () => {
  it('matches entry, scope, and domain case-insensitively', () => {
    expect(matchesPanelQuery(entry(), 'conventional')).toBe(true)
    expect(matchesPanelQuery(entry(), '全项目')).toBe(true)
    expect(matchesPanelQuery(entry(), 'durableprefs')).toBe(true)
    expect(matchesPanelQuery(entry(), '不存在的词')).toBe(false)
  })
})

describe('handlePanelRpc', () => {
  const token = generatePanelToken()

  it('rejects requests without a valid acToken before touching deps', async () => {
    const result = await handlePanelRpc('entries', {}, token, makeDeps())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('bad-request')
      expect(result.error.message).toContain('acToken')
    }
    const wrong = await handlePanelRpc('entries', { acToken: 'wrong' }, token, makeDeps())
    expect(wrong.ok).toBe(false)
  })

  it('rejects malformed payloads and unknown endpoints', async () => {
    const bad = await handlePanelRpc('entries', { acToken: token, filters: { type: 'state' } }, token, makeDeps())
    expect(bad.ok).toBe(false)
    const unknown = await handlePanelRpc('delete-everything', { acToken: token }, token, makeDeps())
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('bad-request')
  })

  it('serves entries with filters passed through to the deps (host view, no cwd)', async () => {
    let received: unknown
    const deps = makeDeps({
      entries: (filters) => {
        received = filters
        return [{ entry: entry(), file: '/root/lmemory/2026-08-13.rules.remember.jsonl' }]
      },
    })
    const result = await handlePanelRpc('entries', {
      acToken: token,
      filters: { type: 'rules', domain: 'DurablePrefs', layer: 'user', query: '提交' },
    }, token, deps)
    expect(result.ok).toBe(true)
    expect(received).toEqual({ type: 'rules', domain: 'DurablePrefs', layer: 'user', query: '提交' })
    if (result.ok) {
      const value = result.value as { entries: Array<{ entry: MemoryEntry; file: string }> }
      expect(value.entries[0]!.file).toBe('/root/lmemory/2026-08-13.rules.remember.jsonl')
      expect(value.entries[0]!.entry.createdAt).toBe(1750000000000)
    }
    // 空 filters 载荷 → 空对象透传(host 视图由注入实现决定数据源)。
    const bare = await handlePanelRpc('entries', { acToken: token }, token, deps)
    expect(bare.ok).toBe(true)
    expect(received).toEqual({})
  })

  it('reads and writes config through the deps', async () => {
    const get = await handlePanelRpc('config-get', { acToken: token }, token, makeDeps())
    expect(get.ok).toBe(true)
    if (get.ok) expect((get.value as { config: unknown[] }).config).toHaveLength(14)

    let patchSeen: Record<string, unknown> | undefined
    const setDeps = makeDeps({
      setConfig: async (patch) => {
        patchSeen = patch
        return describeConfig(DEFAULT_CONFIG)
      },
    })
    const set = await handlePanelRpc('config-set', { acToken: token, patch: { maxNodeKb: 800 } }, token, setDeps)
    expect(set.ok).toBe(true)
    expect(patchSeen).toEqual({ maxNodeKb: 800 })
  })

  it('serves the dashboard view model through the deps', async () => {
    let called = false
    const deps = makeDeps({
      dashboard: () => {
        called = true
        return {
          status: { maxNodeKb: 600, teams: [{ root: '/proj', nodes: 3 }] },
          stats: {
            total: 2, rules: 1, lessons: 1,
            layers: { global: 0, user: 1, project: 1 },
            domains: [{ domain: 'Style', count: 2 }],
            files: 1, jsonlBytes: 100, mdBytes: 200, catalogEntries: 2,
          },
          usage: {
            warmTeams: { nodes: 3, chars: 1200, tokens: 300 },
            summary: { chars: 400, tokens: 100 },
            totals: [{ label: 'recall', calls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 25 }],
            daily: [{ day: '2026-08-14', recall: { calls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 }, extract: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, review: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }, total: 17 }],
          },
        }
      },
    })
    const result = await handlePanelRpc('dashboard-get', { acToken: token }, token, deps)
    expect(result.ok).toBe(true)
    expect(called).toBe(true)
    if (result.ok) {
      const value = result.value as { dashboard: { status: { teams: unknown[] }; stats: { total: number }; usage: { totals: unknown[]; daily: unknown[] } } }
      expect(value.dashboard.status.teams).toHaveLength(1)
      expect(value.dashboard.stats.total).toBe(2)
      expect(value.dashboard.usage.totals).toHaveLength(1)
      expect(value.dashboard.usage.daily).toHaveLength(1)
    }
  })

  it('folds dependency failures into an internal error', async () => {
    const deps = makeDeps({ entries: () => { throw new Error('disk gone') } })
    const result = await handlePanelRpc('entries', { acToken: token }, token, deps)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('internal')
      expect(result.error.message).toBe('disk gone')
    }
  })

  it('serves the collections endpoints (roots-get / root-add / root-forget / root-export)', async () => {
    const view = {
      roots: [{ root: '/a', kind: 'project', firstSeenAt: 1, lastSeenAt: 2, entries: 3, files: 1, exists: true, filesDetail: [{ file: 'x.remember.jsonl', entries: 3 }] }],
      summary: { roots: 1, totalEntries: 3, totalFiles: 1 },
    }
    const calls: string[] = []
    const deps = makeDeps({
      roots: () => { calls.push('roots'); return view },
      addRoot: (root) => { calls.push(`add:${root}`); return view },
      forgetRoot: (root) => { calls.push(`forget:${root}`); return view },
      exportRoots: (root) => { calls.push(`export:${root ?? '*'}`); return { dir: '/out/x', totalEntries: 3, rootsExported: 1 } },
    })

    const get = await handlePanelRpc('roots-get', { acToken: token }, token, deps)
    expect(get.ok).toBe(true)
    if (get.ok) expect((get.value as { roots: typeof view }).roots.summary.totalEntries).toBe(3)
    expect(calls).toEqual(['roots'])

    const add = await handlePanelRpc('root-add', { acToken: token, root: '/a' }, token, deps)
    expect(add.ok).toBe(true)
    expect(calls).toContain('add:/a')

    const forget = await handlePanelRpc('root-forget', { acToken: token, root: '/a' }, token, deps)
    expect(forget.ok).toBe(true)
    expect(calls).toContain('forget:/a')

    const exportAll = await handlePanelRpc('root-export', { acToken: token }, token, deps)
    expect(exportAll.ok).toBe(true)
    expect(calls).toContain('export:*')
    const exportOne = await handlePanelRpc('root-export', { acToken: token, root: '/a' }, token, deps)
    expect(exportOne.ok).toBe(true)
    expect(calls).toContain('export:/a')

    // 载荷校验:root 为空一律 bad-request;token 门同样生效。
    const badAdd = await handlePanelRpc('root-add', { acToken: token, root: '' }, token, deps)
    expect(badAdd.ok).toBe(false)
    const noToken = await handlePanelRpc('roots-get', {}, token, deps)
    expect(noToken.ok).toBe(false)
  })

  it('serves the nodes view model through the deps (nodes-get)', async () => {
    const row = {
      formatVersion: 1, pid: 100, startedAt: 1755234567890, cwd: '/proj', port: 3080, lastSeenAt: 1755234599999,
      teams: [{ root: '', nodes: 3, chars: 1200 }], summaryChars: 800,
      nodes: {
        recall: { running: 1, runningSince: 1755234598000, calls: 5, lastAt: 1755234597000, lastDurationMs: 812, lastOk: true },
        extract: { running: 0, calls: 2, lastAt: 1755234400000, lastDurationMs: 3400, lastOk: false, lastError: 'timeout' },
        review: { running: 0, calls: 0, lastAt: 0, lastDurationMs: 0, lastOk: true },
      },
    }
    const deps = makeDeps({ nodes: () => [row] })
    const result = await handlePanelRpc('nodes-get', { acToken: token }, token, deps)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const value = result.value as { processes: Array<{ pid: number; nodes: { recall: { running: number } } }> }
      expect(value.processes).toHaveLength(1)
      expect(value.processes[0]!.pid).toBe(100)
      expect(value.processes[0]!.nodes.recall.running).toBe(1)
    }
    // token 门:缺失/非法 token 一律 bad-request。
    const noToken = await handlePanelRpc('nodes-get', {}, token, deps)
    expect(noToken.ok).toBe(false)
    const badToken = await handlePanelRpc('nodes-get', { acToken: 'x'.repeat(64) }, token, deps)
    expect(badToken.ok).toBe(false)
  })
})

describe('global endpoints', () => {
  const token = generatePanelToken()
  const cand = {
    type: 'rules', domain: 'Style', scope: '全项目', entry: '两空格缩进是跨项目共识', verdict: 'pass',
  }

  it('serves global-entries and global-export through the deps', async () => {
    const deps = makeDeps({
      globalEntries: () => [{ entry: entry({ layer: 'global' }), file: '/root/lmemory/global/x.remember.jsonl' }],
      globalExport: () => '{"kind":"dsh-memory-global-export"}',
    })
    const list = await handlePanelRpc('global-entries', { acToken: token }, token, deps)
    expect(list.ok).toBe(true)
    if (list.ok) expect((list.value as { entries: Array<{ entry: { layer: string } }> }).entries[0]!.entry.layer).toBe('global')

    const exported = await handlePanelRpc('global-export', { acToken: token }, token, deps)
    expect(exported.ok).toBe(true)
    if (exported.ok) expect((exported.value as { export: string }).export).toContain('dsh-memory-global-export')
  })

  it('extract stage 1 returns candidates; stage 2 forwards confirm + candidates to the confirm deps', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      globalExtract: async (text) => { calls.push(`extract:${text}`); return [cand as never] },
      globalExtractConfirm: (candidates) => { calls.push(`confirm:${candidates.length}`); return { wrote: 1, skipped: 0 } },
    })
    const preview = await handlePanelRpc('global-extract', { acToken: token, text: '文档' }, token, deps)
    expect(preview.ok).toBe(true)
    if (preview.ok) expect((preview.value as { candidates: unknown[] }).candidates).toHaveLength(1)
    expect(calls).toEqual(['extract:文档'])

    const confirmed = await handlePanelRpc('global-extract', { acToken: token, text: '文档', confirm: true, candidates: [cand] }, token, deps)
    expect(confirmed.ok).toBe(true)
    if (confirmed.ok) expect(confirmed.value).toEqual({ wrote: 1, skipped: 0 })
    expect(calls).toEqual(['extract:文档', 'confirm:1'])

    // confirm 不带 candidates → bad-request(载荷校验,不触碰 deps)。
    const missing = await handlePanelRpc('global-extract', { acToken: token, text: '文档', confirm: true }, token, deps)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('bad-request')
  })

  it('rejects documents over 1 MiB at the RPC layer before touching deps', async () => {
    let touched = false
    const deps = makeDeps({
      globalExtract: async () => { touched = true; return [] },
      globalImport: () => { touched = true; return { ok: true, imported: 0, duplicates: 0, skipped: [], errors: [] } },
    })
    const big = 'x'.repeat(1024 * 1024 + 1)
    const extract = await handlePanelRpc('global-extract', { acToken: token, text: big }, token, deps)
    expect(extract.ok).toBe(false)
    if (!extract.ok) expect(extract.error.message).toContain('1 MiB')
    const importBig = await handlePanelRpc('global-import', { acToken: token, text: big }, token, deps)
    expect(importBig.ok).toBe(false)
    if (!importBig.ok) expect(importBig.error.message).toContain('1 MiB')
    expect(touched).toBe(false)
  })

  it('promote plan is served without confirm; confirm executes through the deps', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      globalPromotePlan: () => { calls.push('plan'); return { sourceEntries: 3, nodeCount: 1, costYuan: 0.01 } },
      globalPromote: async () => { calls.push('run'); return { wrote: 2, skipped: 1 } },
    })
    const plan = await handlePanelRpc('global-promote', { acToken: token }, token, deps)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect((plan.value as { plan: { nodeCount: number } }).plan.nodeCount).toBe(1)
    const run = await handlePanelRpc('global-promote', { acToken: token, confirm: true }, token, deps)
    expect(run.ok).toBe(true)
    if (run.ok) expect(run.value).toEqual({ wrote: 2, skipped: 1 })
    expect(calls).toEqual(['plan', 'run'])
  })

  it('global-review and global-import pass through the deps', async () => {
    const deps = makeDeps({
      globalReview: async () => ({ findings: 2, report: '缺陷报告' }),
      globalImport: () => ({ ok: false, reason: '不是真实的 global 导出' }),
    })
    const review = await handlePanelRpc('global-review', { acToken: token }, token, deps)
    expect(review.ok).toBe(true)
    if (review.ok) expect((review.value as { findings: number }).findings).toBe(2)
    const imported = await handlePanelRpc('global-import', { acToken: token, text: '{}' }, token, deps)
    expect(imported.ok).toBe(true)
    if (imported.ok) expect(imported.value).toEqual({ ok: false, reason: '不是真实的 global 导出' })
  })
})

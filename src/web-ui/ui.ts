/**
 * 记忆 Web 面板(路径 B 独立页)的纯逻辑:token、页面路由、RPC 通道。
 *
 * 面板 = host 侧两个 GET 路由(`/memory` 记忆页、`/memory/settings` 设置页,
 * 均须 `?ac_token=`)+ 一个静态资源前缀(`/memory-assets/`)+ 一个只读为主的
 * RPC channel(`/memory-api`,经 connection.handle 注册,authority: 'loopback',
 * 每个请求自动过 dsh 信任栅栏)。本模块不 import cordis:token 生成/比较、URL
 * 构造、HTML 壳渲染、资源路径防穿越、RPC 载荷校验与分发都是纯函数;路由与
 * channel 的注册编排在 index.ts。
 *
 * 安全模型(三层):
 *   1. token 门:`ac_token` 每次进程启动重新生成,GET 页面 / 静态资源 / RPC
 *      载荷三层都校验(常量时间比较)。防 DNS rebinding 下的导航读取与同机
 *      其他进程越权。
 *   2. 信任栅栏:RPC channel 由 dsh 的 connection.handle 注册,浏览器请求过
 *      同源检查,非浏览器客户端必须来自 loopback。
 *   3. XSS:CSP `default-src 'none'` + React textContent 渲染,记忆内容永不进
 *      innerHTML 路径。
 *
 * @module dsh-memory/ui
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { DOMAINS, LAYERS, MEMORY_TYPES } from '../schema.js'
import type { DomainId, LayerId, MemoryEntry, MemoryType } from '../schema.js'
import { CONFIG_KEYS, EXTRACT_MODES } from '../memory-runtime.js'
import type { ConfigKey, MemoryConfig, TeamStatus } from '../memory-runtime.js'
import type { MemoryStats, UsageCounter } from '../stats.js'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

// ---- token ----

/** 面板 token 的随机字节数(32 字节 → 64 hex 字符)。 */
const TOKEN_BYTES = 32

/**
 * 生成一次进程生命周期的面板访问 token(crypto 随机)。
 * @returns 64 位十六进制字符串。
 */
export function generatePanelToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * 常量时间比较两个 token(先比长度,避免时序侧信道泄露前缀)。
 * @param provided - 请求方提供的 token。
 * @param expected - 服务端持有的 token。
 * @returns 完全一致时为真。
 */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 从请求 URL 提取 `ac_token` 查询参数。
 * @param rawUrl - `req.url`(可能带其他参数)。
 * @returns token 值;缺失或 URL 非法时返回 undefined。
 */
export function queryToken(rawUrl: string | undefined): string | undefined {
  try {
    const value = new URL(rawUrl ?? '/', 'http://x').searchParams.get('ac_token')
    return value ?? undefined
  } catch {
    return undefined
  }
}

// ---- 页面与 URL ----

/** 面板页面。 */
export type PanelPage = 'memory' | 'status' | 'settings'

/** 面板页面的路由路径(无尾斜杠)。 */
export function panelPath(page: PanelPage): string {
  if (page === 'memory') return '/memory'
  if (page === 'status') return '/memory/status'
  return '/memory/settings'
}

/**
 * 构造带 `ac_token` 的面板 URL(仅 loopback 地址)。
 * @param port - webServer 监听端口。
 * @param page - 页面。
 * @param token - 面板访问 token。
 * @returns 可点开的完整 URL。
 */
export function panelUrl(port: number, page: PanelPage, token: string): string {
  return `http://127.0.0.1:${port}${panelPath(page)}?ac_token=${token}`
}

// ---- 静态资源 ----

/** 面板静态资源的路径前缀。 */
export const ASSET_PREFIX = '/memory-assets/'

/** 允许直发的资源后缀白名单。 */
const ASSET_EXTENSIONS = new Set(['.js', '.css', '.map', '.svg', '.png', '.woff2'])

/**
 * 把 `/memory-assets/<file>` 解析为 panel 目录内的绝对文件路径。
 * 只接受单段文件名与白名单后缀,拒绝路径穿越(`..`、分隔符、绝对路径)。
 * @param panelDir - panel 构建产物目录(绝对路径)。
 * @param pathname - 请求路径。
 * @returns 目录内文件的绝对路径;非法时返回 undefined。
 */
export function resolvePanelAsset(panelDir: string, pathname: string): string | undefined {
  if (!pathname.startsWith(ASSET_PREFIX)) return undefined
  const rest = pathname.slice(ASSET_PREFIX.length)
  if (rest.length === 0 || rest.includes('/') || rest.includes('\\') || rest.includes('..')) return undefined
  if (!ASSET_EXTENSIONS.has(extname(rest).toLowerCase())) return undefined
  const file = resolve(panelDir, rest)
  return file.startsWith(resolve(panelDir) + sep) ? file : undefined
}

/** 资源后缀 → HTTP content-type。 */
export function assetContentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.map': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

/**
 * 读一个 panel 目录内的静态资源(经 {@link resolvePanelAsset} 防穿越)。
 * @param panelDir - panel 构建产物目录。
 * @param pathname - 请求路径。
 * @returns 文件内容;路径非法或文件不存在时返回 undefined。
 */
export function readPanelAsset(panelDir: string, pathname: string): Buffer | undefined {
  const file = resolvePanelAsset(panelDir, pathname)
  if (file === undefined) return undefined
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

// ---- HTML 壳 ----

/** 面板引导数据(注入 HTML 的 JSON bootstrap)。 */
export interface PanelBootstrap {
  /** 当前页面。 */
  readonly page: PanelPage
  /** 面板访问 token(React 应用用它调 RPC)。 */
  readonly token: string
  /** RPC channel 前缀(与 connection.handle 注册一致)。 */
  readonly channel: string
}

/** 序列化 bootstrap JSON;转义 `<` 防止内容破坏 script 边界。 */
function bootstrapJson(bootstrap: PanelBootstrap): string {
  return JSON.stringify(bootstrap).replace(/</g, '\\u003c')
}

/**
 * 渲染面板 HTML 壳:自包含,零外部 CDN。CSP 收紧到
 * `default-src 'none'` + 本源的 script/style/img/font/connect;
 * React 应用由 `/memory-assets/panel.js` 挂载到 `#root`。
 * @param bootstrap - 引导数据(page / token / channel)。
 * @returns 完整 HTML 文本。
 */
export function renderPanelShell(bootstrap: PanelBootstrap): string {
  const tokenQuery = `?ac_token=${encodeURIComponent(bootstrap.token)}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'">
<title>dsh-memory panel</title>
<link rel="stylesheet" href="${ASSET_PREFIX}style.css${tokenQuery}">
</head>
<body>
<div id="root"></div>
<script id="dsh-memory-bootstrap" type="application/json">${bootstrapJson(bootstrap)}</script>
<script type="module" src="${ASSET_PREFIX}panel.js${tokenQuery}"></script>
</body>
</html>`
}

/**
 * panel 构建产物的候选目录(编译后 lib 运行与源码运行的相对位置不同):
 * lib 运行 = <pkg>/lib/src/web-ui/ui.js → 上溯 3 级到包根;源码运行 =
 * <pkg>/src/web-ui/ui.ts → 上溯 2 级。产物恒在包根 panel/dist(与 npm files 一致)。
 */
const PANEL_DIST_CANDIDATES = [
  new URL('../../../panel/dist/', import.meta.url),
  new URL('../../panel/dist/', import.meta.url),
]

/**
 * 定位 panel 构建产物目录:首个含 `panel.js` 的候选。
 * @returns 目录绝对路径;两个候选都不存在时返回 undefined(面板不可用)。
 */
export function findPanelDist(): string | undefined {
  for (const candidate of PANEL_DIST_CANDIDATES) {
    const dir = fileURLToPath(candidate)
    if (existsSync(resolve(dir, 'panel.js'))) return dir
  }
  return undefined
}

// ---- RPC ----

/** 面板 RPC channel 名(与 index.ts 的 connection.handle 注册一致)。 */
export const PANEL_CHANNEL = '/memory-api'

/** 面板全文模糊匹配:大小写不敏感,覆盖 entry / scope / domain。 */
export function matchesPanelQuery(entry: MemoryEntry, query: string): boolean {
  const needle = query.toLowerCase()
  return entry.entry.toLowerCase().includes(needle)
    || entry.scope.toLowerCase().includes(needle)
    || entry.domain.toLowerCase().includes(needle)
}

/** `entries` 请求的过滤条件(全部可选)。 */
export interface PanelFilters {
  /** 按类型过滤。 */
  readonly type?: MemoryType
  /** 按领域过滤。 */
  readonly domain?: DomainId
  /** 按落点层过滤。 */
  readonly layer?: LayerId
  /** 全文模糊匹配(entry / scope / domain)。 */
  readonly query?: string
}

/** 面板里的一条记忆行(完整条目 + 所在文件)。 */
export interface PanelEntryRow {
  /** 完整记忆条目(含 createdAt,Timeline 用)。 */
  readonly entry: MemoryEntry
  /** 相对 `memory/` 目录的 `.remember.jsonl` 路径。 */
  readonly file: string
}

/** 设置页展示元数据(标签 / 说明 / 控件类型)。 */
export interface PanelConfigMeta {
  /** 展示标签。 */
  readonly label: string
  /** 一句话说明。 */
  readonly description: string
  /** 设置页控件类型。 */
  readonly kind: 'number' | 'boolean' | 'enum' | 'string' | 'textarea'
  /** enum 类型的可选项。 */
  readonly options?: readonly string[]
}

/** 13 个配置键的设置页元数据(键集合与 {@link CONFIG_KEYS} 一致,测试锁定不漂移)。 */
export const PANEL_CONFIG_META: Readonly<Record<ConfigKey, PanelConfigMeta>> = {
  maxNodeKb: { label: 'maxNodeKb', description: '每节点容量上限(Kb)', kind: 'number' },
  recallTopK: { label: 'recallTopK', description: '召回返回的最大条目数', kind: 'number' },
  rerankPrompt: { label: 'rerankPrompt', description: '召回聚合阶段的重排序提示词', kind: 'textarea' },
  warmupOnStart: { label: 'warmupOnStart', description: '插件启动时是否自动预热记忆 team', kind: 'boolean' },
  provider: { label: 'provider', description: '召回模型调用所用 provider route', kind: 'string' },
  model: { label: 'model', description: '召回模型 id', kind: 'string' },
  reviewModel: { label: 'reviewModel', description: '质检(review)模式所用模型 id', kind: 'string' },
  autoExtract: { label: 'autoExtract', description: '是否启用自动提取(旁路观测主会话)', kind: 'boolean' },
  extractMode: { label: 'extractMode', description: '提取触发形态(signal / counter / event-counter)', kind: 'enum', options: EXTRACT_MODES },
  extractInterval: { label: 'extractInterval', description: '相邻两次抽取的最小 turn 间隔(退火冷却期)', kind: 'number' },
  signalWords: { label: 'signalWords', description: '形态 1(signal)信号词集,逗号分隔', kind: 'string' },
  extractRulesPrompt: { label: 'extractRulesPrompt', description: 'rules 抽取器提示词模板', kind: 'textarea' },
  extractLessonsPrompt: { label: 'extractLessonsPrompt', description: 'lessons 抽取器提示词模板', kind: 'textarea' },
}

/** 设置页的一个配置项(元数据 + 当前值)。 */
export interface PanelConfigItem {
  /** 配置键。 */
  readonly key: ConfigKey
  /** 展示元数据。 */
  readonly meta: PanelConfigMeta
  /** 当前值。 */
  readonly value: unknown
}

/** 把配置对象投影为设置页展示项(按 {@link CONFIG_KEYS} 顺序)。 */
export function describeConfig(config: MemoryConfig): PanelConfigItem[] {
  return CONFIG_KEYS.map(key => ({ key, meta: PANEL_CONFIG_META[key], value: config[key] }))
}

/** 状态页的 team 状态一行。 */
export interface DashboardTeamRow {
  /** 项目根路径;空串表示「无项目」(内置 + 用户层)。 */
  readonly root: string
  /** 已预热节点数。 */
  readonly nodes: number
}

/** 状态页的 LLM 调用消耗一行(按职责分类)。 */
export interface DashboardUsageRow {
  /** 职责分类(recall / extract / review)。 */
  readonly label: string
  /** 调用次数。 */
  readonly calls: number
  /** 累计输入 token。 */
  readonly inputTokens: number
  /** 累计输出 token。 */
  readonly outputTokens: number
  /** 累计缓存读 token。 */
  readonly cacheReadTokens: number
}

/** 状态页某一天某一职责的聚合(镜像 usage-log 的 LabelDayUsage)。 */
export interface DashboardLabelUsage {
  /** 当日调用次数。 */
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  /** 当日该职责 token 合计。 */
  readonly totalTokens: number
}

/** 状态页某一天的聚合(镜像 usage-log 的 DayUsage)。 */
export interface DashboardDaily {
  /** 本地日期 `YYYY-MM-DD`。 */
  readonly day: string
  readonly recall: DashboardLabelUsage
  readonly extract: DashboardLabelUsage
  readonly review: DashboardLabelUsage
  /** 当日全部 token 合计。 */
  readonly total: number
}

/** 状态页的完整视图模型(status / stats / usage 三区,一次 RPC 取齐)。 */
export interface DashboardDto {
  /** 顶部:记忆 team 状态。 */
  readonly status: {
    /** 每节点容量上限(Kb)。 */
    readonly maxNodeKb: number
    /** 各 root 的已预热 team。 */
    readonly teams: readonly DashboardTeamRow[]
  }
  /** 中部:记忆统计指标。 */
  readonly stats: {
    /** 总条目数。 */
    readonly total: number
    /** rules / lessons 条目数。 */
    readonly rules: number
    readonly lessons: number
    /** global / user / project 层条目数。 */
    readonly layers: { readonly global: number; readonly user: number; readonly project: number }
    /** 按 domain 的条目数(按数量降序,只含非零项)。 */
    readonly domains: readonly { readonly domain: string; readonly count: number }[]
    /** 记忆文件数。 */
    readonly files: number
    /** jsonl 总字节。 */
    readonly jsonlBytes: number
    /** md 总字节。 */
    readonly mdBytes: number
    /** catalog 条目总数。 */
    readonly catalogEntries: number
  }
  /** 正文:token 用量(静态上下文估算 + 动态 LLM 调用消耗 + 每日聚合)。 */
  readonly usage: {
    /** 预热 team 的静态上下文成本。 */
    readonly warmTeams: { readonly nodes: number; readonly chars: number; readonly tokens: number }
    /** system prompt 摘要的静态上下文成本。 */
    readonly summary: { readonly chars: number; readonly tokens: number }
    /** 本进程 LLM 调用消耗(按职责分类)。 */
    readonly counters: readonly DashboardUsageRow[]
    /** 近 84 天按日聚合(usage.jsonl,零填充,升序;柱状图取后 14 天,热力图用全部)。 */
    readonly daily: readonly DashboardDaily[]
  }
}

/** 面板 RPC 通道的注入依赖(纯接口,由 index.ts 闭包提供)。 */
export interface PanelDeps {
  /** 按过滤条件列出可见记忆(带所在文件);实现须按 createdAt 降序返回。 */
  entries(cwd: string | undefined, filters: PanelFilters): PanelEntryRow[]
  /** 状态页视图模型(status / stats / usage 一次取齐)。 */
  dashboard(cwd: string | undefined): DashboardDto
  /** 当前配置的设置页描述。 */
  getConfig(): PanelConfigItem[]
  /** 写入配置补丁(经 settings scope 校验与 applyConfig),返回写入后的描述。 */
  setConfig(patch: Record<string, unknown>): Promise<PanelConfigItem[]>
}

/** `entries` 请求载荷。 */
interface EntriesPayload {
  acToken: string
  cwd?: string
  filters?: {
    type?: MemoryType
    domain?: DomainId
    layer?: LayerId
    query?: string
  }
}

/** 只带 token 的请求载荷(config-get)。 */
interface TokenPayload {
  acToken: string
}

/** `dashboard-get` 请求载荷(可选 cwd,同 entries 的缺省回退)。 */
interface DashboardPayload {
  acToken: string
  cwd?: string
}

/** `config-set` 请求载荷。 */
interface ConfigSetPayload {
  acToken: string
  patch: Record<string, unknown>
}

const ENTRIES_PAYLOAD: z<EntriesPayload> = z.object({
  acToken: z.string().min(1).required(),
  cwd: z.string().min(1),
  filters: z.object({
    type: z.union([...MEMORY_TYPES]),
    domain: z.union([...DOMAINS]),
    layer: z.union([...LAYERS]),
    query: z.string().min(1),
  }),
})

const TOKEN_PAYLOAD: z<TokenPayload> = z.object({
  acToken: z.string().min(1).required(),
})

const DASHBOARD_PAYLOAD: z<DashboardPayload> = z.object({
  acToken: z.string().min(1).required(),
  cwd: z.string().min(1),
})

const CONFIG_SET_PAYLOAD: z<ConfigSetPayload> = z.object({
  acToken: z.string().min(1).required(),
  patch: z.object({}).required(),
})

/** 载荷解析结果。 */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** 用 schemastery 校验线协议载荷(不通过返回错误文本)。 */
function parsePayload<T>(schema: z<T>, payload: unknown): Parsed<T> {
  try {
    // schemastery 的调用签名不接受 unknown;线协议边界本身就是「不可信输入」,显式断言。
    return { ok: true, value: schema(payload as T | null | undefined) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 载荷携带的 acToken 是否与服务端持有的一致(常量时间比较)。 */
function authorized(payload: unknown, token: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const acToken = (payload as Record<string, unknown>).acToken
  return typeof acToken === 'string' && safeTokenEqual(acToken, token)
}

/** 构造 RPC 失败结果(只用 bad-request / internal 两个码)。 */
function panelError<T>(code: 'bad-request' | 'internal', message: string): RpcResult<T> {
  return code === 'internal'
    ? { ok: false, error: { code: 'internal', message, details: {} } }
    : { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

/**
 * 面板 RPC 分发:token 门 → 载荷校验 → 注入依赖调用。
 *
 * 端点:entries(列记忆,带过滤)/ dashboard-get(状态页视图模型)/ config-get
 * (读配置)/ config-set(写配置)。未知端点与非法载荷一律 bad-request;依赖抛错
 * 折叠为 internal。
 * @param endpoint - channel 相对端点。
 * @param payload - 客户端载荷(必须携带合法 acToken)。
 * @param token - 服务端持有的面板 token。
 * @param deps - 注入依赖。
 * @returns RPC 结果。
 */
export async function handlePanelRpc(
  endpoint: string,
  payload: unknown,
  token: string,
  deps: PanelDeps,
): Promise<RpcResult<unknown>> {
  try {
    switch (endpoint) {
      case 'entries': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(ENTRIES_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        const { cwd, filters } = parsed.value
        return { ok: true, value: { entries: deps.entries(cwd, filters ?? {}) } }
      }
      case 'dashboard-get': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(DASHBOARD_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { dashboard: deps.dashboard(parsed.value.cwd) } }
      }
      case 'config-get': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(TOKEN_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { config: deps.getConfig() } }
      }
      case 'config-set': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(CONFIG_SET_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { config: await deps.setConfig(parsed.value.patch) } }
      }
      default:
        return panelError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
}

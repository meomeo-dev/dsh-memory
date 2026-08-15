/**
 * 面板的 host RPC 客户端:信封 {type:"client-request",rpcId,method,payload},
 * payload 恒携带 acToken。只做线协议编解码与错误折叠,不解析业务数据。
 */

/** HTML 壳注入的引导数据(见 host 侧 renderPanelShell)。 */
export interface Bootstrap {
  readonly page: 'memory' | 'status' | 'collections' | 'nodes' | 'settings'
  readonly token: string
  readonly channel: string
}

/** 从 #dsh-memory-bootstrap 读引导数据;缺失/非法返回 undefined(页面显示错误)。 */
export function readBootstrap(): Bootstrap | undefined {
  const el = document.getElementById('dsh-memory-bootstrap')
  if (el === null || el.textContent === null) return undefined
  try {
    const value = JSON.parse(el.textContent) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { page, token, channel } = value as Record<string, unknown>
    if ((page !== 'memory' && page !== 'status' && page !== 'collections' && page !== 'nodes' && page !== 'settings') || typeof token !== 'string' || typeof channel !== 'string') {
      return undefined
    }
    return { page, token, channel }
  } catch {
    return undefined
  }
}

/** 一条记忆条目的线协议投影(host 侧 MemoryEntry)。 */
export interface EntryDto {
  readonly id: string
  readonly schemaVersion: number
  readonly createdAt: number
  readonly type: 'rules' | 'lessons'
  readonly domain: string
  readonly scope: string
  readonly layer: 'global' | 'user' | 'project'
  readonly entry: string
  readonly entryPoint: string
  readonly references: string
}

/** 一条面板记忆行(完整条目 + 所在文件)。 */
export interface EntryRow {
  readonly entry: EntryDto
  readonly file: string
}

/** 过滤条件(全部可选,空串不发送)。 */
export interface Filters {
  readonly type?: string
  readonly domain?: string
  readonly layer?: string
  readonly query?: string
}

/** 某一天某一职责的聚合(镜像 host 侧 DashboardLabelUsage)。 */
export interface LabelDayUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly totalTokens: number
}

/** 某一天的聚合(镜像 host 侧 DashboardDaily)。 */
export interface DayUsage {
  readonly day: string
  readonly recall: LabelDayUsage
  readonly extract: LabelDayUsage
  readonly review: LabelDayUsage
  readonly total: number
}

/** 状态页视图模型(与 host 侧 DashboardDto 同构)。 */
export interface Dashboard {
  readonly status: {
    readonly maxNodeKb: number
    readonly teams: readonly { readonly root: string; readonly nodes: number }[]
  }
  readonly stats: {
    readonly total: number
    readonly rules: number
    readonly lessons: number
    readonly layers: { readonly global: number; readonly user: number; readonly project: number }
    readonly domains: readonly { readonly domain: string; readonly count: number }[]
    readonly files: number
    readonly jsonlBytes: number
    readonly mdBytes: number
    readonly catalogEntries: number
  }
  readonly usage: {
    readonly warmTeams: { readonly nodes: number; readonly chars: number; readonly tokens: number }
    readonly summary: { readonly chars: number; readonly tokens: number }
    /** 近 14 天按职责聚合(host 级持久;与 daily 同源)。 */
    readonly totals: readonly {
      readonly label: string
      readonly calls: number
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
    }[]
    /** 近 84 天按日聚合(升序,零填充)。 */
    readonly daily: readonly DayUsage[]
  }
}

/** 目录页一个记忆根的行(镜像 host 侧 RootRow)。 */
export interface RootRow {
  readonly root: string
  readonly kind: 'user' | 'project'
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly entries: number
  readonly files: number
  readonly exists: boolean
  readonly filesDetail: readonly { readonly file: string; readonly entries: number }[]
}

/** 目录页视图模型(镜像 host 侧 RootsView)。 */
export interface RootsView {
  readonly roots: readonly RootRow[]
  readonly summary: {
    readonly roots: number
    readonly totalEntries: number
    readonly totalFiles: number
  }
}

/** 单个节点的运行时状态(镜像 host 侧 NodeRuntimeState)。 */
export interface NodeRuntimeDto {
  readonly running: number
  readonly runningSince?: number
  readonly calls: number
  readonly lastAt: number
  readonly lastDurationMs: number
  readonly lastOk: boolean
  readonly lastError?: string
}

/** 一个进程的行(镜像 host 侧 ProcessRow;formatVersion 随行携带但面板不消费)。 */
export interface ProcessRowDto {
  readonly formatVersion: number
  readonly pid: number
  readonly startedAt: number
  readonly cwd: string
  readonly port?: number
  readonly lastSeenAt: number
  readonly teams: readonly { readonly root: string; readonly nodes: number; readonly chars: number }[]
  readonly summaryChars: number
  readonly nodes: {
    readonly recall: NodeRuntimeDto
    readonly extract: NodeRuntimeDto
    readonly review: NodeRuntimeDto
  }
  readonly stale: boolean
  readonly isCurrent: boolean
}

/** 设置页配置项。 */
export interface ConfigItem {
  readonly key: string
  readonly meta: {
    readonly label: string
    readonly description: string
    readonly kind: 'number' | 'boolean' | 'enum' | 'string' | 'textarea'
    readonly options?: readonly string[]
  }
  readonly value: unknown
}

/**
 * 过滤下拉的可选值。镜像自 schema/memory-entry.schema.yaml 的 enum(单一真相源);
 * 面板构建不 import host 包,故按值镜像——漂移时条目仍按自身字段显示,
 * 只是下拉缺新值(host 端过滤兜底,不会错读)。
 */
export const DISPLAY = {
  types: ['rules', 'lessons'] as const,
  domains: [
    'OutputContract', 'ToolGovernance', 'RedLines', 'Invariants', 'NamingBijection',
    'ContractConstants', 'CommandsRuntime', 'DirScoped', 'PathScopedRules', 'WorkflowSOP',
    'QualityGates', 'RebuildSpec', 'ChangeSurface', 'ADR', 'DurablePrefs', 'Glossary',
    'ExternalRefs', 'PromotedPitfalls', 'CodeFacts', 'PastFixes', 'Style',
  ] as const,
  layers: ['global', 'user', 'project'] as const,
}

let rpcCounter = 0

/**
 * 调一次面板 RPC。
 * @param bootstrap - 引导数据(token / channel)。
 * @param endpoint - channel 相对端点。
 * @param payload - 端点载荷(自动附带 acToken)。
 * @returns 成功分支的 value。
 * @throws 当 HTTP 失败或 host 返回 {ok:false}(错误文本来自 host)。
 */
export async function rpc<T>(
  bootstrap: Bootstrap,
  endpoint: 'entries' | 'dashboard-get' | 'roots-get' | 'root-add' | 'root-forget' | 'root-export' | 'config-get' | 'config-set' | 'nodes-get',
  payload: Record<string, unknown> = {},
): Promise<T> {
  const rpcId = `panel-${++rpcCounter}`
  const response = await fetch(`${bootstrap.channel}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { ...payload, acToken: bootstrap.token },
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as {
    readonly result: { readonly ok: boolean; readonly value?: T; readonly error?: { readonly message: string } }
  }
  if (!body.result.ok) throw new Error(body.result.error?.message ?? 'unknown host error')
  return body.result.value as T
}

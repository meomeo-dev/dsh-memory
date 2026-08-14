/**
 * 长期记忆条目的领域模型与 JSONL 逐行 schema(单一真相源)。
 *
 * 一条记忆 = `.remember.jsonl` 的一行;本模块的 {@link MEMORY_ENTRY_SCHEMA} 是
 * 校验的唯一权威。`type` 只含 `rules` / `lessons` 两类(不含 state/todo),见
 * docs/concept.md §4;`domain` 是 21 个 closed 枚举之一,见 docs/concept.md §3。
 *
 * 每条记忆带一个全局唯一编号 {@link MemoryId}(docs/memory-review.md §2):
 * `m-` + 10 位 base36(crypto 随机)。id 随记忆一生不变,是 catalog 的主键与按
 * id 精确操作(update / delete / find)的句柄。
 *
 * 契约常量(工具校验与文件校验共用)也在此导出,避免两处漂移。
 *
 * @module dsh-memory/schema
 */

import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** 长期记忆只含的两类信息(`rules` 偏好/约束,`lessons` 经验教训)。 */
export const MEMORY_TYPES = ['rules', 'lessons'] as const

/** 一条记忆的类型(长期记忆不含 state/todo)。 */
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** 21 个知识领域 id(closed 枚举,与 docs/concept.md §3 一一对应)。 */
export const DOMAINS = [
  'OutputContract',
  'ToolGovernance',
  'RedLines',
  'Invariants',
  'NamingBijection',
  'ContractConstants',
  'CommandsRuntime',
  'DirScoped',
  'PathScopedRules',
  'WorkflowSOP',
  'QualityGates',
  'RebuildSpec',
  'ChangeSurface',
  'ADR',
  'DurablePrefs',
  'Glossary',
  'ExternalRefs',
  'PromotedPitfalls',
  'CodeFacts',
  'PastFixes',
  'Style',
] as const

/** 一条记忆的知识领域 id。 */
export type DomainId = (typeof DOMAINS)[number]

/** 记忆的落点层(layer):Global / User / Project 三层物理存储位置。 */
export const LAYERS = ['global', 'user', 'project'] as const

/** 一条记忆的落点层 id。 */
export type LayerId = (typeof LAYERS)[number]

/** 记忆唯一编号:`m-` + 10 位 base36(crypto 随机),如 `m-3k9f2x8q1a`。 */
export type MemoryId = `m-${string}`

/** {@link MemoryId} 的运行时格式正则:`m-` 前缀 + 10 位 base36(`[0-9a-z]`)。 */
export const MEMORY_ID_RE = /^m-[0-9a-z]{10}$/

/**
 * 判断一个值是否为合法 {@link MemoryId}(运行时格式校验)。
 * @param value - 待判定值。
 * @returns 当 `value` 是 `m-` + 10 位 base36 字符串时为真。
 */
export function isMemoryId(value: unknown): value is MemoryId {
  return typeof value === 'string' && MEMORY_ID_RE.test(value)
}

/**
 * 生成一个新的记忆唯一编号:`m-` + 10 位 base36(crypto 随机)。
 *
 * 用随机而非全局递增,是因为记忆跨 global/user/project 三层分散写,递增需跨层
 * 协调全局计数器;随机 id 全局唯一、无需协调、短且可引用(见 docs/memory-review.md §2)。
 * 8 字节(64 位)随机数的 base36 表示补零后取前 10 位,保证恒为 10 个 base36 字符。
 * @returns 新的 {@link MemoryId}。
 */
export function generateMemoryId(): MemoryId {
  const suffix = randomBytes(8).readBigUInt64BE(0).toString(36).padStart(10, '0').slice(0, 10)
  return `m-${suffix}` as MemoryId
}

/**
 * 一条长期记忆条目的运行时形状(JSONL 一行,schema 归一化后)。
 *
 * `id` 是全局唯一编号;`entryPoint` / `references` 缺省为 `-`(无关联文件路径)。
 */
export interface MemoryEntry {
  /** 全局唯一编号(随记忆一生不变,catalog 主键)。 */
  readonly id: MemoryId
  /** 记忆类型:偏好/约束,或经验教训。 */
  readonly type: MemoryType
  /** 知识领域(21 个 closed 枚举之一)。 */
  readonly domain: DomainId
  /** 影响范围:作用于哪个子系统 / 模块(自由文本,非空);与 domain 正交成对。 */
  readonly scope: string
  /** 落点层:global / user / project(物理存储位置,元数据,不参与语义定位)。 */
  readonly layer: LayerId
  /** 一句话条目文本(非空)。 */
  readonly entry: string
  /** 关联入口文件路径,缺省 `-`。 */
  readonly entryPoint: string
  /** 关联参考文件路径,缺省 `-`。 */
  readonly references: string
}

/** 新建记忆的候选输入(无 `id`;`id` 由存储层生成,`entryPoint`/`references` 缺省 `-`)。 */
export interface MemoryEntryInput {
  /** 记忆类型:偏好/约束,或经验教训。 */
  readonly type: MemoryType
  /** 知识领域(21 个 closed 枚举之一)。 */
  readonly domain: DomainId
  /** 影响范围:作用于哪个子系统 / 模块(自由文本,非空)。 */
  readonly scope: string
  /** 落点层:global / user / project。 */
  readonly layer: LayerId
  /** 一句话条目文本(非空)。 */
  readonly entry: string
  /** 关联入口文件路径,可省略(缺省 `-`)。 */
  readonly entryPoint?: string
  /** 关联参考文件路径,可省略(缺省 `-`)。 */
  readonly references?: string
}

/**
 * 8 列 Markdown 表格表头(首列 `id` + {@link MemoryEntry} 的 7 个字段:
 * type / domain / scope / layer / entry / entryPoint / references)。
 * 其中 domain 与 scope 是语义定位的正交对,layer 是存储元数据。
 */
export const TABLE_HEADER = [
  'id',
  '类型',
  '所属知识领域 (domain)',
  '影响范围 (Scope)',
  'Layer (落点层)',
  '条目',
  'entry point (file path)',
  'references (file path)',
] as const

/** 8 列表格分隔行。 */
export const TABLE_SEPARATOR = '|---|---|---|---|---|---|---|---|'

/** lessons 单条入口的字数上限(concept.md §5「偶尔合并,单条 ≤300 字」)。 */
export const MAX_LESSON_CHARS = 300

/**
 * 记忆文件名正则:日期 + 可选分区(自由分片)+ 类型 + 后缀。
 * `YYYY-MM-DD[.<partition>].<rules|lessons>.remember.{jsonl,md}`。
 */
export const FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9-]+)?\.(rules|lessons)\.remember\.(jsonl|md)$/

/**
 * JSONL 记录 schema:逐行校验的单一真相源。
 *
 * `id` 字段为可选(不标 `.required()`):兼容尚无 id 的旧行与新建候选;归一化时
 * 由 {@link validateEntry} / {@link parseEntryMigrating} 统一补齐,保证返回的
 * {@link MemoryEntry.id} 恒存在。
 */
export const MEMORY_ENTRY_SCHEMA: Schema<MemoryEntry> = z.object({
  id: z.string().pattern(MEMORY_ID_RE),
  type: z.union([...MEMORY_TYPES]),
  domain: z.union([...DOMAINS]),
  scope: z.string().min(1).required(),
  layer: z.union([...LAYERS]),
  entry: z.string().min(1).required(),
  entryPoint: z.string().default('-'),
  references: z.string().default('-'),
}) as unknown as Schema<MemoryEntry>

/** 由 schemastery 的 ValidationError 提取可读文本。 */
function describeSchemaError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 校验一个候选条目(任意来源,如 JSON.parse 产物)并归一化。
 *
 * 候选可缺 `id`(旧行或新建输入):缺失时惰性生成一个 {@link MemoryId} 补齐,
 * 保证返回值恒带 `id`。`entryPoint` / `references` 缺省为 `-`。
 * @param entry - 候选条目。
 * @param lineNumber - 可选行号,用于把错误定位到 JSONL 的某一行。
 * @returns 归一化后的 {@link MemoryEntry}(恒带 `id`)。
 * @throws 当类型 / 域 / 范围非法、entry 为空、或列缺失、或 id 格式非法。
 */
export function validateEntry(entry: unknown, lineNumber?: number): MemoryEntry {
  const where = lineNumber === undefined ? 'remember.jsonl' : `remember.jsonl:${lineNumber}`
  try {
    const normalized = MEMORY_ENTRY_SCHEMA(entry as unknown as MemoryEntry) as unknown as Record<string, unknown>
    if (!isMemoryId(normalized.id)) normalized.id = generateMemoryId()
    return normalized as unknown as MemoryEntry
  } catch (error) {
    throw new Error(`${where}: ${describeSchemaError(error)}`)
  }
}

/**
 * 解析 JSONL 的一行为一条记忆(解析 + 校验 + 补 id)。
 *
 * 旧行缺 `id` 时惰性生成并返回(不落盘;需落盘的迁移请用 {@link parseEntryMigrating})。
 * @param line - 一行 JSON 文本。
 * @param lineNumber - 可选行号,用于错误定位。
 * @returns 归一化后的 {@link MemoryEntry}(恒带 `id`)。
 * @throws 当 JSON 非法或 schema 校验失败。
 */
export function parseEntry(line: string, lineNumber?: number): MemoryEntry {
  return parseEntryMigrating(line, lineNumber).entry
}

/**
 * 解析 JSONL 的一行为一条记忆,并报告该行是否发生了旧数据迁移(缺 id 被补齐)。
 *
 * 这是存储层做「惰性迁移 + 落盘」的入口:读旧行时发现缺 id,补一个 id 并标记
 * `migrated: true`,由调用方决定是否把补齐后的 id 写回 jsonl,保证 id 稳定。
 * @param line - 一行 JSON 文本。
 * @param lineNumber - 可选行号,用于错误定位。
 * @returns 归一化条目与「是否补齐了 id」的标记。
 * @throws 当 JSON 非法、schema 校验失败、或 id 存在但格式非法(视为数据损坏)。
 */
export function parseEntryMigrating(line: string, lineNumber?: number): { entry: MemoryEntry; migrated: boolean } {
  const where = lineNumber === undefined ? 'remember.jsonl' : `remember.jsonl:${lineNumber}`
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    throw new Error(`${where}: invalid JSON: ${describeSchemaError(error)}`)
  }
  const hadId = typeof raw === 'object' && raw !== null && isMemoryId((raw as Record<string, unknown>).id)
  return { entry: validateEntry(raw, lineNumber), migrated: !hadId }
}

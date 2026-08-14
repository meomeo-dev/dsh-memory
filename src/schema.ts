/**
 * 长期记忆条目的领域模型与 JSONL 逐行 schema(单一真相源)。
 *
 * 一条记忆 = `.remember.jsonl` 的一行;本模块的 {@link MEMORY_ENTRY_SCHEMA} 是
 * 校验的唯一权威。`type` 只含 `rules` / `lessons` 两类(不含 state/todo),见
 * docs/concept.md §4;`domain` 是 21 个 closed 枚举之一,见 docs/concept.md §3。
 *
 * 契约常量(工具校验与文件校验共用)也在此导出,避免两处漂移。
 *
 * @module dsh-memory/schema
 */

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

/**
 * 一条长期记忆条目的运行时形状(JSONL 一行,schema 归一化后)。
 *
 * `entryPoint` / `references` 缺省为 `-`(无关联文件路径)。
 */
export interface MemoryEntry {
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

/**
 * 7 列 Markdown 表格表头(与 {@link MemoryEntry} 的 7 个字段一一对应:
 * type / domain / scope / layer / entry / entryPoint / references)。
 * 其中 domain 与 scope 是语义定位的正交对,layer 是存储元数据。
 */
export const TABLE_HEADER = [
  '类型',
  '所属知识领域 (domain)',
  '影响范围 (Scope)',
  'Layer (落点层)',
  '条目',
  'entry point (file path)',
  'references (file path)',
] as const

/** 7 列表格分隔行。 */
export const TABLE_SEPARATOR = '|---|---|---|---|---|---|---|'

/** lessons 单条入口的字数上限(concept.md §5「偶尔合并,单条 ≤300 字」)。 */
export const MAX_LESSON_CHARS = 300

/**
 * 记忆文件名正则:日期 + 可选分区(自由分片)+ 类型 + 后缀。
 * `YYYY-MM-DD[.<partition>].<rules|lessons>.remember.{jsonl,md}`。
 */
export const FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}(?:\.[a-z0-9-]+)?\.(rules|lessons)\.remember\.(jsonl|md)$/

/** JSONL 记录 schema:逐行校验的单一真相源。 */
export const MEMORY_ENTRY_SCHEMA: Schema<MemoryEntry> = z.object({
  type: z.union([...MEMORY_TYPES]),
  domain: z.union([...DOMAINS]),
  scope: z.string().min(1).required(),
  layer: z.union([...LAYERS]),
  entry: z.string().min(1).required(),
  entryPoint: z.string().default('-'),
  references: z.string().default('-'),
})

/** 由 schemastery 的 ValidationError 提取可读文本。 */
function describeSchemaError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 校验一个候选条目(任意来源,如 JSON.parse 产物)并归一化。
 * @param entry - 候选条目。
 * @param lineNumber - 可选行号,用于把错误定位到 JSONL 的某一行。
 * @returns 归一化后的 {@link MemoryEntry}。
 * @throws 当类型 / 域 / 范围非法、entry 为空、或列缺失。
 */
export function validateEntry(entry: unknown, lineNumber?: number): MemoryEntry {
  const where = lineNumber === undefined ? 'remember.jsonl' : `remember.jsonl:${lineNumber}`
  try {
    return MEMORY_ENTRY_SCHEMA(entry as unknown as MemoryEntry) as MemoryEntry
  } catch (error) {
    throw new Error(`${where}: ${describeSchemaError(error)}`)
  }
}

/**
 * 解析 JSONL 的一行为一条记忆(解析 + 校验)。
 * @param line - 一行 JSON 文本。
 * @param lineNumber - 可选行号,用于错误定位。
 * @returns 归一化后的 {@link MemoryEntry}。
 * @throws 当 JSON 非法或 schema 校验失败。
 */
export function parseEntry(line: string, lineNumber?: number): MemoryEntry {
  const where = lineNumber === undefined ? 'remember.jsonl' : `remember.jsonl:${lineNumber}`
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    throw new Error(`${where}: invalid JSON: ${describeSchemaError(error)}`)
  }
  return validateEntry(raw, lineNumber)
}

// 由 scripts/gen-schema.mjs 从 schema/memory-entry.schema.yaml 生成,勿手改。
// 单一真相源是 schema/memory-entry.schema.yaml;改契约只改 yaml,再跑 pnpm gen:schema。
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** schema 版本号(记录级,单调递增)。 */
export const SCHEMA_VERSION = 2

export const MEMORY_TYPES = ["rules", "lessons"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const DOMAINS = ["OutputContract", "ToolGovernance", "RedLines", "Invariants", "NamingBijection", "ContractConstants", "CommandsRuntime", "DirScoped", "PathScopedRules", "WorkflowSOP", "QualityGates", "RebuildSpec", "ChangeSurface", "ADR", "DurablePrefs", "Glossary", "ExternalRefs", "PromotedPitfalls", "CodeFacts", "PastFixes", "Style"] as const
export type DomainId = (typeof DOMAINS)[number]

export const LAYERS = ["global", "user", "project"] as const
export type LayerId = (typeof LAYERS)[number]

/** 记忆唯一编号(品牌类型)。 */
export type MemoryId = `m-${string}`

/** {@link MemoryId} 的运行时格式正则(来自 schema.yaml 的 id.pattern)。 */
export const MEMORY_ID_RE = /^m-[0-9a-z]{10}$/

/** 一条长期记忆条目(JSONL 一行)的运行时形状。 */
export interface MemoryEntry {
  readonly id: MemoryId
  readonly schemaVersion: number
  readonly createdAt: number
  readonly type: MemoryType
  readonly domain: DomainId
  readonly scope: string
  readonly layer: LayerId
  readonly entry: string
  readonly entryPoint: string
  readonly references: string
}

/** JSONL 记录 schema:逐行校验的数据契约(来自 schema.yaml)。 */
export const MEMORY_ENTRY_SCHEMA: Schema<MemoryEntry> = z.object({
  id: z.string().pattern(MEMORY_ID_RE).required(),
  schemaVersion: z.number().step(1).min(1).required(),
  createdAt: z.number().step(1).min(0).required(),
  type: z.union([...MEMORY_TYPES]).required(),
  domain: z.union([...DOMAINS]).required(),
  scope: z.string().min(1).required(),
  layer: z.union([...LAYERS]).required(),
  entry: z.string().min(1).required(),
  entryPoint: z.string().default("-"),
  references: z.string().default("-"),
}) as unknown as Schema<MemoryEntry>

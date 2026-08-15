/**
 * 从 schema/memory-entry.schema.yaml(单一真相源)生成 src/schema.generated.ts。
 *
 * 生成的运行时 schemastery 校验器 + 枚举常量 + 正则 + MemoryEntry 接口,只来自
 * schema.yaml;本脚本是「数据契约」与「运行时校验」之间的唯一桥。改契约只改
 * schema.yaml,再跑 `pnpm gen:schema` 重新生成。
 *
 * JSON Schema → schemastery 映射:
 *   type: string               → z.string()
 *   type: string + enum        → z.union([...<常量>])(字段名 type/domain/layer)
 *   type: string + pattern     → z.string().pattern(<正则>)(字段名 id)
 *   type: string + minLength   → z.string().min(n)
 *   type: integer              → z.number().step(1)
 *   minimum                    → .min(n)
 *   default                    → .default(v)
 *   required 列表中的字段        → .required()
 *
 * @module dsh-memory/gen-schema
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const yamlPath = resolve(root, 'schema/memory-entry.schema.yaml')
const outPath = resolve(root, 'src/schema.generated.ts')

const schema = parse(readFileSync(yamlPath, 'utf8'))
const version = schema['x-schema-version']
const props = schema.properties
const required = new Set(schema.required ?? [])

/** 枚举字段名 → 生成的常量名(schema.yaml 里这些字段的 enum 是唯一来源)。 */
const ENUM_CONST = { type: 'MEMORY_TYPES', domain: 'DOMAINS', layer: 'LAYERS' }

/** 字段名 → MemoryEntry 接口里的 TS 类型名(硬编码,与领域模型一一对应)。 */
const FIELD_TYPE = {
  id: 'MemoryId',
  schemaVersion: 'number',
  createdAt: 'number',
  type: 'MemoryType',
  domain: 'DomainId',
  scope: 'string',
  layer: 'LayerId',
  entry: 'string',
  entryPoint: 'string',
  references: 'string',
}

/** 生成单个字段的 schemastery 表达式。 */
function genField(name, prop) {
  let base
  if (name === 'id') {
    base = 'z.string().pattern(MEMORY_ID_RE)'
  } else if (prop.type === 'integer') {
    base = 'z.number().step(1)'
  } else if (prop.enum !== undefined) {
    base = `z.union([...${ENUM_CONST[name]}])`
  } else if (prop.minLength !== undefined) {
    base = `z.string().min(${prop.minLength})`
  } else {
    base = 'z.string()'
  }
  if (prop.minimum !== undefined) base += `.min(${prop.minimum})`
  if (prop.default !== undefined) base += `.default(${JSON.stringify(prop.default)})`
  if (required.has(name)) base += '.required()'
  return base
}

// 枚举常量的声明块(显式写,避免脆弱的类型名推导)。
const enumBlocks = [
  ['MEMORY_TYPES', 'MemoryType', props.type.enum],
  ['DOMAINS', 'DomainId', props.domain.enum],
  ['LAYERS', 'LayerId', props.layer.enum],
]

const enumTs = enumBlocks.map(([constName, typeName, values]) =>
  `export const ${constName} = [${values.map((v) => JSON.stringify(v)).join(', ')}] as const\n` +
  `export type ${typeName} = (typeof ${constName})[number]`)

const idPattern = props.id.pattern

const fieldLines = Object.entries(props).map(([name, prop]) => `  ${name}: ${genField(name, prop)},`)

const ifaceFields = Object.entries(props).map(([name]) => `  readonly ${name}: ${FIELD_TYPE[name]}`)

const out = `// 由 scripts/gen-schema.mjs 从 schema/memory-entry.schema.yaml 生成,勿手改。
// 单一真相源是 schema/memory-entry.schema.yaml;改契约只改 yaml,再跑 pnpm gen:schema。
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** schema 版本号(记录级,单调递增)。 */
export const SCHEMA_VERSION = ${version}

${enumTs.join('\n\n')}

/** 记忆唯一编号(品牌类型)。 */
export type MemoryId = \`m-\${string}\`

/** {@link MemoryId} 的运行时格式正则(来自 schema.yaml 的 id.pattern)。 */
export const MEMORY_ID_RE = /${idPattern}/

/** 一条长期记忆条目(JSONL 一行)的运行时形状。 */
export interface MemoryEntry {
${ifaceFields.join('\n')}
}

/** JSONL 记录 schema:逐行校验的数据契约(来自 schema.yaml)。 */
export const MEMORY_ENTRY_SCHEMA: Schema<MemoryEntry> = z.object({
${fieldLines.join('\n')}
}) as unknown as Schema<MemoryEntry>
`

writeFileSync(outPath, out, 'utf8')
console.log(`generated ${outPath} (schemaVersion=${version})`)

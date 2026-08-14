import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { DOMAINS, LAYERS, MEMORY_ID_RE, MEMORY_TYPES, SCHEMA_VERSION } from '../src/schema.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const yaml = parse(readFileSync(resolve(root, 'schema/memory-entry.schema.yaml'), 'utf8')) as {
  'x-schema-version': number
  properties: {
    id: { pattern: string }
    type: { enum: readonly string[] }
    domain: { enum: readonly string[] }
    layer: { enum: readonly string[] }
  }
}

describe('schema contract (generated vs schema.yaml)', () => {
  it('SCHEMA_VERSION matches x-schema-version', () => {
    expect(SCHEMA_VERSION).toBe(yaml['x-schema-version'])
  })

  it('MEMORY_TYPES matches type.enum', () => {
    expect([...MEMORY_TYPES]).toEqual([...yaml.properties.type.enum])
  })

  it('DOMAINS matches domain.enum (21 unique)', () => {
    expect([...DOMAINS]).toEqual([...yaml.properties.domain.enum])
    expect(DOMAINS).toHaveLength(21)
    expect(new Set(DOMAINS).size).toBe(21)
  })

  it('LAYERS matches layer.enum (3)', () => {
    expect([...LAYERS]).toEqual([...yaml.properties.layer.enum])
    expect(LAYERS).toHaveLength(3)
  })

  it('MEMORY_ID_RE matches id.pattern', () => {
    expect(MEMORY_ID_RE.source).toBe(yaml.properties.id.pattern)
  })
})

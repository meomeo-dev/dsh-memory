/**
 * 共享存储层:长期记忆的唯一写盘入口(纯逻辑,不 import cordis)。
 *
 * 写盘不变量(校验 + 生成 id + 去重/合并 + 追加/重写 JSONL + 重渲染 MD + 更新
 * catalog)只存在于本模块一处——模型面工具(remember / forget,以及后续的
 * memory-update / memory-delete)与抽取器都调它,不各自维护一套写盘逻辑
 * (docs/auto-extraction.md §5.5 的 store 分层)。
 *
 * 目录发现(读)由 {@link ./memory-file.js} 承担;本模块专注写与索引:
 *   - `append` / `update` / `remove`(按 id)/ `removeByEntry`(按 entry 文本,供 forget)/
 *     `find` / `rebuild`。
 *   - 旧数据迁移:读取时发现缺失 `id` 的旧行,惰性补一个 id 并落盘(id 一生不变)。
 *   - `catalog.json`:每层 `memory/` 目录一个派生索引(记忆 id → 所在文件),全量重写、
 *     可重建;真相源仍是 `.remember.jsonl`,不一致时以 jsonl 为准。
 *
 * @module dsh-memory/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { checkMarkdown } from './check.js'
import { visibleMemoryDirs, writeRootFor } from './memory-file.js'
import type { MemoryFile } from './memory-file.js'
import { renderMd } from './render.js'
import { MAX_LESSON_CHARS, parseEntryMigrating, validateEntry } from './schema.js'
import type { DomainId, LayerId, MemoryEntry, MemoryEntryInput, MemoryId, MemoryType } from './schema.js'

/** catalog 文件格式版本(docs/memory-review.md §3 的 `version`)。 */
const CATALOG_VERSION = 1

/** catalog 里的一条索引:记忆 id → 所在文件(附少量定位字段)。 */
export interface CatalogEntry {
  /** 记忆唯一编号。 */
  readonly id: MemoryId
  /** 相对本层 `memory/` 目录的 `.remember.jsonl` 路径。 */
  readonly file: string
  /** 记忆类型。 */
  readonly type: MemoryType
  /** 知识领域。 */
  readonly domain: DomainId
  /** 影响范围。 */
  readonly scope: string
  /** 落点层。 */
  readonly layer: LayerId
  /** 一句话条目文本。 */
  readonly entry: string
}

/** 一层的派生索引目录(全量重写、可重建)。 */
export interface Catalog {
  /** catalog 格式版本。 */
  readonly version: number
  /** 索引条目(按 jsonl 文件扫描顺序)。 */
  readonly entries: readonly CatalogEntry[]
}

/** `append` 的结果。 */
export interface AppendResult {
  /** 落盘的记忆(恒带 `id`)。 */
  readonly entry: MemoryEntry
  /** 是否因重复(rules 只增不减)被拒绝,未落盘。 */
  readonly duplicate: boolean
  /** 落盘 jsonl 路径;`duplicate` 时为 `undefined`。 */
  readonly jsonlPath?: string
  /** 落盘 md 路径;`duplicate` 时为 `undefined`。 */
  readonly mdPath?: string
}

/** `update` 可改写的字段(`id` / `type` / `layer` 不可改,见 docs/memory-review.md §6)。 */
export interface UpdatePatch {
  /** 新知识领域。 */
  readonly domain?: DomainId
  /** 新影响范围。 */
  readonly scope?: string
  /** 新条目文本。 */
  readonly entry?: string
  /** 新关联入口文件路径。 */
  readonly entryPoint?: string
  /** 新关联参考文件路径。 */
  readonly references?: string
}

/** `find` 的过滤条件(任一维度均可选,可组合)。 */
export interface FindQuery {
  /** 按 id 精确查一条。 */
  readonly id?: MemoryId
  /** 按类型过滤。 */
  readonly type?: MemoryType
  /** 按领域过滤。 */
  readonly domain?: DomainId
  /** 按影响范围过滤(精确匹配)。 */
  readonly scope?: string
  /** 按落点层过滤。 */
  readonly layer?: LayerId
}

/** `find` 命中的一条记忆:完整字段 + 所在文件。 */
export interface FoundEntry {
  /** 完整记忆条目。 */
  readonly entry: MemoryEntry
  /** 相对所在 `memory/` 目录的 `.remember.jsonl` 路径。 */
  readonly file: string
}

/** `remove`(按 id 删除)的结果。 */
export interface RemoveResult {
  /** 是否删除了某条记忆。 */
  readonly removed: boolean
  /** 被删除的记忆(未命中时为 `undefined`)。 */
  readonly entry?: MemoryEntry
  /** 被删除记忆所在文件(未命中时为 `undefined`)。 */
  readonly file?: string
}

/** 今天的本地日期 `YYYY-MM-DD`。 */
function today(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 某类型当天文件的 jsonl / md 路径对。 */
function todayPaths(dir: string, type: MemoryType): { jsonlPath: string; mdPath: string } {
  const base = `${today()}.${type}.remember`
  return { jsonlPath: join(dir, `${base}.jsonl`), mdPath: join(dir, `${base}.md`) }
}

/** 由 jsonl 路径推出同名 md 路径。 */
function mdPathOf(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.md')
}

/** 按确定性字段顺序序列化一条记忆(id 在前)。 */
function serializeEntry(entry: MemoryEntry): string {
  return JSON.stringify({
    id: entry.id,
    type: entry.type,
    domain: entry.domain,
    scope: entry.scope,
    layer: entry.layer,
    entry: entry.entry,
    entryPoint: entry.entryPoint,
    references: entry.references,
  })
}

/**
 * 写一批条目到一对 jsonl / md 文件:先渲染 MD 并通过静态检查,再落盘。
 * @param jsonlPath - `.remember.jsonl` 目标路径。
 * @param mdPath - 同名 `.remember.md` 目标路径。
 * @param entries - 该文件完整的条目集合。
 * @throws 当渲染出的 MD 未通过静态检查(拒绝写盘)。
 */
function writeFilePair(jsonlPath: string, mdPath: string, entries: readonly MemoryEntry[]): void {
  const md = renderMd(entries)
  const errors = checkMarkdown(md)
  if (errors.length > 0) {
    throw new Error(`rendered Markdown failed static check: ${errors.join('; ')}`)
  }
  mkdirSync(dirname(jsonlPath), { recursive: true })
  const jsonl = entries.length > 0 ? `${entries.map(serializeEntry).join('\n')}\n` : ''
  writeFileSync(jsonlPath, jsonl, 'utf8')
  writeFileSync(mdPath, md, 'utf8')
}

/**
 * 读取一个 jsonl 文件并做旧数据迁移:缺失 `id` 的旧行补齐 id 后落盘(保证 id 稳定)。
 * @param jsonlPath - `.remember.jsonl` 路径。
 * @returns 该文件内全部条目(恒带 `id`)与是否发生了迁移。
 */
function readFileMigrating(jsonlPath: string): { entries: MemoryEntry[]; migrated: boolean } {
  if (!existsSync(jsonlPath)) return { entries: [], migrated: false }
  const text = readFileSync(jsonlPath, 'utf8')
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const parsed = lines.map((line, index) => parseEntryMigrating(line, index + 1))
  const migrated = parsed.some(result => result.migrated)
  const entries = parsed.map(result => result.entry)
  if (migrated) writeFilePair(jsonlPath, mdPathOf(jsonlPath), entries)
  return { entries, migrated }
}

/** 从给定目录读取全部 jsonl 文件并做迁移(按路径排序)。 */
function loadDirMigrating(dir: string): MemoryFile[] {
  if (!existsSync(dir)) return []
  const files: MemoryFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.remember.jsonl')) continue
    const jsonlPath = join(dir, entry.name)
    const mdPath = mdPathOf(jsonlPath)
    const { entries } = readFileMigrating(jsonlPath)
    files.push({ jsonlPath, mdPath, entries })
  }
  return files.sort((a, b) => (a.jsonlPath < b.jsonlPath ? -1 : a.jsonlPath > b.jsonlPath ? 1 : 0))
}

/** 读取给定 cwd 可见的全部记忆文件并做迁移(跨层展平)。 */
function loadAllMigrating(cwd: string | undefined): MemoryFile[] {
  const files: MemoryFile[] = []
  for (const dir of visibleMemoryDirs(cwd)) {
    if (!existsSync(dir)) continue
    files.push(...loadDirMigrating(dir))
  }
  return files
}

/** 由一层的记忆文件构建 catalog(派生索引)。 */
function buildCatalog(files: readonly MemoryFile[]): Catalog {
  return {
    version: CATALOG_VERSION,
    entries: files.flatMap(file => file.entries.map(entry => ({
      id: entry.id,
      file: basename(file.jsonlPath),
      type: entry.type,
      domain: entry.domain,
      scope: entry.scope,
      layer: entry.layer,
      entry: entry.entry,
    }))),
  }
}

/** 全量重写一层的 `catalog.json`。 */
function writeCatalog(dir: string, files: readonly MemoryFile[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'catalog.json'), `${JSON.stringify(buildCatalog(files), null, 2)}\n`, 'utf8')
}

/** 校验条目级业务约束:entry 非空白、lessons 单条 ≤300 字。 */
function assertEntryConstraints(entry: MemoryEntry): void {
  if (entry.entry.trim().length === 0) throw new Error('memory entry text must be non-empty')
  if (entry.type === 'lessons' && entry.entry.length > MAX_LESSON_CHARS) {
    throw new Error(`lessons entry must be at most ${MAX_LESSON_CHARS} characters`)
  }
}

/** `find` 的过滤匹配:全部非空维度都须命中。 */
function matches(entry: MemoryEntry, query: FindQuery): boolean {
  if (query.id !== undefined && entry.id !== query.id) return false
  if (query.type !== undefined && entry.type !== query.type) return false
  if (query.domain !== undefined && entry.domain !== query.domain) return false
  if (query.scope !== undefined && entry.scope !== query.scope) return false
  if (query.layer !== undefined && entry.layer !== query.layer) return false
  return true
}

/** 按 id 在可见目录中定位一条记忆(含其所在文件与同目录全部文件)。 */
function locate(cwd: string | undefined, id: MemoryId): {
  dir: string
  jsonlPath: string
  mdPath: string
  entry: MemoryEntry
  files: MemoryFile[]
} | undefined {
  for (const dir of visibleMemoryDirs(cwd)) {
    if (!existsSync(dir)) continue
    const files = loadDirMigrating(dir)
    for (const file of files) {
      const entry = file.entries.find(e => e.id === id)
      if (entry) return { dir, jsonlPath: file.jsonlPath, mdPath: file.mdPath, entry, files }
    }
  }
  return undefined
}

/**
 * 写入一条新记忆:校验 + 生成 id + 去重 + 追加 JSONL + 重渲染 MD + 更新 catalog。
 *
 * `rules` 只增不减(重复 `entry` 拒绝,返回 `duplicate: true` 不落盘);`lessons`
 * 单条 ≤300 字。写根由 `entry.layer` 决定(project → 项目根,否则用户根)。
 * @param cwd - 当前工作目录(用于解析写根与可见目录去重)。
 * @param candidate - 候选条目(无 `id`)。
 * @returns 落盘结果(含 id 与路径)或重复拒绝标记。
 * @throws 当 schema 校验失败、entry 空白、lessons 超长、或渲染 MD 未通过静态检查。
 */
export function append(cwd: string, candidate: MemoryEntryInput): AppendResult {
  const entry = validateEntry(candidate)
  assertEntryConstraints(entry)
  if (entry.type === 'rules') {
    const duplicate = loadAllMigrating(cwd).flatMap(file => file.entries)
      .some(existing => existing.type === 'rules' && existing.entry === entry.entry)
    if (duplicate) return { entry, duplicate: true }
  }
  const dir = writeRootFor(cwd, entry.layer)
  const { jsonlPath, mdPath } = todayPaths(dir, entry.type)
  const { entries } = readFileMigrating(jsonlPath)
  writeFilePair(jsonlPath, mdPath, [...entries, entry])
  writeCatalog(dir, loadDirMigrating(dir))
  return { entry, duplicate: false, jsonlPath, mdPath }
}

/**
 * 按 id 更新一条记忆的可改字段(`domain` / `scope` / `entry` / `entryPoint` /
 * `references`;`id` / `type` / `layer` 不可改)→ 重写该行 jsonl → 重渲染 MD → 更新 catalog。
 * @param cwd - 当前工作目录。
 * @param id - 目标记忆 id。
 * @param patch - 要改写的字段。
 * @returns 更新后的记忆与其所在文件。
 * @throws 当 id 不存在,或改写后的字段未通过校验。
 */
export function update(cwd: string | undefined, id: MemoryId, patch: UpdatePatch): FoundEntry {
  const located = locate(cwd, id)
  if (!located) throw new Error(`memory update: no entry with id "${id}"`)
  const merged = validateEntry({ ...located.entry, ...patch })
  assertEntryConstraints(merged)
  const next = located.files.map(file => file.jsonlPath === located.jsonlPath
    ? { ...file, entries: file.entries.map(e => e.id === id ? merged : e) }
    : file)
  writeFilePair(located.jsonlPath, located.mdPath, next.find(f => f.jsonlPath === located.jsonlPath)!.entries)
  writeCatalog(located.dir, next)
  return { entry: merged, file: basename(located.jsonlPath) }
}

/**
 * 按 id 删除一条记忆 → 删除该行 jsonl → 重渲染 MD → 更新 catalog。
 * @param cwd - 当前工作目录。
 * @param id - 目标记忆 id。
 * @returns 删除结果(未命中时 `removed: false`)。
 */
export function remove(cwd: string | undefined, id: MemoryId): RemoveResult {
  const located = locate(cwd, id)
  if (!located) return { removed: false }
  const next = located.files.map(file => file.jsonlPath === located.jsonlPath
    ? { ...file, entries: file.entries.filter(e => e.id !== id) }
    : file)
  writeFilePair(located.jsonlPath, located.mdPath, next.find(f => f.jsonlPath === located.jsonlPath)!.entries)
  writeCatalog(located.dir, next)
  return { removed: true, entry: located.entry, file: basename(located.jsonlPath) }
}

/**
 * 按 `entry` 文本精确匹配删除(可限定类型),并重渲染受影响文件的 MD 与 catalog。
 * 这是 `forget` 工具「不知道 id 时的宽泛删除入口」(docs/memory-review.md §6)。
 * @param cwd - 当前工作目录。
 * @param entryText - 精确匹配的条目文本。
 * @param type - 可选类型过滤;缺省匹配全部类型。
 * @returns 实际删除的条目数。
 */
export function removeByEntry(cwd: string, entryText: string, type?: MemoryType): number {
  let removed = 0
  for (const dir of visibleMemoryDirs(cwd)) {
    if (!existsSync(dir)) continue
    const files = loadDirMigrating(dir)
    const next = files.map(file => ({
      ...file,
      entries: file.entries.filter(e => e.entry !== entryText || (type !== undefined && e.type !== type)),
    }))
    let dirChanged = false
    for (let i = 0; i < files.length; i++) {
      const before = files[i]!.entries.length
      const after = next[i]!.entries.length
      if (before === after) continue
      dirChanged = true
      removed += before - after
      writeFilePair(next[i]!.jsonlPath, next[i]!.mdPath, next[i]!.entries)
    }
    if (dirChanged) writeCatalog(dir, next)
  }
  return removed
}

/**
 * 按 id 或类型/领域/范围/落点层过滤查找记忆,返回完整条目与所在文件。
 *
 * 定位用「扫描可见文件 + 迁移」的总是正确路径;catalog 是本模块维护的派生索引
 * (供未来 `memory-find` 工具快速查 id → 文件),`find` 不依赖它也能返回一致结果。
 * @param cwd - 当前工作目录;缺省只查内置 + 用户级。
 * @param query - 过滤条件(空条件返回全部)。
 * @returns 命中的记忆(按目录与文件排序)。
 */
export function find(cwd: string | undefined, query: FindQuery): FoundEntry[] {
  const results: FoundEntry[] = []
  for (const dir of visibleMemoryDirs(cwd)) {
    if (!existsSync(dir)) continue
    for (const file of loadDirMigrating(dir)) {
      for (const entry of file.entries) {
        if (matches(entry, query)) results.push({ entry, file: basename(file.jsonlPath) })
      }
    }
  }
  return results
}

/**
 * 重建全部可见层的 `catalog.json`:扫描所有可见 `.remember.jsonl`(顺带做旧数据
 * 迁移),以 jsonl 为准全量重写 catalog(不一致时 jsonl 权威)。手动编辑 jsonl 后的一键对齐。
 * @param cwd - 当前工作目录;缺省只重建内置 + 用户级。
 */
export function rebuild(cwd?: string): void {
  for (const dir of visibleMemoryDirs(cwd)) {
    if (!existsSync(dir)) continue
    writeCatalog(dir, loadDirMigrating(dir))
  }
}

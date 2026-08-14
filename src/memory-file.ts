/**
 * 记忆文件的发现、读取与写入(纯 node 层,不 import cordis)。
 *
 * 目录优先级(低 → 高,同名 basename 后者覆盖):
 *   内置(包内 `memory/`) < 用户 `~/.agents/memory` < 用户 `~/.dsh/memory`
 *   < 项目 `<repo>/.agents/memory` < 项目 `<repo>/.dsh/memory`
 *
 * 真相源是 `.remember.jsonl`;每次写 jsonl 后用纯函数渲染同名 `.remember.md`
 * 并通过 Markdown 静态检查,检查不通过拒绝写盘。MD 永不解析、只生成。
 *
 * @module dsh-memory/memory-file
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntry } from './schema.js'
import type { MemoryEntry, MemoryType } from './schema.js'
import { renderMd } from './render.js'
import { checkMarkdown } from './check.js'

/** 内置记忆目录(包内 `memory/`);无内容时不存在,发现时跳过。 */
const BUILTIN_MEMORY_DIR = fileURLToPath(new URL('../memory', import.meta.url))

/** dsh home 环境变量覆盖(默认 `~/.dsh`)。 */
const DSH_HOME_ENV = 'DSH_HOME'

/** agents home 环境变量覆盖(默认 `~/.agents`)。 */
const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/** 解析 dsh home。 */
function dshHome(): string {
  const fromEnv = process.env[DSH_HOME_ENV]
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/** 解析 agents home。 */
function agentsHome(): string {
  const fromEnv = process.env[AGENTS_HOME_ENV]
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.agents'))
}

/** 从 cwd 向上找项目根(以 `.git` 为标记),找不到则回退 cwd 本身。 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/** 一个记忆文件(真相源 jsonl 与其渲染投影 md,同 basename 配对)。 */
export interface MemoryFile {
  /** `.remember.jsonl` 路径。 */
  readonly jsonlPath: string
  /** 同名 `.remember.md` 路径。 */
  readonly mdPath: string
  /** 该文件内的全部条目(逐行解析 + 校验)。 */
  readonly entries: readonly MemoryEntry[]
}

/** 用户级写根与项目级写根。 */
export interface MemoryWriteRoots {
  /** 用户级写根(`~/.dsh/memory`)。 */
  readonly user: string
  /** 项目级写根(`<repo>/.dsh/memory`)。 */
  readonly project: string
}

/** 解析写根(dsh 规范目录优先)。 */
export function memoryWriteRoots(cwd: string): MemoryWriteRoots {
  return {
    user: join(dshHome(), 'memory'),
    project: join(findProjectRoot(cwd), '.dsh', 'memory'),
  }
}

/** 由 `entry.layer` 选写根:project → 项目写根,否则用户写根。 */
function writeRootFor(cwd: string, layer: MemoryEntry['layer']): string {
  const roots = memoryWriteRoots(cwd)
  return layer === 'project' ? roots.project : roots.user
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

/** 读取一个 jsonl 文件并逐行解析;文件不存在返回空。 */
function readJsonl(jsonlPath: string): MemoryEntry[] {
  if (!existsSync(jsonlPath)) return []
  const text = readFileSync(jsonlPath, 'utf8')
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => parseEntry(line, index + 1))
}

/** 按确定性字段顺序序列化一条记忆。 */
function serializeEntry(entry: MemoryEntry): string {
  return JSON.stringify({
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
 * 追加一条记忆到对应类型的当天文件,并重渲染同名 MD。
 *
 * 写入前由调用方负责「rules 只增不减」的重复检查;本函数不改现有语义。
 * @param cwd - 当前工作目录(用于选写根)。
 * @param entry - 已校验并归一化的记忆条目。
 * @returns 落盘的 jsonl / md 路径。
 */
export function appendEntry(cwd: string, entry: MemoryEntry): { jsonlPath: string; mdPath: string } {
  const dir = writeRootFor(cwd, entry.layer)
  const { jsonlPath, mdPath } = todayPaths(dir, entry.type)
  const existing = readJsonl(jsonlPath)
  writeFilePair(jsonlPath, mdPath, [...existing, entry])
  return { jsonlPath, mdPath }
}

/** 从给定目录按类型读取所有 jsonl 文件(按路径排序)。 */
function loadDir(dir: string): MemoryFile[] {
  if (!existsSync(dir)) return []
  const files: MemoryFile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.remember.jsonl')) continue
    const jsonlPath = join(dir, entry.name)
    const mdPath = jsonlPath.replace(/\.jsonl$/, '.md')
    files.push({ jsonlPath, mdPath, entries: readJsonl(jsonlPath) })
  }
  return files.sort((a, b) => (a.jsonlPath < b.jsonlPath ? -1 : a.jsonlPath > b.jsonlPath ? 1 : 0))
}

/**
 * 发现给定 cwd 可见的全部记忆文件(内置 + 用户 + 项目),按 basename 合并,
 * 同名后者覆盖(项目 > 用户 > 内置;同级 `.dsh` > `.agents`)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级。
 * @returns 归一化后的记忆文件列表。
 */
export function discoverFiles(cwd?: string): MemoryFile[] {
  const root = cwd === undefined ? '' : findProjectRoot(cwd)
  const dirs = [
    BUILTIN_MEMORY_DIR,
    join(agentsHome(), 'memory'),
    join(dshHome(), 'memory'),
    ...(root === '' ? [] : [join(root, '.agents', 'memory'), join(root, '.dsh', 'memory')]),
  ]
  const byBasename = new Map<string, MemoryFile>()
  for (const dir of dirs) {
    for (const file of loadDir(dir)) {
      const basename = file.jsonlPath.split(/[\\/]/).pop()!
      byBasename.set(basename, file)
    }
  }
  return [...byBasename.values()].sort((a, b) => (a.jsonlPath < b.jsonlPath ? -1 : a.jsonlPath > b.jsonlPath ? 1 : 0))
}

/** 发现给定 cwd 可见的全部记忆条目(按文件排序后展平)。 */
export function discoverEntries(cwd?: string): MemoryEntry[] {
  return discoverFiles(cwd).flatMap(file => [...file.entries])
}

/**
 * 删除精确匹配 `entry` 文本的条目(可限定类型),并重渲染受影响文件的 MD。
 * @param cwd - 当前工作目录。
 * @param entryText - 精确匹配的条目文本。
 * @param type - 可选类型过滤;缺省匹配全部类型。
 * @returns 实际删除的条目数。
 */
export function forget(cwd: string, entryText: string, type?: MemoryType): number {
  let removed = 0
  for (const file of discoverFiles(cwd)) {
    const remaining = file.entries.filter(entry =>
      entry.entry !== entryText || (type !== undefined && entry.type !== type))
    if (remaining.length === file.entries.length) continue
    writeFilePair(file.jsonlPath, file.mdPath, remaining)
    removed += file.entries.length - remaining.length
  }
  return removed
}

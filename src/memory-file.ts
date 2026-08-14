/**
 * 记忆文件的发现与读取(纯 node 层,不 import cordis)。
 *
 * 目录优先级(低 → 高,同名 basename 后者覆盖):
 *   内置(包内 `memory/`) < 用户 `~/.agents/memory` < 用户 `~/.dsh/memory`
 *   < 项目 `<repo>/.agents/memory` < 项目 `<repo>/.dsh/memory`
 *
 * 真相源是 `.remember.jsonl`;本模块只做「发现 + 读取」,写盘(追加 / 重写 / 渲染
 * MD / 更新 catalog)统一由 {@link ./store.js} 承载,避免两套独立写路径并存。读取时
 * 对旧数据做「读即迁移 + 落盘」(补 id/schemaVersion 写回 jsonl,见 {@link ./migrate.js}),
 * 保证只读层读旧数据不失败、且补出的 id 跨次读取稳定。
 *
 * @module dsh-memory/memory-file
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonlMigrating } from './migrate.js'
import type { MemoryEntry } from './schema.js'
import { parseRecallLine } from './team.js'

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

/**
 * 由 `entry.layer` 选写根目录:project → 项目写根,否则用户写根(global / user 都落用户根)。
 * @param cwd - 当前工作目录(用于解析写根)。
 * @param layer - 记忆落点层。
 * @returns 写根目录绝对路径。
 */
export function writeRootFor(cwd: string, layer: MemoryEntry['layer']): string {
  const roots = memoryWriteRoots(cwd)
  return layer === 'project' ? roots.project : roots.user
}

/**
 * 给定 cwd 可见的全部记忆目录(低 → 高优先级,与发现合并顺序一致)。
 * @param cwd - 当前工作目录;缺省只返回内置 + 用户级目录。
 * @returns 可见记忆目录绝对路径列表。
 */
export function visibleMemoryDirs(cwd?: string): string[] {
  const root = cwd === undefined ? '' : findProjectRoot(cwd)
  return [
    BUILTIN_MEMORY_DIR,
    join(agentsHome(), 'memory'),
    join(dshHome(), 'memory'),
    ...(root === '' ? [] : [join(root, '.agents', 'memory'), join(root, '.dsh', 'memory')]),
  ]
}

/** 读取一个 jsonl 文件并逐行解析(读即迁移,顺带补 id/schemaVersion 并落盘);文件不存在返回空。 */
function readJsonl(jsonlPath: string): MemoryEntry[] {
  return readJsonlMigrating(jsonlPath).entries
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
  const byBasename = new Map<string, MemoryFile>()
  for (const dir of visibleMemoryDirs(cwd)) {
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

/** 召回结果的一条完整投影:条目全部字段 + 所在文件。 */
export interface RecalledEntry {
  /** 记忆 id;逆查失败时降级为 `-`。 */
  readonly id: string
  /** 所在 `.remember.jsonl` 文件名;逆查失败时降级为 `-`。 */
  readonly file: string
  readonly type: string
  readonly domain: string
  readonly scope: string
  readonly layer: string
  readonly entry: string
  readonly entryPoint: string
  readonly references: string
}

/** 逆查失败的降级行(行内可解析的字段保留,真相源字段以 `-` 占位)。 */
function degradedEntry(line: ReturnType<typeof parseRecallLine>): RecalledEntry {
  return {
    id: line.id ?? '-',
    file: '-',
    type: line.type ?? '-',
    domain: line.domain ?? '-',
    scope: line.scope ?? '-',
    layer: '-',
    entry: line.entry,
    entryPoint: '-',
    references: '-',
  }
}

/**
 * 把召回返回的整行(格式见 render.entryLine)按 id 逆查真相源,补全全部字段。
 *
 * 召回在节点文本(索引)上做,`layer` / `entryPoint` / `references` 只在真相源
 * (jsonl)里;逆查 = 索引 → 真相源的回填。id 唯一,命中即完整字段;模型未照抄
 * 整行(id 缺失/伪造)时降级为行内字段 + `-` 占位,不丢结果。
 * @param cwd - 当前工作目录(与召回时一致)。
 * @param lines - 召回/重排序输出的整行列表。
 * @returns 完整条目投影(与 lines 同序)。
 */
export function resolveRecalled(cwd: string | undefined, lines: readonly string[]): RecalledEntry[] {
  const byId = new Map<string, { entry: MemoryEntry; file: string }>()
  for (const file of discoverFiles(cwd)) {
    for (const entry of file.entries) {
      byId.set(entry.id, { entry, file: file.jsonlPath.split(/[\\/]/).pop()! })
    }
  }
  return lines.map((line) => {
    const parsed = parseRecallLine(line)
    const hit = parsed.id === undefined ? undefined : byId.get(parsed.id)
    if (hit === undefined) return degradedEntry(parsed)
    return {
      id: hit.entry.id,
      file: hit.file,
      type: hit.entry.type,
      domain: hit.entry.domain,
      scope: hit.entry.scope,
      layer: hit.entry.layer,
      entry: hit.entry.entry,
      entryPoint: hit.entry.entryPoint,
      references: hit.entry.references,
    }
  })
}

/**
 * 记忆文件的发现与读取(纯 node 层,不 import cordis)。
 *
 * 目录优先级(低 → 高,同名 basename 后者覆盖):
 *   内置(包内 `memory/`) < 用户 `~/.agents/memory` < 用户 `~/.dsh/memory`
 *   < 项目 `<repo>/.agents/memory` < 项目 `<repo>/.dsh/memory`
 *
 * 真相源是 `.remember.jsonl`;本模块只做「发现 + 读取」,写盘(追加 / 重写 / 渲染
 * MD / 更新 catalog / 旧数据迁移)统一由 {@link ./store.js} 承载,避免两套独立写路径并存。
 *
 * @module dsh-memory/memory-file
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntry } from './schema.js'
import type { MemoryEntry } from './schema.js'

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

/** 读取一个 jsonl 文件并逐行解析;文件不存在返回空。 */
function readJsonl(jsonlPath: string): MemoryEntry[] {
  if (!existsSync(jsonlPath)) return []
  const text = readFileSync(jsonlPath, 'utf8')
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, index) => parseEntry(line, index + 1))
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

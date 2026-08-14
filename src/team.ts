/**
 * v4-flash 记忆节点 team 的纯逻辑:节点分区、fan-out 召回、聚合。
 *
 * 本模块只定义结构与时序,不 import cordis,也不 import dsh-llm——模型调用
 * 以函数参数注入(`recallFn` / `rerank`),由 `index.ts` 用 `ctx.llm.stream`
 * 绑定到 `deepseek-v4-flash`。这样预热 / 分区 / 聚合都能在单测里用 mock
 * 验证,而无需真实 API key。
 *
 * @module dsh-memory/team
 */

/** 每节点容量上限换算:1 Kb = 1024 字节。 */
const KB = 1024

/** 一个已就绪的记忆节点:一段受管记忆文本 + 它的大小。 */
export interface MemoryNode {
  /** 稳定节点 id(如 `node-1`)。 */
  readonly id: string
  /** 该节点记忆文本的字节数。 */
  readonly sizeBytes: number
  /** 该节点负责的记忆文本(供模型挑选相关条目)。 */
  readonly text: string
}

/** 已预热、可立即 fan-out 的节点 team。 */
export interface RecallTeam {
  /** 分配后的节点(数量 = ceil(总大小 / 每节点容量))。 */
  readonly nodes: readonly MemoryNode[]
  /** 每节点容量上限(字节)。 */
  readonly maxNodeBytes: number
}

/** 一次 fan-out 中单个节点返回的候选条目文本(逐条一行,精确匹配)。 */
export type NodeRecallFn = (node: MemoryNode, query: string) => Promise<readonly string[]>

/** 聚合阶段对去重后的候选按相关度重排序(仅返回排序后的条目文本)。 */
export type RerankFn = (query: string, candidates: readonly string[]) => Promise<readonly string[]>

/** 一段待分配进节点的记忆源文本。 */
export interface MemorySource {
  /** 源标识(用于诊断)。 */
  readonly id: string
  /** 文本内容。 */
  readonly text: string
}

/** 计算一段文本的字节大小(Node 的 UTF-8 语义)。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 把多段记忆源按容量贪心打包成节点:累加到接近 `maxNodeKb` 即封口。
 * 单段超过容量的源独占一个节点(允许该节点超容量)。
 * @param sources - 待分配的记忆源。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 分区后的节点。
 */
export function partitionNodes(sources: readonly MemorySource[], maxNodeKb: number): MemoryNode[] {
  const maxBytes = maxNodeKb * KB
  const nodes: MemoryNode[] = []
  let current: MemorySource[] = []
  let currentBytes = 0

  const flush = (): void => {
    if (current.length === 0) return
    nodes.push(makeNode(nodes.length + 1, current, currentBytes))
    current = []
    currentBytes = 0
  }

  for (const source of sources) {
    const size = byteLength(source.text)
    // 已有内容 + 新源会超容量(且已有内容非空)→ 封口后另起一节点。
    if (current.length > 0 && currentBytes + size > maxBytes) flush()
    current.push(source)
    currentBytes += size
    // 单源独占节点:加入后若当前节点仅含该源且超过容量,立即封口。
    if (current.length === 1 && size > maxBytes) flush()
  }
  flush()

  return nodes
}

function makeNode(id: number, sources: readonly MemorySource[], sizeBytes: number): MemoryNode {
  return {
    id: `node-${id}`,
    sizeBytes,
    text: sources.map(source => source.text).join('\n\n'),
  }
}

/** 按条目文本精确去重(保持首次出现顺序)。 */
export function dedupe(candidates: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    const key = candidate.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result
}

/**
 * 预热:把记忆源分配成节点 team(纯函数,不碰磁盘、不碰模型)。
 * @param sources - 全部记忆源(来自记忆文件)。
 * @param maxNodeKb - 每节点容量上限(单位 Kb)。
 * @returns 就绪 team。
 */
export function warmUp(sources: readonly MemorySource[], maxNodeKb: number): RecallTeam {
  return { nodes: partitionNodes(sources, maxNodeKb), maxNodeBytes: maxNodeKb * KB }
}

/**
 * 召回:并发 fan-out 到每个节点 → 汇总 → 去重 → 重排序 → 截断到 topK。
 * @param team - 已预热 team。
 * @param query - 召回查询。
 * @param recallFn - 单节点召回调用器(模型调用注入)。
 * @param rerank - 重排序调用器(模型调用注入;候选 ≤1 时跳过)。
 * @param topK - 返回的最大条目数。
 * @returns 按相关度排序、去重后的条目文本(≤ topK)。
 */
export async function recall(
  team: RecallTeam,
  query: string,
  recallFn: NodeRecallFn,
  rerank: RerankFn,
  topK: number,
): Promise<string[]> {
  const fanOut = await Promise.all(team.nodes.map(node => recallFn(node, query)))
  const candidates = dedupe(fanOut.flat())
  if (candidates.length === 0) return []
  const ordered = candidates.length <= 1 ? candidates : await rerank(query, candidates)
  return ordered.slice(0, Math.max(0, topK))
}

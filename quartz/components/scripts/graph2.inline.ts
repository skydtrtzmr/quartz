import type { ContentDetails } from "../../plugins/emitters/contentIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceRadial,
  zoomIdentity,
  select,
  drag,
  zoom,
} from "d3"
import { Text, Graphics, Application, Container, Circle } from "pixi.js"
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import { registerEscapeHandler, removeAllChildren } from "./util"
import { FullSlug, SimpleSlug, getFullSlug, resolveRelative, simplifySlug } from "../../util/path"
import { D3Config, FieldAggregation } from "../Graph"

// ============ Singleton 守护 ============
// inline 脚本在每次 SPA 导航后都会重新执行，用模块级标志防止重复初始化
let initialized = false
if (initialized) {
  // 脚本重复执行，直接退出
  console.log("graph2.inline.ts: initialized 已初始化，直接退出")

  // @ts-ignore - early return at module level via throw-trick not needed; the if block handles it
} else {
  initialized = true
  console.log("graph2.inline.ts: 初始化")
  console.debug("[Graph] Initializing singleton graph script.")
  main()
}

// ============ 类型定义 ============
interface LocalGraphData {
  version: number
  center: SimpleSlug
  depth: number
  generatedAt: number
  nodes: Record<SimpleSlug, ContentDetails>
  edges: Array<{ source: SimpleSlug; target: SimpleSlug; sourceField?: string }>
}

// ============ Local Graph 缓存模块（供 graph2 和 Backlinks 共享）============
//
// 设计目标：确保同一 slug 的 local graph JSON 只发起一次网络请求
//
// 工作原理 - Promise 缓存模式：
// 1. 使用 Map 缓存 fetch Promise，key = `${basePath}:${fullSlug}`
// 2. 首次调用 fetchCachedLocalGraph() 时：
//    - 检查缓存，发现没有 → 创建新的 Promise（此时 fetch 开始）
//    - 将 Promise 存入缓存 → 返回 Promise
// 3. 后续调用时：
//    - 检查缓存，发现已有 → 直接返回缓存的 Promise（不重复创建，不重复 fetch）
//
// 执行顺序无关性：
// - 无论 graph2.inline.ts（局部图谱）还是 Backlinks（反向链接）先调用
// - Promise 被创建时，async 函数体会立即执行到第一个 await（即 fetch 开始）
// - 后续调用返回的是同一个 Promise，网络请求只有一次
//
// SPA 导航兼容性：
// - 页面导航会重新执行 graph2.inline.ts（singleton 守护确保单次执行）
// - 模块级的 localGraphPromiseCache 在页面刷新时会重新初始化
// - 因此每次导航到新页面都会获取最新的 local graph 数据
//
// 对比 contentIndex 的 fetchData：
// - fetchData 没有 TTL，导航后不重新 fetch（适合静态数据）
// - localGraph 缓存随页面刷新重置（适合每页独立的数据）
//
declare global {
  interface Window {
    __localGraphCache: {
      fetch: (fullSlug: string, basePath: string) => Promise<any | null>
    }
  }
}

// Promise 缓存：key -> Promise<data>
const localGraphPromiseCache = new Map<string, Promise<any | null>>()

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function fetchCachedLocalGraph(fullSlug: string, basePath: string): Promise<any | null> {
  const cacheKey = `${basePath}:${fullSlug}`

  // 检查 Promise 缓存 - 命中则直接返回已有 Promise
  if (localGraphPromiseCache.has(cacheKey)) {
    console.log("[LocalGraph Cache] 使用缓存 Promise:", cacheKey)
    return localGraphPromiseCache.get(cacheKey)!
  }

  // 创建新的 fetch Promise 并缓存
  // 注意：async IIFE 被调用时函数体立即执行，fetch 请求从这里开始
  const fetchPromise = (async () => {
    const hash = await sha256(fullSlug)
    const dir1 = hash.slice(0, 2)
    const dir2 = hash.slice(2, 4)
    const localGraphPath = basePath
      ? `/${basePath}/graph/local/${dir1}/${dir2}/${encodeURIComponent(fullSlug)}.json`
      : `/graph/local/${dir1}/${dir2}/${encodeURIComponent(fullSlug)}.json`

    try {
      console.log("[LocalGraph Cache] Fetch:", localGraphPath)
      const response = await fetch(localGraphPath)
      if (!response.ok) {
        console.log("[LocalGraph Cache] Fetch failed:", response.status)
        return null
      }
      const data = await response.json()
      console.log("[LocalGraph Cache] Fetch success:", cacheKey)
      return data
    } catch (e) {
      console.log("[LocalGraph Cache] Fetch error:", e)
      return null
    }
  })()

  localGraphPromiseCache.set(cacheKey, fetchPromise)
  return fetchPromise
}

// 暴露给全局，让 Backlinks runtime 脚本可以使用共享缓存
window.__localGraphCache = {
  fetch: fetchCachedLocalGraph,
}

function main() {
  // ============ 世代计数器（竞态保护）============
  // 每次新的导航都会递增世代，旧的异步渲染检测到世代变化后自我废弃
  let renderGeneration = 0

  function checkGeneration(gen: number): boolean {
    return gen === renderGeneration
  }

  // ============ basePath（多域名支持）============
  let basePath = ""

  // ============ 类型定义 ============
  type GraphicsInfo = {
    color: string
    gfx: Graphics
    alpha: number
    active: boolean
  }

  type NodeData = {
    id: SimpleSlug
    text: string
    tags: string[]
    isCore?: boolean
    isExpanded?: boolean
    edgeNodeCount?: number
    isAggregation?: boolean
    /** 聚合节点收起时的碰撞半径（基于子节点数量） */
    aggCollapsedRadius?: number
    /** 聚合节点展开后的碰撞半径 */
    aggExpandedRadius?: number
    /** 聚合节点包含的子节点数量 */
    aggChildCount?: number
    /** 聚合节点展开后，子节点相对于聚合中心的目标偏移（用于 tick 强约束） */
    aggTargetOffset?: { x: number; y: number }
  } & SimulationNodeDatum

  type SimpleLinkData = {
    source: SimpleSlug
    target: SimpleSlug
    sourceField?: string
  }

  type LinkData = {
    source: NodeData
    target: NodeData
    sourceField?: string
  } & SimulationLinkDatum<NodeData>

  type LinkRenderData = GraphicsInfo & {
    simulationData: LinkData
    label?: Text
    /** 是否为聚合边（聚合节点→核心节点） */
    isAggregation?: boolean
  }

  type NodeRenderData = GraphicsInfo & {
    simulationData: NodeData
    label: Text
    badge?: Graphics
    badgeText?: Text
    /** 节点中心显示的直接关联数量（全局图谱核心节点） */
    countLabel?: Text
    /** 是否为聚合节点 */
    isAggregation?: boolean
    /** 聚合节点展开后的背景圆圈 */
    aggBg?: Graphics
    /** 聚合节点展开后的半径 */
    aggExpandedRadius?: number
  }

  type TweenNode = {
    update: (time: number) => void
    stop: () => void
  }

  const DOUBLE_CLICK_DELAY = 300

  // ============ 对象池（复用 Graphics/Text，减少 GC 和 GPU 碎片）============
  class ObjectPool<T> {
    private pool: T[] = []
    private createFn: () => T
    private resetFn: (obj: T) => void

    constructor(createFn: () => T, resetFn: (obj: T) => void) {
      this.createFn = createFn
      this.resetFn = resetFn
    }

    acquire(): T {
      return this.pool.length > 0 ? this.pool.pop()! : this.createFn()
    }

    release(obj: T): void {
      this.resetFn(obj)
      this.pool.push(obj)
    }

    clear(): void {
      for (const obj of this.pool) {
        this.resetFn(obj)
        if (typeof (obj as any).destroy === "function") {
          ;(obj as any).destroy({ children: true, texture: true, baseTexture: true })
        }
      }
      this.pool = []
    }
  }

  // ============ visited 记录 ============
  const localStorageKey = "graph-visited"
  function getVisited(): Set<SimpleSlug> {
    return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? "[]"))
  }

  function addToVisited(slug: SimpleSlug) {
    const visited = getVisited()
    visited.add(slug)
    localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
  }

  // ============ 预加载 fetchData（让数据在后台并行下载）============
  let fetchDataStarted = false
  function ensureFetchData() {
    if (fetchDataStarted) return
    fetchDataStarted = true
    console.log("[Graph] 预加载 fetchData 开始")
    fetchData
      .then(() => {
        console.log("[Graph] 预加载 fetchData 完成")
      })
      .catch((err) => {
        console.error("[Graph] 预加载 fetchData 失败:", err)
      })
  }

  // ============ 渲染核心函数 ============
  async function renderGraph(
    graph: HTMLElement,
    fullSlug: FullSlug,
    generation: number,
  ): Promise<() => void> {
    console.log("[renderGraph] start")
    const slug = simplifySlug(fullSlug)
    const visited = getVisited()
    removeAllChildren(graph)

    if (!checkGeneration(generation)) return () => {}

    let {
      drag: enableDrag,
      zoom: enableZoom,
      depth,
      scale,
      repelForce,
      centerForce,
      linkDistance,
      fontSize,
      opacityScale,
      removeTags,
      showTags,
      focusOnHover,
      enableRadial,
      showArrows = true,
      showBadge = false,
      filterOrphans = false,
      startCollapsed = false,
      countLabelMaxDisplay = 99,
      aggregation,
    } = JSON.parse(graph.dataset["cfg"]!) as D3Config

    basePath = graph.dataset.basepath || ""

    // 从 data-precompute-depth 获取预计算深度（统一配置，与 graphLocal.tsx 使用相同的 cfg.graph.localDepth）
    const precomputeDepth = parseInt(graph.dataset["precomputeDepth"] ?? "1")

    const usePrecomputed = depth > 0 && depth <= precomputeDepth

    // 优化：如果是局部图谱且使用预计算，先尝试加载预计算 JSON
    // 如果成功，直接使用预计算数据，跳过 fetchData 和 BFS
    let localGraphData: LocalGraphData | null = null
    let data: Map<SimpleSlug, ContentDetails> | null = null

    if (usePrecomputed) {
      console.log("[Graph] ===== ATTEMPTING TO LOAD LOCAL GRAPH JSON (priority) =====")
      try {
        if (!checkGeneration(generation)) return () => {}
        const pdata = await fetchCachedLocalGraph(fullSlug, basePath)
        if (!checkGeneration(generation)) return () => {}
        if (pdata && (pdata as any).depth >= depth) {
          localGraphData = pdata as LocalGraphData
          const nodeCount = Object.keys(localGraphData.nodes).length
          console.log(
            `[Graph] ===== SUCCESS: Loaded local JSON with ${nodeCount} nodes, ${localGraphData.edges.length} edges =====`,
          )
          console.log("[Graph] ===== SKIPPING fetchData (using precomputed data) =====")
        } else if (pdata) {
          console.log(
            `[Graph] Local JSON depth (${(pdata as any).depth}) < required (${depth}), will use fetchData + BFS`,
          )
        } else {
          console.log("[Graph] Local JSON not found, will use fetchData + BFS")
        }
      } catch (e) {
        console.log("[Graph] Error fetching local JSON:", e, "- will use fetchData + BFS")
      }
    }

    // 如果预计算不可用或不需要，使用 fetchData + BFS/全局
    if (!localGraphData) {
      if (!checkGeneration(generation)) return () => {}
      console.log("[DEBUG] 开始等待 fetchData")
      data = new Map(
        Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
          simplifySlug(k as FullSlug),
          v,
        ]),
      )
      console.log("[DEBUG] fetchData 完成，数据条目数:", data.size)
      if (!checkGeneration(generation)) return () => {}
    } else {
      // 预计算成功时，从 localGraphData.nodes 构建 graphData
      // 这样后续代码可以直接使用 graphData 而无需修改
      console.log("[Graph] ===== BUILDING graphData FROM PRECOMPUTED =====")
      data = new Map(Object.entries(localGraphData.nodes) as [SimpleSlug, ContentDetails][])
    }

    // 确保 data 已定义（TypeScript 智能推断）
    const contentData = data!

    if (!checkGeneration(generation)) return () => {}

    // ===== 动态虚拟节点计算 =====
    const virtualNodes = new Set<SimpleSlug>()
    const allExistingSlugs = new Set(contentData.keys())
    const allTagSlugs = new Set<SimpleSlug>()

    for (const [, details] of contentData.entries()) {
      for (const tag of details.tags ?? []) {
        allTagSlugs.add(simplifySlug(("tags/" + tag) as FullSlug))
      }
    }
    for (const [, details] of contentData.entries()) {
      for (const link of details.links ?? []) {
        if (!allExistingSlugs.has(link) && !allTagSlugs.has(link) && !link.startsWith("tags/")) {
          virtualNodes.add(link)
        }
      }
    }
    console.log("[DEBUG] 动态计算虚拟节点完成，数量:", virtualNodes.size)

    // ===== 构建链接图 =====
    const links: SimpleLinkData[] = []
    const tags: SimpleSlug[] = []
    const validLinks = new Set(contentData.keys())
    for (const v of virtualNodes) validLinks.add(v)

    function getFrontmatterFieldForLink(frontmatter: any, targetLink: string): string | undefined {
      if (!frontmatter) return undefined
      for (const [key, value] of Object.entries(frontmatter)) {
        if (typeof value === "string" && value.includes("[[" + targetLink + "]]")) {
          return key
        }
        if (typeof value === "string" && value.includes("[[")) {
          const match = value.match(/\[\[\.?\.?\/?([^\]|#]+)/)
          if (match) {
            const normalizedTarget = match[1].replace(/^\.\//, "").replace(/^\//, "")
            if (normalizedTarget === targetLink || targetLink.endsWith(normalizedTarget)) {
              return key
            }
          }
        }
      }
      return undefined
    }

    const isGlobalGraph = depth < 0
    const neighbourhood = new Set<SimpleSlug>()

    if (!isGlobalGraph) {
      if (localGraphData) {
        console.log(
          `[Graph] ===== USING PRECOMPUTED LOCAL JSON (depth: ${localGraphData.depth}) =====`,
        )
        const startTime = performance.now()
        // 使用预计算数据
        for (const [nodeSlug, nodeData] of Object.entries(localGraphData.nodes)) {
          neighbourhood.add(nodeSlug as SimpleSlug)
          if (!nodeData.filePath) virtualNodes.add(nodeSlug as SimpleSlug)
          if (nodeSlug.startsWith("tags/") && !tags.includes(nodeSlug as SimpleSlug)) {
            tags.push(nodeSlug as SimpleSlug)
          }
        }
        for (const edge of localGraphData.edges) {
          links.push({ source: edge.source, target: edge.target, sourceField: edge.sourceField })
        }
        const endTime = performance.now()
        console.log(
          `[Graph] Precomputed JSON rendered: ${neighbourhood.size} nodes, ${links.length} edges in ${(endTime - startTime).toFixed(2)}ms`,
        )
      } else {
        console.log(`[Graph] ===== USING CONTENTINDEX BFS (depth: ${depth}) =====`)
        const startTime = performance.now()
        // 回退到 BFS（带深度限制，双向扩展）
        const queue: Array<{ slug: SimpleSlug; depth: number }> = [{ slug, depth: 0 }]
        const visitedSet = new Set<SimpleSlug>()

        while (queue.length > 0) {
          const { slug: current, depth: currentDepth } = queue.shift()!
          if (visitedSet.has(current)) continue
          visitedSet.add(current)
          neighbourhood.add(current)
          if (currentDepth >= depth) continue

          const currentData = contentData.get(current)
          if (currentData) {
            for (const dest of currentData.links ?? []) {
              if (validLinks.has(dest)) {
                const sourceField = getFrontmatterFieldForLink(
                  (currentData as any).frontmatter,
                  dest,
                )
                links.push({ source: current, target: dest, sourceField })
                queue.push({ slug: dest, depth: currentDepth + 1 })
              }
            }
            if (showTags) {
              const localTags = (currentData.tags ?? [])
                .filter((tag) => !removeTags.includes(tag))
                .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))
              for (const tag of localTags) {
                if (!tags.includes(tag)) tags.push(tag)
                links.push({ source: current, target: tag })
                neighbourhood.add(tag)
              }
            }
            for (const dest of currentData.links ?? []) {
              if (virtualNodes.has(dest)) {
                const sourceField = getFrontmatterFieldForLink(
                  (currentData as any).frontmatter,
                  dest,
                )
                links.push({ source: current, target: dest, sourceField })
                queue.push({ slug: dest, depth: currentDepth + 1 })
              }
            }
          }

          // 入链接
          for (const [source, details] of contentData.entries()) {
            if ((details.links ?? []).includes(current)) {
              const sourceField = getFrontmatterFieldForLink((details as any).frontmatter, current)
              links.push({ source, target: current, sourceField })
              queue.push({ slug: source, depth: currentDepth + 1 })
            }
          }
        }
        const endTime = performance.now()
        console.log(
          `[Graph] ContentIndex BFS rendered: ${neighbourhood.size} nodes, ${links.length} edges in ${(endTime - startTime).toFixed(2)}ms`,
        )
      }
    } else {
      console.log("[DEBUG] 全局图谱：使用完整链接图构建")
      const startTime = performance.now()
      // 全局图谱：完整链接图
      for (const [source, details] of contentData.entries()) {
        for (const dest of details.links ?? []) {
          if (validLinks.has(dest)) {
            const sourceField = getFrontmatterFieldForLink((details as any).frontmatter, dest)
            links.push({ source, target: dest, sourceField })
          }
        }
        if (showTags) {
          const localTags = (details.tags ?? [])
            .filter((tag) => !removeTags.includes(tag))
            .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))
          tags.push(...localTags.filter((tag) => !tags.includes(tag)))
          for (const tag of localTags) links.push({ source, target: tag })
        }
      }
      for (const [source, details] of contentData.entries()) {
        for (const dest of details.links ?? []) {
          if (virtualNodes.has(dest)) {
            const sourceField = getFrontmatterFieldForLink((details as any).frontmatter, dest)
            links.push({ source, target: dest, sourceField })
          }
        }
      }
      validLinks.forEach((id) => neighbourhood.add(id))
      if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
      virtualNodes.forEach((v) => neighbourhood.add(v))
      const endTime = performance.now()
      console.log(
        `[DEBUG] 全局链接图构建完成 - 耗时: ${(endTime - startTime).toFixed(2)}ms, 节点数: ${neighbourhood.size}, 链接数: ${links.length}`,
      )
    }

    // ===== 节点和链接构建 =====
    const tweens = new Map<string, TweenNode>()

    const allNodes: NodeData[] = [...neighbourhood].map((url) => ({
      id: url,
      text: url.startsWith("tags/") ? "#" + url.substring(5) : (contentData.get(url)?.title ?? url),
      tags: contentData.get(url)?.tags ?? [],
      isCore: false,
    }))

    // 链接去重
    const linkKeySet = new Set<string>()
    const allLinks = links
      .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
      .filter((l) => {
        const key = `${l.source}->${l.target}`
        if (linkKeySet.has(key)) return false
        linkKeySet.add(key)
        return true
      })
      .map((l) => ({
        source: allNodes.find((n) => n.id === l.source)!,
        target: allNodes.find((n) => n.id === l.target)!,
        sourceField: l.sourceField,
      }))

    // 连接数统计
    const nodeLinkCount = new Map<string, number>()
    for (const l of allLinks) {
      nodeLinkCount.set(l.source.id, (nodeLinkCount.get(l.source.id) ?? 0) + 1)
      nodeLinkCount.set(l.target.id, (nodeLinkCount.get(l.target.id) ?? 0) + 1)
    }

    // 过滤孤儿节点
    const nonOrphanNodes = allNodes.filter((n) => (nodeLinkCount.get(n.id) ?? 0) > 0)
    const nonOrphanNodeIds = new Set(nonOrphanNodes.map((n) => n.id))
    const nonOrphanLinks = allLinks.filter(
      (l) => nonOrphanNodeIds.has(l.source.id) && nonOrphanNodeIds.has(l.target.id),
    )

    // 标记核心/边缘节点
    for (const n of nonOrphanNodes) {
      n.isCore = (nodeLinkCount.get(n.id) ?? 0) > 1
    }

    const edgeNodes = nonOrphanNodes.filter((n) => !n.isCore)
    const edgeNodeIds = new Set(edgeNodes.map((n) => n.id))

    // 构建核心节点 → 边缘节点的映射（用于全局图谱展开/收起）
    const nodeToEdgeNodes = new Map<SimpleSlug, NodeData[]>()
    const nodeToEdgeLinks = new Map<SimpleSlug, LinkData[]>()
    for (const l of nonOrphanLinks) {
      const srcIsEdge = edgeNodeIds.has(l.source.id)
      const tgtIsEdge = edgeNodeIds.has(l.target.id)
      if (srcIsEdge && !tgtIsEdge) {
        if (!nodeToEdgeNodes.has(l.target.id)) nodeToEdgeNodes.set(l.target.id, [])
        if (!nodeToEdgeNodes.get(l.target.id)!.some((n) => n.id === l.source.id))
          nodeToEdgeNodes.get(l.target.id)!.push(l.source)
        if (!nodeToEdgeLinks.has(l.target.id)) nodeToEdgeLinks.set(l.target.id, [])
        nodeToEdgeLinks.get(l.target.id)!.push(l)
      } else if (!srcIsEdge && tgtIsEdge) {
        if (!nodeToEdgeNodes.has(l.source.id)) nodeToEdgeNodes.set(l.source.id, [])
        if (!nodeToEdgeNodes.get(l.source.id)!.some((n) => n.id === l.target.id))
          nodeToEdgeNodes.get(l.source.id)!.push(l.target)
        if (!nodeToEdgeLinks.has(l.source.id)) nodeToEdgeLinks.set(l.source.id, [])
        nodeToEdgeLinks.get(l.source.id)!.push(l)
      }
    }
    for (const n of nonOrphanNodes) {
      // [FIX] edgeNodeCount 改为统计所有邻居节点（核心↔核心 + 核心↔边缘），
      // 以前只统计核心↔边缘（nodeToEdgeNodes），漏掉了核心节点之间的连接
      n.edgeNodeCount = nodeLinkCount.get(n.id) ?? 0
      n.isExpanded = false
    }

    // 可聚合边缘节点：仅与一个核心节点相连（单链接），避免多核心归属冲突
    const singleLinkEdgeNodes = edgeNodes.filter((n) => (nodeLinkCount.get(n.id) ?? 0) === 1)
    const singleLinkEdgeNodeIds = new Set(singleLinkEdgeNodes.map((n) => n.id))

    // ===== 边缘节点聚合 =====
    // 根据 aggregation.fields 配置，将边缘节点按字段值分组为聚合节点
    // 聚合节点作为核心节点的新"边缘邻居"替代散点边缘节点
    interface AggregationNodeInfo {
      node: NodeData
      coreId: SimpleSlug
      childNodes: NodeData[]
      childLinks: LinkData[]
      remainingFields: FieldAggregation[]
      currentField: string
    }
    const aggNodeInfoMap = new Map<SimpleSlug, AggregationNodeInfo>()
    const aggNodeToChildNodes = new Map<SimpleSlug, NodeData[]>()
    const aggNodeToChildLinks = new Map<SimpleSlug, LinkData[]>()
    // 聚合节点 ID → 所属核心节点 ID
    const aggToCoreMap = new Map<SimpleSlug, SimpleSlug>()

    const hasFolderAgg = aggregation?.folder && (aggregation.folder.depth === undefined || aggregation.folder.depth > 0)
    const hasFieldAgg = aggregation?.fields && aggregation.fields.length > 0

    if (hasFolderAgg || hasFieldAgg) {
      // 逐个核心节点，对其单链接叶节点聚合
      for (const [coreId, coreEdgeNodes] of nodeToEdgeNodes.entries()) {
        const singleLinkLeaves = coreEdgeNodes.filter((n) => singleLinkEdgeNodeIds.has(n.id))
        if (singleLinkLeaves.length <= 1) continue // 叶节点太少，无需聚合

        let leavesForFieldAgg = singleLinkLeaves

        // ===== 文件夹聚合 =====
        if (hasFolderAgg) {
          const folderGroupMap = new Map<string, NodeData[]>()
          for (const leaf of singleLinkLeaves) {
            const parts = String(leaf.id).split('/')
            const folderKey = parts.length > 1 ? parts[0] : '/'
            const group = folderGroupMap.get(folderKey) ?? []
            group.push(leaf)
            folderGroupMap.set(folderKey, group)
          }

          // 单文件夹跳过
          if (folderGroupMap.size > 1) {
            for (const [folderKey, childNodes] of folderGroupMap) {
              const displayKey = folderKey === '/' ? '📁 根目录' : `📁 ${folderKey}`
              const aggId = `agg:${coreId}:folder:${folderKey}` as SimpleSlug
              const collapsedR = Math.min(30, Math.max(16, 2 + Math.sqrt(childNodes.length)))
              const aggNode: NodeData = {
                id: aggId,
                text: displayKey,
                tags: [],
                isCore: false,
                isAggregation: true,
                edgeNodeCount: 0,
                aggCollapsedRadius: collapsedR,
                aggChildCount: childNodes.length,
              }

              const childLinkSet: LinkData[] = []
              const childLinkKeySet = new Set<string>()
              for (const l of nonOrphanLinks) {
                if (childNodes.some((cn) => cn.id === l.source.id || cn.id === l.target.id)) {
                  const key = `${l.source.id}->${l.target.id}`
                  if (!childLinkKeySet.has(key)) {
                    childLinkKeySet.add(key)
                    childLinkSet.push(l)
                  }
                }
              }

              aggToCoreMap.set(aggId, coreId)
              aggNodeToChildNodes.set(aggId, childNodes)
              aggNodeToChildLinks.set(aggId, childLinkSet)
              aggNodeInfoMap.set(aggId, {
                node: aggNode,
                coreId,
                childNodes,
                childLinks: childLinkSet,
                remainingFields: hasFieldAgg ? aggregation!.fields! : [],
                currentField: '📁',
              })
              nonOrphanNodes.push(aggNode)
            }
          }
        }

        // 过滤掉已被文件夹聚合的叶子
        const folderAggedIds = new Set<SimpleSlug>()
        for (const [, info] of aggNodeInfoMap.entries()) {
          if (info.coreId === coreId && info.currentField === '📁') {
            for (const cn of info.childNodes) folderAggedIds.add(cn.id)
          }
        }
        leavesForFieldAgg = singleLinkLeaves.filter((n) => !folderAggedIds.has(n.id))

        // ===== 字段聚合（对未被文件夹聚合的叶子）=====
        if (hasFieldAgg && leavesForFieldAgg.length > 1) {
          const fields = aggregation!.fields!
          // 动态查找第一个有效聚合字段
          let effectiveFieldIdx = -1
          let effectiveGroupMap: Map<string, NodeData[]> | null = null
          let effectiveFieldName = ""

          for (let i = 0; i < fields.length; i++) {
            const field = fields[i].field
            const granularity = fields[i].granularity
            const groupMap = new Map<string, NodeData[]>()
            let hasValidValue = false

            for (const leaf of leavesForFieldAgg) {
              const nodeDetails = contentData.get(leaf.id)
              let fieldValue: string | undefined

              if (nodeDetails) {
                if (field === "date") {
                  const dateStr = (nodeDetails as any).frontmatter?.date ?? (nodeDetails as any).date
                  if (dateStr) {
                    const d = new Date(dateStr)
                    if (!isNaN(d.getTime())) {
                      if (granularity === "year") fieldValue = `${d.getFullYear()}`
                      else if (granularity === "month") fieldValue = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
                      else if (granularity === "quarter") fieldValue = `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`
                    }
                  }
                } else {
                  const rawValue = (nodeDetails as any).frontmatter?.[field]
                  if (Array.isArray(rawValue)) {
                    for (const v of rawValue) {
                      if (v) {
                        hasValidValue = true
                        const group = groupMap.get(String(v)) ?? []
                        group.push(leaf)
                        groupMap.set(String(v), group)
                      }
                    }
                    continue
                  } else if (rawValue) {
                    fieldValue = String(rawValue)
                  }
                }
              }

              if (fieldValue) {
                hasValidValue = true
              }
              const key = fieldValue ?? "(无)"
              const group = groupMap.get(key) ?? []
              group.push(leaf)
              groupMap.set(key, group)
            }

            if (hasValidValue) {
              effectiveFieldIdx = i
              effectiveGroupMap = groupMap
              effectiveFieldName = field
              break
            }
          }

          if (effectiveFieldIdx < 0 || !effectiveGroupMap) continue

          // 为每个分组创建聚合节点（ID 包含核心节点，保证唯一）
          for (const [groupKey, childNodes] of effectiveGroupMap) {
            const aggId = `agg:${coreId}:${effectiveFieldName}:${groupKey}` as SimpleSlug
            // 收起半径：与核心节点 nodeRadius=2+√(linkCount) 一致的 sqrt 增长
            const collapsedR = Math.min(30, Math.max(16, 2 + Math.sqrt(childNodes.length)))
            const aggNode: NodeData = {
              id: aggId,
              text: groupKey,
              tags: [],
              isCore: false,
              isAggregation: true,
              edgeNodeCount: 0,
              aggCollapsedRadius: collapsedR,
              aggChildCount: childNodes.length,
            }

            // 收集子节点的所有边（仅限这些叶节点的原始边）
            const childLinkSet: LinkData[] = []
            const childLinkKeySet = new Set<string>()
            for (const l of nonOrphanLinks) {
              if (childNodes.some((cn) => cn.id === l.source.id || cn.id === l.target.id)) {
                const key = `${l.source.id}->${l.target.id}`
                if (!childLinkKeySet.has(key)) {
                  childLinkKeySet.add(key)
                  childLinkSet.push(l)
                }
              }
            }

            aggToCoreMap.set(aggId, coreId)
            aggNodeToChildNodes.set(aggId, childNodes)
            aggNodeToChildLinks.set(aggId, childLinkSet)
            aggNodeInfoMap.set(aggId, {
              node: aggNode,
              coreId,
              childNodes,
              childLinks: childLinkSet,
              remainingFields: fields.slice(effectiveFieldIdx + 1),
              currentField: effectiveFieldName,
            })
            nonOrphanNodes.push(aggNode)
          }
        }
      }

      // 更新 nodeToEdgeNodes / nodeToEdgeLinks：将原始叶节点替换为聚合节点
      const aggregatedChildIds = new Set<SimpleSlug>()
      for (const [coreId, oldEdgeNodes] of nodeToEdgeNodes.entries()) {
        const newEdgeNodes: NodeData[] = []
        const newEdgeLinks: LinkData[] = []
        const replacedAggIds = new Set<SimpleSlug>()

        for (const edgeNode of oldEdgeNodes) {
          if (aggregatedChildIds.has(edgeNode.id)) continue // 已被其他核心节点的聚合消费

          let foundAgg = false
          for (const [aggId, info] of aggNodeInfoMap.entries()) {
            if (info.coreId !== coreId) continue // 只处理属于当前核心节点的聚合
            if (info.childNodes.some((cn) => cn.id === edgeNode.id)) {
              if (!replacedAggIds.has(aggId)) {
                replacedAggIds.add(aggId)
                aggregatedChildIds.add(edgeNode.id)
                newEdgeNodes.push(info.node)
                newEdgeLinks.push({
                  source: info.node,
                  target: nonOrphanNodes.find((n) => n.id === coreId)!,
                  sourceField: info.currentField,
                })
              }
              foundAgg = true
              break
            }
          }
          if (!foundAgg) {
            newEdgeNodes.push(edgeNode)
            for (const l of nodeToEdgeLinks.get(coreId) ?? []) {
              if (l.source.id === edgeNode.id || l.target.id === edgeNode.id) {
                newEdgeLinks.push(l)
              }
            }
          }
        }

        nodeToEdgeNodes.set(coreId, newEdgeNodes)
        nodeToEdgeLinks.set(coreId, newEdgeLinks)
      }

      // 更新 edgeNodeCount（聚合节点只连接一个核心节点）
      for (const [aggId] of aggNodeInfoMap) {
        const aggNode = nonOrphanNodes.find((n) => n.id === aggId)
        if (aggNode) aggNode.edgeNodeCount = 1
      }

      console.log(
        `[Graph] 聚合完成：${aggNodeInfoMap.size} 个聚合节点，替代了 ${aggregatedChildIds.size} 个叶节点`,
      )
    }

    // 追踪展开的聚合节点与其子节点的映射，用于碰撞检测时跳过父子碰撞
    const expandedAggChildren = new Map<SimpleSlug, Set<SimpleSlug>>()

    function nodeRadius(d: NodeData) {
      if (d.aggExpandedRadius) return d.aggExpandedRadius
      if (d.aggCollapsedRadius) return d.aggCollapsedRadius
      const linkCount = nodeLinkCount.get(d.id) ?? 0
      // 标签节点：连接数通常很大，缩小整体半径
      if (d.id.startsWith("tags/")) {
        return 2 + Math.sqrt(linkCount) * 0.65
      }
      // 核心节点（连接数>1）最小半径更大，视觉上更突出
      const baseRadius = d.isCore ? 8 : 2
      return baseRadius + Math.sqrt(linkCount)
    }

    // 自定义碰撞力：展开的聚合节点与其子节点之间不进行碰撞检测
    // 注意：D3 力应修改 vx/vy 而非直接修改 x/y，由 simulation 统一应用速度衰减
    function createAggAwareCollide() {
      let nodes: NodeData[] = []

      function force(_alpha: number) {
        // 拖拽中跳过碰撞计算，避免残差速度导致抖动
        if (dragging) return
        for (let k = 0; k < 3; k++) {
          for (let i = 0; i < nodes.length; i++) {
            const ni = nodes[i]
            if (ni.x == null || ni.y == null) continue
            const ri = nodeRadius(ni) + 8

            for (let j = i + 1; j < nodes.length; j++) {
              const nj = nodes[j]
              if (nj.x == null || nj.y == null) continue

              // 跳过展开的聚合节点与其子节点之间的碰撞
              if (ni.aggExpandedRadius && expandedAggChildren.get(ni.id)?.has(nj.id)) continue
              if (nj.aggExpandedRadius && expandedAggChildren.get(nj.id)?.has(ni.id)) continue

              const rj = nodeRadius(nj) + 12
              let dx = ni.x - nj.x
              let dy = ni.y - nj.y
              let dist = Math.sqrt(dx * dx + dy * dy) || 1
              const minDist = ri + rj

              if (dist < minDist) {
                const push = (minDist - dist) / dist * 0.8
                ni.vx = (ni.vx ?? 0) + dx * push
                ni.vy = (ni.vy ?? 0) + dy * push
                nj.vx = (nj.vx ?? 0) - dx * push
                nj.vy = (nj.vy ?? 0) - dy * push
              }
            }
          }
        }
      }

      force.initialize = (n: NodeData[]) => {
        nodes = n
      }

      return force
    }

    // [CONFIG] 根据 filterOrphans / startCollapsed 决定初始渲染的节点集合
    const initialNodes = filterOrphans ? nonOrphanNodes : allNodes
    const initialLinks = filterOrphans ? nonOrphanLinks : allLinks

    let graphData: { nodes: NodeData[]; links: LinkData[] }
    if (isGlobalGraph && startCollapsed) {
      // 全局图谱默认收起：核心节点 + 聚合节点 + 它们之间的链接
      const visibleNodes = initialNodes.filter((n) => n.isCore || n.isAggregation)
      const visibleNodeIds = new Set(visibleNodes.map((n) => n.id))
      const visibleLinks = initialLinks.filter(
        (l) => visibleNodeIds.has(l.source.id) && visibleNodeIds.has(l.target.id),
      )
      // 添加聚合节点到核心节点的边
      for (const [aggId, info] of aggNodeInfoMap) {
        const coreId = aggToCoreMap.get(aggId)
        if (!coreId || !visibleNodeIds.has(coreId)) continue
        const exists = visibleLinks.some(
          (l) => (l.source.id === aggId && l.target.id === coreId) || (l.source.id === coreId && l.target.id === aggId),
        )
        if (!exists) {
          visibleLinks.push({
            source: info.node,
            target: visibleNodes.find((n) => n.id === coreId)!,
            sourceField: info.currentField,
          })
        }
      }
      graphData = { nodes: visibleNodes, links: visibleLinks }
    } else {
      // 局部图谱 / 非startCollapsed：过滤掉已被聚合的子节点，加入聚合节点
      // 收集所有被聚合的子节点 ID
      const aggregatedChildIds = new Set<string>()
      for (const [, info] of aggNodeInfoMap) {
        for (const child of info.childNodes) aggregatedChildIds.add(child.id)
      }
      // 过滤掉被聚合的子节点
      const filteredNodes = initialNodes.filter((n) => !aggregatedChildIds.has(n.id))
      // 过滤掉涉及被聚合子节点的链接
      const filteredLinks = initialLinks.filter(
        (l) => !aggregatedChildIds.has(l.source.id) && !aggregatedChildIds.has(l.target.id),
      )
      // 加入聚合节点和聚合链接
      const mergedNodes = [...filteredNodes]
      const mergedLinks = [...filteredLinks]
      const mergedNodeIds = new Set(mergedNodes.map((n) => n.id))
      for (const [aggId, info] of aggNodeInfoMap) {
        const coreId = aggToCoreMap.get(aggId)
        if (!coreId || !mergedNodeIds.has(coreId)) continue
        if (!mergedNodeIds.has(aggId)) mergedNodes.push(info.node)
        const coreNode = mergedNodes.find((n) => n.id === coreId)
        const exists = mergedLinks.some(
          (l) => (l.source.id === aggId && l.target.id === coreId) || (l.source.id === coreId && l.target.id === aggId),
        )
        if (!exists && coreNode) {
          mergedLinks.push({
            source: info.node,
            target: coreNode,
            sourceField: info.currentField,
          })
        }
      }
      graphData = { nodes: mergedNodes, links: mergedLinks }
    }

    const width = graph.offsetWidth
    const height = Math.max(graph.offsetHeight, 250)

    // ===== 检查点 3: Pixi 初始化前 =====
    if (!checkGeneration(generation)) return () => {}

    console.log("[DEBUG] 开始初始化 D3 simulation")
    const simulation: Simulation<NodeData, LinkData> = forceSimulation<NodeData>(graphData.nodes)
      .force("charge", forceManyBody().strength(-100 * repelForce))
      .force("center", forceCenter().strength(centerForce))
      .force("link", forceLink(graphData.links).distance(linkDistance))
      // [TUNING] collide 增加额外缓冲，长标题节点不易重叠
      .force("collide", createAggAwareCollide())

    const radius = (Math.min(width, height) / 2) * 0.8
    if (enableRadial) simulation.force("radial", forceRadial(radius).strength(0.2))

    // 局部图谱使用快速收敛参数
    if (!isGlobalGraph) {
      simulation.alphaMin(0.002).alphaDecay(0.05)
      console.log(
        `[DEBUG] 局部图谱：使用快速收敛参数 (alphaMin: ${simulation.alphaMin()}, alphaDecay: ${simulation.alphaDecay()})`,
      )
    } else {
      console.log(
        `[DEBUG] 全局图谱：使用默认收敛参数 (alphaMin: ${simulation.alphaMin()}, alphaDecay: ${simulation.alphaDecay()})`,
      )
    }

    simulation.on("end", () => {
      console.log("[DEBUG] D3 simulation 布局计算完成（已收敛）")
    })

    // 展开/拖拽后约束子节点不跑出聚合圆圈，以及约束聚合节点不溢出画布
    simulation.on("tick", () => {
      const halfW = width / 2
      const halfH = height / 2
      for (const [aggId, childIds] of expandedAggChildren) {
        const aggNode = graphData.nodes.find((n) => n.id === aggId)
        if (!aggNode || aggNode.x == null || aggNode.y == null || !aggNode.aggExpandedRadius) continue
        const cx = aggNode.x
        const cy = aggNode.y
        // 约束聚合节点本身不溢出画布（考虑展开半径）
        const expandedR = aggNode.aggExpandedRadius
        if (cx - expandedR < -halfW) aggNode.x = -halfW + expandedR
        if (cx + expandedR > halfW) aggNode.x = halfW - expandedR
        if (cy - expandedR < -halfH) aggNode.y = -halfH + expandedR
        if (cy + expandedR > halfH) aggNode.y = halfH - expandedR
        const boundR = expandedR * 0.85 // 留出边距，不让子节点贴着边界
        for (const childId of childIds) {
          const child = graphData.nodes.find((n) => n.id === childId)
          if (!child || child.x == null || child.y == null) continue

          // 强约束：将子节点固定到目标均匀分布位置（跟随聚合中心移动），
          // 抵消 forceManyBody / forceLink / collide 等外力导致的抖动和圆周聚集
          if (child.aggTargetOffset) {
            const targetX = cx + child.aggTargetOffset.x
            const targetY = cy + child.aggTargetOffset.y
            child.x = targetX
            child.y = targetY
          }

          // 兜底：确保子节点不超出聚合圆圈边界
          const dx = child.x - cx
          const dy = child.y - cy
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > boundR) {
            const scale = boundR / dist
            child.x = cx + dx * scale
            child.y = cy + dy * scale
          }
        }
      }
    })

    console.log("[DEBUG] D3 simulation 初始化完成，开始计算布局")

    // CSS 变量预计算（Pixi 不支持 CSS 变量）
    const cssVars = [
      "--secondary",
      "--tertiary",
      "--gray",
      "--light",
      "--lightgray",
      "--dark",
      "--darkgray",
      "--bodyFont",
    ] as const
    const computedStyleMap = cssVars.reduce(
      (acc, key) => {
        acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key)
        return acc
      },
      {} as Record<(typeof cssVars)[number], string>,
    )

    const color = (d: NodeData) => {
      const isCurrent = d.id === slug
      if (isCurrent) return computedStyleMap["--secondary"]
      if (visited.has(d.id) || d.id.startsWith("tags/")) return computedStyleMap["--tertiary"]
      return computedStyleMap["--gray"]
    }

    let hoveredNodeId: string | null = null
    let hoveredNeighbours: Set<string> = new Set()
    const linkRenderData: LinkRenderData[] = []
    const nodeRenderData: NodeRenderData[] = []

    function updateHoverInfo(newHoveredId: string | null) {
      hoveredNodeId = newHoveredId
      if (newHoveredId === null) {
        hoveredNeighbours = new Set()
        for (const n of nodeRenderData) n.active = false
        for (const l of linkRenderData) l.active = false
      } else {
        hoveredNeighbours = new Set()
        for (const l of linkRenderData) {
          const ld = l.simulationData
          if (ld.source.id === newHoveredId || ld.target.id === newHoveredId) {
            hoveredNeighbours.add(ld.source.id)
            hoveredNeighbours.add(ld.target.id)
          }
          l.active = ld.source.id === newHoveredId || ld.target.id === newHoveredId
        }
        for (const n of nodeRenderData) {
          n.active = hoveredNeighbours.has(n.simulationData.id)
        }
      }
    }

    let dragStartTime = 0
    let dragging = false

    function renderLinks() {
      tweens.get("link")?.stop()
      const tweenGroup = new TweenGroup()
      for (const l of linkRenderData) {
        const isAgg = l.isAggregation
        const defaultAlpha = isAgg ? 0.35 : 1
        const defaultColor = isAgg ? computedStyleMap["--tertiary"] : computedStyleMap["--lightgray"]
        const alpha = hoveredNodeId ? (l.active ? 1 : defaultAlpha * 0.3) : defaultAlpha
        l.color = l.active ? computedStyleMap["--gray"] : defaultColor
        tweenGroup.add(new Tweened<LinkRenderData>(l).to({ alpha }, 200))
      }
      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("link", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderLabels() {
      tweens.get("label")?.stop()
      const tweenGroup = new TweenGroup()
      const defaultScale = 1 / scale
      const activeScale = defaultScale * 1.1

      for (const n of nodeRenderData) {
        const nodeId = n.simulationData.id
        if (hoveredNodeId === nodeId) {
          tweenGroup.add(
            new Tweened<Text>(n.label).to(
              { alpha: 1, scale: { x: activeScale, y: activeScale } },
              100,
            ),
          )
        } else {
          tweenGroup.add(
            new Tweened<Text>(n.label).to(
              { alpha: n.label.alpha, scale: { x: defaultScale, y: defaultScale } },
              100,
            ),
          )
        }
      }

      // 边标签跟随 hover 高亮
      for (const l of linkRenderData) {
        if (l.label) {
          if (l.active) {
            l.label.style.fill = computedStyleMap["--dark"]
            tweenGroup.add(
              new Tweened<Text>(l.label).to(
                { alpha: 1, scale: { x: activeScale, y: activeScale } },
                100,
              ),
            )
          } else {
            l.label.style.fill = computedStyleMap["--darkgray"]
            tweenGroup.add(
              new Tweened<Text>(l.label).to(
                { alpha: l.label.alpha, scale: { x: defaultScale, y: defaultScale } },
                100,
              ),
            )
          }
        }
      }

      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("label", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderNodes() {
      tweens.get("hover")?.stop()
      const tweenGroup = new TweenGroup()
      for (const n of nodeRenderData) {
        const alpha = hoveredNodeId !== null && focusOnHover ? (n.active ? 1 : 0.2) : 1
        tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
        if (n.badge) {
          tweenGroup.add(new Tweened<Graphics>(n.badge, tweenGroup).to({ alpha }, 200))
        }
        if (n.badgeText) {
          tweenGroup.add(new Tweened<Text>(n.badgeText, tweenGroup).to({ alpha }, 200))
        }
        if (n.countLabel) {
          tweenGroup.add(new Tweened<Text>(n.countLabel, tweenGroup).to({ alpha }, 200))
        }
      }
      tweenGroup.getAll().forEach((tw) => tw.start())
      tweens.set("hover", {
        update: tweenGroup.update.bind(tweenGroup),
        stop() {
          tweenGroup.getAll().forEach((tw) => tw.stop())
        },
      })
    }

    function renderPixiFromD3() {
      if (isGlobalGraph) {
        for (const n of nodeRenderData) {
          if (n.badge) n.badge.visible = !n.simulationData.isExpanded
          if (n.badgeText) n.badgeText.visible = !n.simulationData.isExpanded
          if (n.countLabel) n.countLabel.visible = !n.simulationData.isExpanded
        }
      }
      renderNodes()
      renderLinks()
      renderLabels()
    }

    tweens.forEach((tween) => tween.stop())
    tweens.clear()

    console.log("[DEBUG] 开始初始化 Pixi Application")
    const app = new Application()
    await app.init({
      width,
      height,
      antialias: true,
      autoStart: false,
      autoDensity: true,
      backgroundAlpha: 0,
      preference: "webgpu",
      resolution: window.devicePixelRatio,
      eventMode: "static",
    })
    console.log("[DEBUG] Pixi Application 初始化完成")

    // ===== 检查点 4: Pixi 初始化完成后 =====
    if (!checkGeneration(generation)) {
      simulation.stop()
      app.destroy()
      return () => {}
    }

    graph.appendChild(app.canvas)
    const stage = app.stage
    stage.interactive = false

    const edgeLabelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
    const labelsContainer = new Container<Text>({ zIndex: 4, isRenderGroup: true })
    const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
    const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
    stage.addChild(linkContainer, edgeLabelsContainer, nodesContainer, labelsContainer)

    // ===== 对象池初始化 =====
    const graphicsPool = new ObjectPool<Graphics>(
      () => new Graphics({ interactive: true, eventMode: "static", cursor: "pointer" }),
      (gfx) => {
        gfx.clear()
        gfx.removeAllListeners()
        gfx.visible = true
        gfx.alpha = 1
        if (gfx.parent) gfx.parent.removeChild(gfx)
      },
    )
    const textPool = new ObjectPool<Text>(
      () =>
        new Text({
          interactive: false,
          eventMode: "none",
          text: "",
          alpha: 0,
          anchor: { x: 0.5, y: 1.2 },
          style: {
            fontSize: fontSize * 15,
            fill: computedStyleMap["--dark"],
            fontFamily: computedStyleMap["--bodyFont"],
            wordWrap: true,
            wordWrapWidth: 160,
          },
          resolution: window.devicePixelRatio * 4,
        }),
      (label) => {
        label.text = ""
        label.alpha = 0
        label.visible = true
        if (label.parent) label.parent.removeChild(label)
      },
    )
    const linkGraphicsPool = new ObjectPool<Graphics>(
      () => new Graphics({ interactive: false, eventMode: "none" }),
      (gfx) => {
        gfx.clear()
        gfx.visible = true
        gfx.alpha = 1
        if (gfx.parent) gfx.parent.removeChild(gfx)
      },
    )

    // ===== 辅助函数：创建节点渲染对象 =====
    function createNodeRenderObject(n: NodeData): NodeRenderData {
      const nodeId = n.id
      const isTagNode = nodeId.startsWith("tags/")
      const isAggNode = n.isAggregation ?? false
      const r = isAggNode ? (n.aggCollapsedRadius ?? 14) : nodeRadius(n)

      const label = textPool.acquire()
      label.text = n.text
      label.alpha = 0
      label.scale.set(1 / scale)

      // 聚合节点标签：上方显示，使用 --tertiary 色和更小字号
      if (isAggNode) {
        label.anchor.set(0.5, 0)
        label.style = {
          fontSize: fontSize * 12,
          fill: computedStyleMap["--tertiary"],
          fontFamily: computedStyleMap["--bodyFont"],
          fontWeight: "bold",
        }
      }

      const gfx = graphicsPool.acquire()
      gfx.label = nodeId
      gfx.hitArea = new Circle(0, 0, r + 8)
      if (isAggNode) {
        // 聚合节点（可展开）：双圆环 + 浅色填充，专属标识
        gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
        gfx.circle(0, 0, r).stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
        gfx.circle(0, 0, r - 4).stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
      } else if (n.isCore && !isTagNode) {
        // 核心节点（可展开）：深色实心圆 + 浅色中心数字，与叶子实心填充明显区分
        gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.55 })
      } else {
        // 叶子节点（不可展开）：实心填充圆，最普通
        gfx.circle(0, 0, r).fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })
        if (isTagNode) gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
      }

      let oldLabelOpacity = 0
      gfx.on("pointerover", (e) => {
        updateHoverInfo(e.target.label)
        oldLabelOpacity = label.alpha
        if (!dragging) renderPixiFromD3()
      })
      gfx.on("pointerleave", () => {
        updateHoverInfo(null)
        label.alpha = oldLabelOpacity
        if (!dragging) renderPixiFromD3()
      })

      // 初始位置：靠近已有的相邻核心节点
      if (n.x === undefined || n.y === undefined) {
        const connectedCore = graphData.nodes.find(
          (cn) =>
            cn.isCore &&
            allLinks.some(
              (l) =>
                (l.source.id === cn.id && l.target.id === n.id) ||
                (l.target.id === cn.id && l.source.id === n.id),
            ),
        )
        if (connectedCore?.x !== undefined && connectedCore?.y !== undefined) {
          n.x = connectedCore.x + (Math.random() - 0.5) * 50
          n.y = connectedCore.y + (Math.random() - 0.5) * 50
        } else {
          n.x = (Math.random() - 0.5) * width * 0.5
          n.y = (Math.random() - 0.5) * height * 0.5
        }
      }

      nodesContainer.addChild(gfx)
      labelsContainer.addChild(label)

      // 徽章（显示关联数量；可通过 Graph 配置项 showBadge 开关）
      let badge: Graphics | undefined
      let badgeText: Text | undefined
      const edgeCount = n.edgeNodeCount ?? 0
      if (n.isCore && showBadge && edgeCount > 0) {
        const badgeRadius = Math.max(8, Math.min(14, 6 + Math.sqrt(edgeCount) * 2))
        badge = new Graphics()
          .circle(0, 0, badgeRadius)
          .fill({ color: computedStyleMap["--secondary"] })
          .stroke({ width: 1, color: computedStyleMap["--light"] })
        badgeText = new Text({
          text: edgeCount > 99 ? `99+` : String(edgeCount),
          style: {
            fontSize: 10,
            fontFamily: computedStyleMap["--bodyFont"],
            fill: computedStyleMap["--light"],
            fontWeight: "bold",
          },
        })
        badgeText.anchor.set(0.5, 0.5)
        const shouldHideBadge = n.isExpanded ?? false
        badge.visible = !shouldHideBadge
        badgeText.visible = !shouldHideBadge
        nodesContainer.addChild(badge)
        labelsContainer.addChild(badgeText)
      }

      // [FEATURE] 在节点圆中心显示直接关联数量
      // [FIX] 1. 添加 resolution 解决模糊问题 2. 悬浮到数字上时触发节点高亮，保持一致的交互体验
      let countLabel: Text | undefined
      // 核心节点始终显示中心数字（不限于 countLabelMin），标签节点除外
      if (n.isCore && !isTagNode && (n.edgeNodeCount ?? 0) > 0) {
        const count = n.edgeNodeCount ?? 0
        countLabel = new Text({
          text: count > countLabelMaxDisplay ? `${countLabelMaxDisplay}+` : String(count),
            style: {
              fontSize: Math.max(10, r * 0.95),
              fontFamily: computedStyleMap["--bodyFont"],
              fill: computedStyleMap["--light"],
              fontWeight: "bold",
            },
            resolution: window.devicePixelRatio * 4,
          })
          countLabel.anchor.set(0.5, 0.5)
          const shouldHideCount = n.isExpanded ?? false
          countLabel.visible = !shouldHideCount
          labelsContainer.addChild(countLabel)

          // [FIX] 悬浮到数字上时触发节点高亮，保持一致的交互体验
          countLabel.eventMode = "static"
          countLabel.cursor = "pointer"
          countLabel.on("pointerover", () => {
            updateHoverInfo(nodeId)
            if (!dragging) renderPixiFromD3()
          })
          countLabel.on("pointerleave", () => {
            updateHoverInfo(null)
            if (!dragging) renderPixiFromD3()
          })
          // 转发点击事件到下层节点 gfx
          countLabel.on("pointerdown", (e: any) => {
            gfx.emit("pointerdown", e)
          })
      }

      // 聚合节点：在节点中心显示子节点数量（与核心节点风格一致）
      if (isAggNode && (n.aggChildCount ?? 0) > 0) {
        const count = n.aggChildCount ?? 0
        countLabel = new Text({
          text: count > countLabelMaxDisplay ? `${countLabelMaxDisplay}+` : String(count),
          style: {
            fontSize: Math.max(8, r * 0.75),
            fontFamily: computedStyleMap["--bodyFont"],
            fill: computedStyleMap["--secondary"],
            fontWeight: "bold",
          },
          resolution: window.devicePixelRatio * 4,
        })
        countLabel.anchor.set(0.5, 0.5)
        const shouldHideCount = n.isExpanded ?? false
        countLabel.visible = !shouldHideCount
        labelsContainer.addChild(countLabel)

        // 聚合节点中心数字也要支持点击和悬浮高亮
        countLabel.eventMode = "static"
        countLabel.cursor = "pointer"
        countLabel.on("pointerover", () => {
          updateHoverInfo(nodeId)
          if (!dragging) renderPixiFromD3()
        })
        countLabel.on("pointerleave", () => {
          updateHoverInfo(null)
          if (!dragging) renderPixiFromD3()
        })
        countLabel.on("pointerdown", (e: any) => {
          gfx.emit("pointerdown", e)
        })
      }

      return {
        simulationData: n,
        gfx,
        label,
        color: color(n),
        alpha: 1,
        active: false,
        badge,
        badgeText,
        countLabel,
        isAggregation: isAggNode || undefined,
      }
    }

    function createLinkRenderObject(l: LinkData): LinkRenderData {
      const gfx = linkGraphicsPool.acquire()
      linkContainer.addChild(gfx)

      // 创建边标签
      let label: Text | undefined
      if (l.sourceField) {
        label = new Text({
          text: l.sourceField,
          style: {
            fontSize: fontSize * 15 * 0.85,
            fill: computedStyleMap["--darkgray"],
            fontFamily: computedStyleMap["--bodyFont"],
            stroke: { width: 1, color: computedStyleMap["--light"] },
          },
          alpha: 0,
          resolution: window.devicePixelRatio * 4,
        })
        label.anchor.set(0.5, 0.5)
        edgeLabelsContainer.addChild(label)
      }

      return {
        simulationData: l,
        gfx,
        label,
        color: (l.source.isAggregation || l.target.isAggregation)
          ? computedStyleMap["--tertiary"]
          : computedStyleMap["--lightgray"],
        alpha: (l.source.isAggregation || l.target.isAggregation) ? 0.35 : 1,
        active: false,
        isAggregation: (l.source.isAggregation || l.target.isAggregation) || undefined,
      }
    }

    // ===== 渲染初始节点和链接 =====
    for (const n of graphData.nodes) {
      nodeRenderData.push(createNodeRenderObject(n))
    }

    for (const l of graphData.links) {
      linkRenderData.push(createLinkRenderObject(l))
    }

    // ===== 展开/收起边缘节点 =====
    const expandedNodeIds = new Set<SimpleSlug>()

    function expandNode(nodeId: SimpleSlug) {
      if (expandedNodeIds.has(nodeId)) return

      const isAggNode = nodeId.startsWith("agg:")
      let edgeNodesToAdd: NodeData[] = []
      let edgeLinksToAdd: LinkData[] = []

      if (isAggNode) {
        const aggInfo = aggNodeInfoMap.get(nodeId)
        const rawChildren = aggNodeToChildNodes.get(nodeId) ?? []

        // 多级聚合：若还有 remainingFields，动态跳过无效字段
        if (aggInfo && aggInfo.remainingFields.length > 0) {
          const childNodes = rawChildren.filter((n) => !graphData.nodes.some((gn) => gn.id === n.id))

          if (childNodes.length > 0) {
            // 动态查找第一个对当前子节点集合有效的聚合字段
            let effectiveFieldIdx = -1
            let effectiveGroupMap: Map<string, NodeData[]> | null = null
            let effectiveFieldName = ""

            for (let i = 0; i < aggInfo.remainingFields.length; i++) {
              const field = aggInfo.remainingFields[i]
              const fieldName = field.field
              const granularity = field.granularity
              const groupMap = new Map<string, NodeData[]>()
              let hasValidValue = false

              for (const leaf of childNodes) {
                const details = contentData.get(leaf.id)
                let fieldValue: string | undefined

                if (details) {
                  if (fieldName === "date") {
                    const dateStr = (details as any).frontmatter?.date ?? (details as any).date
                    if (dateStr) {
                      const d = new Date(dateStr)
                      if (!isNaN(d.getTime())) {
                        if (granularity === "year") fieldValue = `${d.getFullYear()}`
                        else if (granularity === "month") fieldValue = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
                        else if (granularity === "quarter") fieldValue = `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`
                      }
                    }
                  } else {
                    const rawValue = (details as any).frontmatter?.[fieldName]
                    // 多级聚合中跳过数组字段
                    if (!Array.isArray(rawValue) && rawValue) {
                      fieldValue = String(rawValue)
                    }
                  }
                }

                if (fieldValue) {
                  hasValidValue = true
                }
                const key = fieldValue ?? "(无)"
                const group = groupMap.get(key) ?? []
                group.push(leaf)
                groupMap.set(key, group)
              }

              // 若至少有一个节点有有效值，则该字段有效
              if (hasValidValue) {
                effectiveFieldIdx = i
                effectiveGroupMap = groupMap
                effectiveFieldName = fieldName
                break
              }
            }

            if (effectiveFieldIdx >= 0 && effectiveGroupMap) {
              // 使用第一个有效字段创建子聚合节点
              const remainingFieldsAfter = aggInfo.remainingFields.slice(effectiveFieldIdx + 1)
              for (const [groupKey, groupLeaves] of effectiveGroupMap) {
                const subAggId = `agg:sub:${nodeId}:${effectiveFieldName}:${groupKey}` as SimpleSlug
                const collapsedR = Math.min(24, Math.max(12, 2 + Math.sqrt(groupLeaves.length)))
                const subAggNode: NodeData = {
                  id: subAggId,
                  text: groupKey,
                  tags: [],
                  isCore: false,
                  isAggregation: true,
                  edgeNodeCount: 0,
                  aggCollapsedRadius: collapsedR,
                  aggChildCount: groupLeaves.length,
                }

                const subAggLink: LinkData = {
                  source: subAggNode,
                  target: aggInfo.node,
                  sourceField: effectiveFieldName,
                }

                aggToCoreMap.set(subAggId, nodeId)
                aggNodeToChildNodes.set(subAggId, groupLeaves)
                aggNodeToChildLinks.set(subAggId, [])
                aggNodeInfoMap.set(subAggId, {
                  node: subAggNode,
                  coreId: nodeId,
                  childNodes: groupLeaves,
                  childLinks: [],
                  remainingFields: remainingFieldsAfter,
                  currentField: effectiveFieldName,
                })

                edgeNodesToAdd.push(subAggNode)
                edgeLinksToAdd.push(subAggLink)
              }
            } else {
              // 所有剩余字段都无效，直接显示原始叶子
              edgeNodesToAdd = childNodes
            }
          }
        } else {
          // 最后一级：直接展开原始叶子
          edgeNodesToAdd = rawChildren.filter((n) => !graphData.nodes.some((gn) => gn.id === n.id))
        }
      } else {
        edgeNodesToAdd = nodeToEdgeNodes.get(nodeId) ?? []
        edgeLinksToAdd = nodeToEdgeLinks.get(nodeId) ?? []
      }

      if (edgeNodesToAdd.length === 0) return

      const parentNode = graphData.nodes.find((n) => n.id === nodeId)

      // 判断是否为直接包含叶子的聚合节点（最后一级，或展开后无子聚合节点）
      const aggInfo = isAggNode ? aggNodeInfoMap.get(nodeId) : undefined
      const hasSubAggNodes = edgeNodesToAdd.some((n) => n.isAggregation)
      const isLeafAggNode = isAggNode && (!aggInfo || aggInfo.remainingFields.length === 0 || !hasSubAggNodes)

      if (isLeafAggNode && parentNode?.x !== undefined && parentNode?.y !== undefined) {
        // 叶子聚合节点展开：创建放大背景圆圈，子节点沿内部均匀分布
        const childCount = edgeNodesToAdd.length
        // 计算子节点所需空间：考虑子节点自身半径 + 间距
        let requiredR = 0
        for (const child of edgeNodesToAdd) {
          const childR = child.aggCollapsedRadius ?? nodeRadius(child)
          requiredR = Math.max(requiredR, (childR + 10) / 0.82)
        }
        const baseR = Math.sqrt(childCount) * 14.14
        const expandedR = Math.min(200, Math.max(35, Math.max(baseR, requiredR)))
        parentNode.aggExpandedRadius = expandedR

        const rd = nodeRenderData.find((r) => r.simulationData.id === nodeId)
        if (rd) {
          const bg = new Graphics({ interactive: false, eventMode: "none" })
          bg.circle(0, 0, expandedR).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
          bg.circle(0, 0, expandedR).stroke({ width: 1.5, color: computedStyleMap["--secondary"], alpha: 0.4 })
          bg.position.set(parentNode.x + width / 2, parentNode.y + height / 2)
          linkContainer.addChildAt(bg, 0)
          rd.aggBg = bg
          rd.aggExpandedRadius = expandedR

          rd.gfx.clear()
          rd.gfx.hitArea = new Circle(0, 0, expandedR + 8)
        }

        const goldenAngle = Math.PI * (3 - Math.sqrt(5))
        for (let i = 0; i < edgeNodesToAdd.length; i++) {
          const edgeNode = edgeNodesToAdd[i]
          if (graphData.nodes.some((n) => n.id === edgeNode.id)) continue
          const childR = edgeNode.aggCollapsedRadius ?? nodeRadius(edgeNode)
          const boundR = expandedR * 0.85 - childR
          const r = Math.max(0, boundR * Math.sqrt((i + 0.5) / childCount))
          const theta = goldenAngle * i
          const offsetX = Math.cos(theta) * r
          const offsetY = Math.sin(theta) * r
          edgeNode.x = parentNode.x + offsetX
          edgeNode.y = parentNode.y + offsetY
          edgeNode.aggTargetOffset = { x: offsetX, y: offsetY }
        }
      } else {
        // 多级聚合父节点 / 普通核心节点展开：子节点随机分布在周围
        for (const edgeNode of edgeNodesToAdd) {
          if (graphData.nodes.some((n) => n.id === edgeNode.id)) continue
          if (parentNode?.x !== undefined && parentNode?.y !== undefined) {
            edgeNode.x = parentNode.x + (Math.random() - 0.5) * 80
            edgeNode.y = parentNode.y + (Math.random() - 0.5) * 80
          }
        }
      }

      for (const edgeNode of edgeNodesToAdd) {
        if (graphData.nodes.some((n) => n.id === edgeNode.id)) continue
        graphData.nodes.push(edgeNode)
        nodeRenderData.push(createNodeRenderObject(edgeNode))
      }
      for (const link of edgeLinksToAdd) {
        if (
          graphData.links.some(
            (l) => l.source.id === link.source.id && l.target.id === link.target.id,
          )
        )
          continue
        graphData.links.push(link)
        linkRenderData.push(createLinkRenderObject(link))
      }

      expandedNodeIds.add(nodeId)

      if (isAggNode && edgeNodesToAdd.length > 0) {
        expandedAggChildren.set(nodeId, new Set(edgeNodesToAdd.map((n) => n.id)))
      }
      const nodeData = graphData.nodes.find((n) => n.id === nodeId)
      if (nodeData) {
        nodeData.isExpanded = true
        const rd = nodeRenderData.find((r) => r.simulationData.id === nodeId)
        if (rd) {
          if (rd.badge) rd.badge.visible = false
          if (rd.badgeText) rd.badgeText.visible = false
          if (rd.countLabel) rd.countLabel.visible = false
        }
      }

      for (const edgeNode of edgeNodesToAdd) {
        const rd = nodeRenderData.find((r) => r.simulationData.id === edgeNode.id)
        if (rd && !isAggNode) {
          rd.label.alpha = 1
          rd.label.style = { ...rd.label.style, fill: computedStyleMap["--darkgray"] }
        }
      }
      for (const link of edgeLinksToAdd) {
        const lrd = linkRenderData.find(
          (r) => r.simulationData.source.id === link.source.id && r.simulationData.target.id === link.target.id,
        )
        if (lrd?.label && !isAggNode) {
          lrd.label.alpha = 1
          lrd.label.style = { ...lrd.label.style, fill: computedStyleMap["--darkgray"] }
        }
      }

      renderLabels()

      simulation.nodes(graphData.nodes)
      simulation.force("link", forceLink(graphData.links).distance(linkDistance))
      simulation.alpha(isLeafAggNode ? 0.005 : 0.005).restart()
    }

    function collapseNode(nodeId: SimpleSlug) {
      if (!expandedNodeIds.has(nodeId)) return

      // 聚合节点：移除展开的子边缘节点，释放固定位置
      const isAggNode = nodeId.startsWith("agg:")
      const edgeNodesToRemove = isAggNode
        ? (aggNodeToChildNodes.get(nodeId) ?? [])
        : (nodeToEdgeNodes.get(nodeId) ?? [])

      // 收集需要移除的节点：先递归收起已展开的子聚合节点，再收集所有可见后代
      const nodesToRemove = new Set<NodeData>()
      function collectDescendants(aggId: SimpleSlug) {
        const childIds = expandedAggChildren.get(aggId)
        if (!childIds) return
        for (const childId of childIds) {
          const child = graphData.nodes.find((n) => n.id === childId)
          if (!child) continue
          nodesToRemove.add(child)
          // 若子节点也是展开的聚合节点，递归收起
          if (child.isAggregation && expandedNodeIds.has(childId)) {
            // 先递归收集孙节点
            collectDescendants(childId)
            // 标记子聚合节点为已收起
            expandedNodeIds.delete(childId)
            expandedAggChildren.delete(childId)
          }
        }
      }
      if (isAggNode) {
        collectDescendants(nodeId)
      }
      // 加入直接子节点，同时递归处理其中已展开的聚合节点（普通核心节点→聚合节点→孙叶子）
      for (const edgeNode of edgeNodesToRemove) {
        nodesToRemove.add(edgeNode)
        if (edgeNode.isAggregation && expandedNodeIds.has(edgeNode.id)) {
          collectDescendants(edgeNode.id)
          expandedNodeIds.delete(edgeNode.id)
          expandedAggChildren.delete(edgeNode.id)
        }
      }

      // 辅助：清理聚合节点的展开状态（gfx 样式、aggBg、expanded 标记等）
      function cleanupAggNodeState(aggNodeData: NodeData) {
        if (!aggNodeData.isAggregation) return
        aggNodeData.isExpanded = false
        aggNodeData.aggExpandedRadius = undefined
        expandedNodeIds.delete(aggNodeData.id)
        expandedAggChildren.delete(aggNodeData.id)
        const rd = nodeRenderData.find((r) => r.simulationData.id === aggNodeData.id)
        if (rd) {
          if (rd.aggBg) {
            rd.aggBg.destroy()
            rd.aggBg = undefined
            rd.aggExpandedRadius = undefined
          }
          rd.gfx.clear()
          const r = aggNodeData.aggCollapsedRadius ?? 14
          rd.gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
          rd.gfx.circle(0, 0, r).stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
          rd.gfx.circle(0, 0, r - 4).stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
          rd.gfx.hitArea = new Circle(0, 0, r + 8)
        }
      }

      for (const edgeNode of nodesToRemove) {
        let stillReferenced = false
        for (const expandedId of expandedNodeIds) {
          if (expandedId === nodeId) continue
          const otherChildren = expandedId.startsWith("agg:")
            ? (expandedAggChildren.get(expandedId) ?? new Set())
            : new Set((nodeToEdgeNodes.get(expandedId) ?? []).map((n) => n.id))
          if (otherChildren.has(edgeNode.id)) {
            stillReferenced = true
            break
          }
        }
        if (stillReferenced) continue

        // 若移除的是聚合节点，先清理其展开状态
        cleanupAggNodeState(edgeNode)

        const renderIdx = nodeRenderData.findIndex((r) => r.simulationData.id === edgeNode.id)
        if (renderIdx !== -1) {
          const rd = nodeRenderData[renderIdx]
          graphicsPool.release(rd.gfx)
          textPool.release(rd.label)
          if (rd.badge) {
            rd.badge.destroy()
            rd.badge = undefined
          }
          if (rd.badgeText) {
            rd.badgeText.destroy()
            rd.badgeText = undefined
          }
          if (rd.countLabel) {
            rd.countLabel.destroy()
            rd.countLabel = undefined
          }
          // 若子节点是聚合节点，销毁其 aggBg
          if (rd.aggBg) {
            rd.aggBg.destroy()
            rd.aggBg = undefined
            rd.aggExpandedRadius = undefined
          }
          nodeRenderData.splice(renderIdx, 1)
        }

        for (let i = linkRenderData.length - 1; i >= 0; i--) {
          const link = linkRenderData[i].simulationData
          if (link.source.id === edgeNode.id || link.target.id === edgeNode.id) {
            linkGraphicsPool.release(linkRenderData[i].gfx)
            if (linkRenderData[i].label) {
              linkRenderData[i].label!.destroy()
            }
            linkRenderData.splice(i, 1)
          }
        }

        const nodeIdx = graphData.nodes.findIndex((n) => n.id === edgeNode.id)
        if (nodeIdx !== -1) graphData.nodes.splice(nodeIdx, 1)
        edgeNode.aggTargetOffset = undefined
        graphData.links = graphData.links.filter(
          (l) => l.source.id !== edgeNode.id && l.target.id !== edgeNode.id,
        )
      }

      expandedNodeIds.delete(nodeId)
      expandedAggChildren.delete(nodeId)
      const nodeData = graphData.nodes.find((n) => n.id === nodeId)
      if (nodeData) {
        nodeData.isExpanded = false
        const rd = nodeRenderData.find((r) => r.simulationData.id === nodeId)
        if (rd) {
          // 聚合节点：销毁背景圆圈（若存在），恢复原始样式
          if (isAggNode) {
            if (rd.aggBg) {
              rd.aggBg.destroy()
              rd.aggBg = undefined
              rd.aggExpandedRadius = undefined
            }
            rd.gfx.clear()
            const r = nodeData.aggCollapsedRadius ?? 14
            rd.gfx.circle(0, 0, r).fill({ color: computedStyleMap["--secondary"], alpha: 0.08 })
            rd.gfx.circle(0, 0, r).stroke({ width: 2, color: computedStyleMap["--secondary"], alpha: 0.4 })
            rd.gfx.circle(0, 0, r - 4).stroke({ width: 1, color: computedStyleMap["--secondary"], alpha: 0.2 })
            rd.gfx.hitArea = new Circle(0, 0, r + 8)
            nodeData.aggExpandedRadius = undefined // 恢复碰撞半径
          }
          if (rd.badge) rd.badge.visible = true
          if (rd.badgeText) rd.badgeText.visible = true
          if (rd.countLabel) rd.countLabel.visible = true
        }
      }

      simulation.nodes(graphData.nodes)
      simulation.force("link", forceLink(graphData.links).distance(linkDistance))
      // 收起时用较高 alpha 重新收敛，避免节点停留在展开时的远距离位置
      simulation.alpha(0.3).restart()
    }

    function toggleNodeExpansion(nodeId: SimpleSlug) {
      expandedNodeIds.has(nodeId) ? collapseNode(nodeId) : expandNode(nodeId)
    }

    // ===== 拖拽和缩放 =====
    let currentTransform = zoomIdentity
    let lastClickTime = 0
    let lastClickedNodeId: SimpleSlug | null = null

    if (enableDrag) {
      select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
        drag<HTMLCanvasElement, NodeData | undefined>()
          .container(() => app.canvas)
          .subject(() => graphData.nodes.find((n) => n.id === hoveredNodeId))
          .on("start", function dragstarted(event) {
            if (!event.active) simulation.alphaTarget(1).restart()
            event.subject.fx = event.subject.x
            event.subject.fy = event.subject.y
            event.subject.__initialDragPos = {
              x: event.subject.x,
              y: event.subject.y,
              fx: event.subject.fx,
              fy: event.subject.fy,
            }
            dragStartTime = Date.now()
            dragging = true
          })
          .on("drag", function dragged(event) {
            const initPos = event.subject.__initialDragPos
            event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
            event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
          })
          .on("end", function dragended(event) {
            if (!event.active) simulation.alphaTarget(0)
            event.subject.fx = null
            event.subject.fy = null
            dragging = false

            if (Date.now() - dragStartTime < 300) {
              const nodeId = event.subject.id as SimpleSlug
              const now = Date.now()
              if (isGlobalGraph) {
                if (lastClickedNodeId === nodeId && now - lastClickTime < DOUBLE_CLICK_DELAY) {
                  const targ = resolveRelative(fullSlug, nodeId)
                  window.spaNavigate(new URL(targ, window.location.toString()))
                  lastClickedNodeId = null
                  lastClickTime = 0
                } else {
                  lastClickedNodeId = nodeId
                  lastClickTime = now
                  toggleNodeExpansion(nodeId)
                }
              } else {
                // 局部图谱：聚合节点点击展开/收起，普通节点跳转导航
                if (nodeId.startsWith("agg:")) {
                  toggleNodeExpansion(nodeId)
                } else {
                  const targ = resolveRelative(fullSlug, nodeId)
                  window.spaNavigate(new URL(targ, window.location.toString()))
                }
              }
            }
          }),
      )
    } else {
      for (const node of nodeRenderData) {
        let clickTimeout: ReturnType<typeof setTimeout> | null = null
        node.gfx.on("click", () => {
          const nodeId = node.simulationData.id
          if (isGlobalGraph) {
            if (clickTimeout) {
              clearTimeout(clickTimeout)
              clickTimeout = null
              const targ = resolveRelative(fullSlug, nodeId)
              window.spaNavigate(new URL(targ, window.location.toString()))
            } else {
              clickTimeout = setTimeout(() => {
                clickTimeout = null
                toggleNodeExpansion(nodeId)
              }, DOUBLE_CLICK_DELAY)
            }
          } else {
            // 局部图谱：聚合节点点击展开/收起，普通节点跳转导航
            if (nodeId.startsWith("agg:")) {
              toggleNodeExpansion(nodeId)
            } else {
              const targ = resolveRelative(fullSlug, nodeId)
              window.spaNavigate(new URL(targ, window.location.toString()))
            }
          }
        })
      }
    }

    if (enableZoom) {
      select<HTMLCanvasElement, NodeData>(app.canvas).call(
        zoom<HTMLCanvasElement, NodeData>()
          .extent([
            [0, 0],
            [width, height],
          ])
          .scaleExtent([0.25, 4])
          .on("zoom", ({ transform }) => {
            if (appDestroyed) return
            currentTransform = transform
            stage.scale.set(transform.k, transform.k)
            stage.position.set(transform.x, transform.y)

            const s = transform.k * opacityScale
            const scaleOpacity = Math.max((s - 1) / 3.75, 0)
            const activeNodeLabels = new Set(
              nodeRenderData.filter((n) => n.active).map((n) => n.label),
            )
            const badgeTexts = new Set(
              nodeRenderData.flatMap((n) => (n.badgeText ? [n.badgeText] : [])),
            )
            const countLabels = new Set(
              nodeRenderData.flatMap((n) => (n.countLabel ? [n.countLabel] : [])),
            )

            for (const label of labelsContainer.children) {
              if (badgeTexts.has(label)) continue
              if (countLabels.has(label)) continue
              if (!activeNodeLabels.has(label)) label.alpha = scaleOpacity
            }
            for (const label of edgeLabelsContainer.children) {
              label.alpha = scaleOpacity
            }
          }),
      )
    }

    let animationId: number | null = null
    let appDestroyed = false

    // 虚线绘制辅助函数（用于聚合边）
    function drawDashedLine(gfx: Graphics, x1: number, y1: number, x2: number, y2: number) {
      const dx = x2 - x1
      const dy = y2 - y1
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return
      const ux = dx / dist
      const uy = dy / dist
      const dashLen = 6
      const gapLen = 5
      let pos = 0
      while (pos < dist) {
        const segLen = Math.min(dashLen, dist - pos)
        gfx.moveTo(x1 + ux * pos, y1 + uy * pos)
        gfx.lineTo(x1 + ux * (pos + segLen), y1 + uy * (pos + segLen))
        pos += dashLen + gapLen
      }
    }

    function animate(time: number) {
      if (appDestroyed || !checkGeneration(generation)) return

      for (const n of nodeRenderData) {
        const { x, y } = n.simulationData
        if (x === undefined || y === undefined) continue
        const posX = x + width / 2
        const posY = y + height / 2
        n.gfx.position.set(posX, posY)
        if (n.label) {
          if (n.isAggregation) {
            // 聚合节点标签显示在节点上方（加大偏移避免与双环重叠）
            const r = nodeRadius(n.simulationData)
            n.label.position.set(posX, posY - r - 16)
          } else {
            n.label.position.set(posX, posY)
          }
        }
        // 聚合节点展开背景圆圈跟随移动
        if (n.aggBg) n.aggBg.position.set(posX, posY)
        if (n.badge) {
          const r = nodeRadius(n.simulationData)
          n.badge.position.set(posX + r + 4, posY - r - 4)
        }
        if (n.badgeText) {
          const r = nodeRadius(n.simulationData)
          n.badgeText.position.set(posX + r + 4, posY - r - 4)
        }
        if (n.countLabel) {
          n.countLabel.position.set(posX, posY)
        }
      }

      for (const l of linkRenderData) {
        const ld = l.simulationData
        const sx = ld.source.x
        const sy = ld.source.y
        const tx = ld.target.x
        const ty = ld.target.y

        if (sx === undefined || sy === undefined || tx === undefined || ty === undefined) {
          l.gfx.visible = false
          continue
        }
        l.gfx.visible = true
        l.gfx.clear()
        if (l.label) l.label.visible = true

        const x1 = sx + width / 2
        const y1 = sy + height / 2
        const x2 = tx + width / 2
        const y2 = ty + height / 2
        const isAgg = l.isAggregation
        const lineW = isAgg ? 0.6 : 1

        // 聚合节点（无论展开/收起）连线从圆圈边缘发出，避免连线穿入节点内部
        let lineX1 = x1, lineY1 = y1
        if (isAgg && ld.source.aggExpandedRadius) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * ld.source.aggExpandedRadius
          lineY1 = y1 + (dy / dist) * ld.source.aggExpandedRadius
        } else if (isAgg && ld.source.aggCollapsedRadius) {
          const dx = x2 - x1
          const dy = y2 - y1
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          lineX1 = x1 + (dx / dist) * ld.source.aggCollapsedRadius
          lineY1 = y1 + (dy / dist) * ld.source.aggCollapsedRadius
        }

        if (showArrows) {
          const targetR = nodeRadius(ld.target)
          const dx = x2 - x1
          const dy = y2 - y1
          const len = Math.sqrt(dx * dx + dy * dy)
          const arrowSize = isAgg ? 4 : 5
          if (len > targetR + arrowSize) {
            const ratio = (len - targetR) / len
            const arrowX = x1 + dx * ratio
            const arrowY = y1 + dy * ratio
            if (isAgg) {
              drawDashedLine(l.gfx, lineX1, lineY1, arrowX, arrowY)
            } else {
              l.gfx.moveTo(x1, y1).lineTo(arrowX, arrowY)
            }
            l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
            const angle = Math.atan2(dy, dx)
            l.gfx.moveTo(arrowX, arrowY)
            l.gfx.lineTo(
              arrowX - arrowSize * Math.cos(angle - Math.PI / 6),
              arrowY - arrowSize * Math.sin(angle - Math.PI / 6),
            )
            l.gfx.lineTo(
              arrowX - arrowSize * Math.cos(angle + Math.PI / 6),
              arrowY - arrowSize * Math.sin(angle + Math.PI / 6),
            )
            l.gfx.lineTo(arrowX, arrowY)
            l.gfx.fill({ color: l.color })
          } else {
            if (isAgg) {
              drawDashedLine(l.gfx, lineX1, lineY1, x2, y2)
            } else {
              l.gfx.moveTo(x1, y1).lineTo(x2, y2)
            }
            l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
          }
        } else {
          if (isAgg) {
            drawDashedLine(l.gfx, lineX1, lineY1, x2, y2)
          } else {
            l.gfx.moveTo(x1, y1).lineTo(x2, y2)
          }
          l.gfx.stroke({ alpha: l.alpha, width: lineW, color: l.color })
        }

        if (l.label) {
          l.label.position.set((lineX1 + x2) / 2, (lineY1 + y2) / 2)
        }
      }

      tweens.forEach((t) => t.update(time))
      app.renderer.render(stage)
      animationId = requestAnimationFrame(animate)
    }

    console.log("[DEBUG] 启动动画循环")
    animationId = requestAnimationFrame(animate)
    console.debug(
      `[Graph] Rendered graph for ${slug}. Containers: ${document.getElementsByClassName("graph-container").length}`,
    )
    console.log("[DEBUG] renderGraph 函数即将返回")

    return () => {
      console.debug(`[Graph] Tearing down graph for ${slug}`)
      appDestroyed = true
      if (animationId !== null) {
        cancelAnimationFrame(animationId)
        animationId = null
      }
      simulation.stop()
      tweens.forEach((t) => t.stop())
      tweens.clear()
      select(app.canvas).on(".zoom", null).on(".drag", null)
      graphicsPool.clear()
      textPool.clear()
      linkGraphicsPool.clear()
      app.stage.destroy({ children: true, texture: true })
      app.destroy({ removeView: true })
      console.debug(`[Graph] Pixi app and resources destroyed for ${slug}`)
    }
  }

  // ============ 导航生命周期管理 ============
  let localGraphCleanups: (() => void)[] = []
  let globalGraphCleanups: (() => void)[] = []

  function cleanupLocalGraphs() {
    renderGeneration++ // 递增世代，废弃进行中的旧渲染
    const count = localGraphCleanups.length
    if (count > 0) console.debug(`[Graph] Cleaning up ${count} local graphs`)
    for (const cleanup of localGraphCleanups) cleanup()
    localGraphCleanups = []
  }

  function cleanupGlobalGraphs() {
    const count = globalGraphCleanups.length
    if (count > 0) console.debug(`[Graph] Cleaning up ${count} global graphs`)
    for (const cleanup of globalGraphCleanups) cleanup()
    globalGraphCleanups = []
  }

  // prenav：提前清理，缩短竞态窗口
  document.addEventListener("prenav", () => {
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })

  document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
    const slug = e.detail.url
    // prescript.js 在 <head> 中执行，此时 body 的 data-slug 可能尚未解析
    if (!slug) return
    addToVisited(simplifySlug(slug))
    ensureFetchData()

    async function renderLocalGraph() {
      const thisGeneration = renderGeneration
      const localGraphContainers = document.getElementsByClassName("graph-container")
      for (const container of localGraphContainers) {
        const cleanup = await renderGraph(container as HTMLElement, slug, thisGeneration)
        if (cleanup) {
          if (thisGeneration === renderGeneration) {
            localGraphCleanups.push(cleanup)
          } else {
            console.log(
              `[Graph] 渲染完成后发现世代已过期 (${thisGeneration} !== ${renderGeneration})，立即执行 cleanup 避免泄漏`,
            )
            cleanup()
          }
        }
      }
    }

    await renderLocalGraph()
    console.log("[DEBUG] renderLocalGraph 执行完成，所有本地图谱已渲染")

    const handleThemeChange = () => {
      void renderLocalGraph()
    }
    document.addEventListener("themechange", handleThemeChange)
    window.addCleanup(() => document.removeEventListener("themechange", handleThemeChange))

    const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]

    async function renderGlobalGraph() {
      const thisGeneration = renderGeneration
      const currentSlug = getFullSlug(window)
      for (const container of containers) {
        container.classList.add("active")
        const sidebar = container.closest(".sidebar") as HTMLElement
        if (sidebar) sidebar.style.zIndex = "1"
        const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
        registerEscapeHandler(container, hideGlobalGraph)
        if (graphContainer) {
          const cleanup = await renderGraph(graphContainer, currentSlug, thisGeneration)
          if (cleanup) {
            if (thisGeneration === renderGeneration) {
              globalGraphCleanups.push(cleanup)
            } else {
              console.log(`[Graph] 全局渲染完成后发现世代已过期，立即执行 cleanup 避免泄漏`)
              cleanup()
            }
          }
        }
      }
    }

    function hideGlobalGraph() {
      cleanupGlobalGraphs()
      for (const container of containers) {
        container.classList.remove("active")
        const sidebar = container.closest(".sidebar") as HTMLElement
        if (sidebar) sidebar.style.zIndex = ""
      }
    }

    async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
      if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        const anyOpen = containers.some((c) => c.classList.contains("active"))
        anyOpen ? hideGlobalGraph() : renderGlobalGraph()
      }
    }

    const containerIcons = document.getElementsByClassName("global-graph-icon")
    Array.from(containerIcons).forEach((icon) => {
      icon.addEventListener("click", renderGlobalGraph)
      window.addCleanup(() => icon.removeEventListener("click", renderGlobalGraph))
    })

    document.addEventListener("keydown", shortcutHandler)
    window.addCleanup(() => {
      document.removeEventListener("keydown", shortcutHandler)
      cleanupLocalGraphs()
      cleanupGlobalGraphs()
    })

    console.log("[DEBUG] nav 事件处理完成，图谱初始化全部完成")
  })
}

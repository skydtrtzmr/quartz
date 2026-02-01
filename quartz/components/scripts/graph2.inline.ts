import type { ContentDetails } from "../../plugins/emitters/contentIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
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
import { D3Config } from "../Graph"

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
  // 标记是否为核心节点（连接数>1）
  isCore?: boolean
  // 展开状态（手动展开/收起关联节点）
  isExpanded?: boolean
  // 关联的边缘节点数量（用于显示徽章）
  edgeNodeCount?: number
} & SimulationNodeDatum

type SimpleLinkData = {
  source: SimpleSlug
  target: SimpleSlug
}

type LinkData = {
  source: NodeData
  target: NodeData
} & SimulationLinkDatum<NodeData>

type LinkRenderData = GraphicsInfo & {
  simulationData: LinkData
}

type NodeRenderData = GraphicsInfo & {
  simulationData: NodeData
  label: Text
  badge?: Graphics // 关联节点数量徽章
  badgeText?: Text // 徽章上的数字
}

const localStorageKey = "graph-visited"
function getVisited(): Set<SimpleSlug> {
  return new Set(JSON.parse(localStorage.getItem(localStorageKey) ?? "[]"))
}

function addToVisited(slug: SimpleSlug) {
  const visited = getVisited()
  visited.add(slug)
  localStorage.setItem(localStorageKey, JSON.stringify([...visited]))
}

type TweenNode = {
  update: (time: number) => void
  stop: () => void
}

// ============ 交互配置 ============
const DOUBLE_CLICK_DELAY = 300 // 双击检测间隔（ms）

// ============ 对象池：复用 Graphics 和 Text 对象 ============
class ObjectPool<T> {
  private pool: T[] = []
  private createFn: () => T
  private resetFn: (obj: T) => void

  constructor(createFn: () => T, resetFn: (obj: T) => void) {
    this.createFn = createFn
    this.resetFn = resetFn
  }

  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!
    }
    return this.createFn()
  }

  release(obj: T): void {
    this.resetFn(obj)
    this.pool.push(obj)
  }

  clear(): void {
    for (const obj of this.pool) {
      this.resetFn(obj)
      // @ts-ignore - Graphics/Text 对象有 destroy 方法
      if (typeof obj.destroy === "function") {
        // @ts-ignore
        obj.destroy({ children: true, texture: true, baseTexture: true })
      }
    }
    this.pool = []
  }

  get size(): number {
    return this.pool.length
  }
}

async function renderGraph(graph: HTMLElement, fullSlug: FullSlug) {
  const slug = simplifySlug(fullSlug)
  const visited = getVisited()
  removeAllChildren(graph)

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
  } = JSON.parse(graph.dataset["cfg"]!) as D3Config

  const data: Map<SimpleSlug, ContentDetails> = new Map(
    Object.entries<ContentDetails>(await fetchData).map(([k, v]) => [
      simplifySlug(k as FullSlug),
      v,
    ]),
  )

  // 加载虚拟节点索引
  let virtualNodeData: Map<SimpleSlug, { title: string; links: SimpleSlug[]; content: string }> =
    new Map()
  try {
    const virtualIndexResponse = await fetch("/static/virtualNodeIndex.json")
    if (virtualIndexResponse.ok) {
      const virtualIndex = await virtualIndexResponse.json()
      Object.entries(virtualIndex).forEach(([k, v]) => {
        virtualNodeData.set(
          simplifySlug(k as FullSlug),
          v as { title: string; links: SimpleSlug[]; content: string },
        )
      })
    }
  } catch (e) {
    // 虚拟节点索引文件不存在，忽略
  }

  const links: SimpleLinkData[] = []
  const tags: SimpleSlug[] = []
  const validLinks = new Set(data.keys())

  // 将虚拟节点也加入有效链接集合
  for (const virtualSlug of virtualNodeData.keys()) {
    validLinks.add(virtualSlug)
  }

  const tweens = new Map<string, TweenNode>()
  for (const [source, details] of data.entries()) {
    const outgoing = details.links ?? []

    for (const dest of outgoing) {
      if (validLinks.has(dest)) {
        links.push({ source: source, target: dest })
      }
    }

    if (showTags) {
      const localTags = details.tags
        .filter((tag) => !removeTags.includes(tag))
        .map((tag) => simplifySlug(("tags/" + tag) as FullSlug))

      tags.push(...localTags.filter((tag) => !tags.includes(tag)))

      for (const tag of localTags) {
        links.push({ source: source, target: tag })
      }
    }
  }

  // 处理虚拟节点的链接（虚拟节点作为源节点）
  for (const [virtualSource, vDetails] of virtualNodeData.entries()) {
    for (const dest of vDetails.links) {
      if (validLinks.has(dest)) {
        links.push({ source: virtualSource, target: dest })
      }
    }
  }

  const neighbourhood = new Set<SimpleSlug>()
  const wl: (SimpleSlug | "__SENTINEL")[] = [slug, "__SENTINEL"]
  if (depth >= 0) {
    while (depth >= 0 && wl.length > 0) {
      // compute neighbours
      const cur = wl.shift()!
      if (cur === "__SENTINEL") {
        depth--
        wl.push("__SENTINEL")
      } else {
        neighbourhood.add(cur)
        const outgoing = links.filter((l) => l.source === cur)
        const incoming = links.filter((l) => l.target === cur)
        wl.push(...outgoing.map((l) => l.target), ...incoming.map((l) => l.source))
      }
    }
  } else {
    validLinks.forEach((id) => neighbourhood.add(id))
    if (showTags) tags.forEach((tag) => neighbourhood.add(tag))
    // 添加所有虚拟节点到邻域
    virtualNodeData.forEach((_, virtualSlug) => neighbourhood.add(virtualSlug))
  }

  const allNodes: NodeData[] = [...neighbourhood].map((url) => {
    const text = url.startsWith("tags/")
      ? "#" + url.substring(5)
      : (data.get(url)?.title ?? virtualNodeData.get(url)?.title ?? url)
    return {
      id: url,
      text,
      tags: data.get(url)?.tags ?? [],
      isCore: false, // 稍后计算
    }
  })

  // 先创建所有链接
  const allLinks = links
    .filter((l) => neighbourhood.has(l.source) && neighbourhood.has(l.target))
    .map((l) => ({
      source: allNodes.find((n) => n.id === l.source)!,
      target: allNodes.find((n) => n.id === l.target)!,
    }))

  // 全局 graph 时过滤节点
  const isGlobalGraph = graph.classList.contains("global-graph-container")

  // 计算每个节点的连接数
  const nodeLinkCount = new Map<string, number>()
  for (const l of allLinks) {
    nodeLinkCount.set(l.source.id, (nodeLinkCount.get(l.source.id) ?? 0) + 1)
    nodeLinkCount.set(l.target.id, (nodeLinkCount.get(l.target.id) ?? 0) + 1)
  }

  // ====== 永久过滤孤儿节点（连接数=0），这些节点永远不会被渲染 ======
  const nonOrphanNodes = allNodes.filter((n) => (nodeLinkCount.get(n.id) ?? 0) > 0)
  const nonOrphanNodeIds = new Set(nonOrphanNodes.map((n) => n.id))
  // 过滤后的链接（两端都必须是非孤儿节点）
  const nonOrphanLinks = allLinks.filter(
    (l) => nonOrphanNodeIds.has(l.source.id) && nonOrphanNodeIds.has(l.target.id),
  )

  // 为每个非孤儿节点标记是否为核心节点（连接数>1）
  for (const n of nonOrphanNodes) {
    n.isCore = (nodeLinkCount.get(n.id) ?? 0) > 1
  }

  // 核心节点（连接数>1）和边缘节点（连接数=1）
  const coreNodes = nonOrphanNodes.filter((n) => n.isCore)
  const edgeNodes = nonOrphanNodes.filter((n) => !n.isCore)
  const coreNodeIds = new Set(coreNodes.map((n) => n.id))
  const edgeNodeIds = new Set(edgeNodes.map((n) => n.id))

  // 核心节点之间的链接
  const coreLinks = nonOrphanLinks.filter(
    (l) => coreNodeIds.has(l.source.id) && coreNodeIds.has(l.target.id),
  )

  // ====== 构建节点->关联边缘节点的映射（用于手动展开） ======
  // nodeToEdgeNodes: 节点ID -> 与之直接相连的边缘节点列表
  const nodeToEdgeNodes = new Map<SimpleSlug, NodeData[]>()
  // nodeToEdgeLinks: 节点ID -> 与边缘节点相连的链接列表
  const nodeToEdgeLinks = new Map<SimpleSlug, LinkData[]>()

  for (const l of nonOrphanLinks) {
    const sourceIsEdge = edgeNodeIds.has(l.source.id)
    const targetIsEdge = edgeNodeIds.has(l.target.id)

    if (sourceIsEdge && !targetIsEdge) {
      // source是边缘节点，target是非边缘节点
      if (!nodeToEdgeNodes.has(l.target.id)) nodeToEdgeNodes.set(l.target.id, [])
      if (!nodeToEdgeNodes.get(l.target.id)!.some((n) => n.id === l.source.id)) {
        nodeToEdgeNodes.get(l.target.id)!.push(l.source)
      }
      if (!nodeToEdgeLinks.has(l.target.id)) nodeToEdgeLinks.set(l.target.id, [])
      nodeToEdgeLinks.get(l.target.id)!.push(l)
    } else if (!sourceIsEdge && targetIsEdge) {
      // target是边缘节点，source是非边缘节点
      if (!nodeToEdgeNodes.has(l.source.id)) nodeToEdgeNodes.set(l.source.id, [])
      if (!nodeToEdgeNodes.get(l.source.id)!.some((n) => n.id === l.target.id)) {
        nodeToEdgeNodes.get(l.source.id)!.push(l.target)
      }
      if (!nodeToEdgeLinks.has(l.source.id)) nodeToEdgeLinks.set(l.source.id, [])
      nodeToEdgeLinks.get(l.source.id)!.push(l)
    }
  }

  // 为每个节点设置关联边缘节点数量和初始展开状态
  for (const n of nonOrphanNodes) {
    n.edgeNodeCount = nodeToEdgeNodes.get(n.id)?.length ?? 0
    n.isExpanded = false
  }

  let graphData: { nodes: NodeData[]; links: LinkData[] }
  if (isGlobalGraph) {
    // 全局图谱：初始只加载核心节点
    graphData = {
      nodes: [...coreNodes],
      links: [...coreLinks],
    }
  } else {
    // 局部 graph：加载所有非孤儿节点
    graphData = {
      // nodes: nonOrphanNodes,
      nodes: allNodes,
      // links: nonOrphanLinks,
      links: allLinks,
    }
  }

  const width = graph.offsetWidth
  const height = Math.max(graph.offsetHeight, 250)

  // we virtualize the simulation and use pixi to actually render it
  const simulation: Simulation<NodeData, LinkData> = forceSimulation<NodeData>(graphData.nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter().strength(centerForce))
    .force("link", forceLink(graphData.links).distance(linkDistance))
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n)).iterations(3))

  const radius = (Math.min(width, height) / 2) * 0.8
  if (enableRadial) simulation.force("radial", forceRadial(radius).strength(0.2))

  // precompute style prop strings as pixi doesn't support css variables
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

  // calculate color
  const color = (d: NodeData) => {
    const isCurrent = d.id === slug
    if (isCurrent) {
      return computedStyleMap["--secondary"]
    } else if (visited.has(d.id) || d.id.startsWith("tags/")) {
      return computedStyleMap["--tertiary"]
    } else {
      return computedStyleMap["--gray"]
    }
  }

  function nodeRadius(d: NodeData) {
    // 使用预计算的 nodeLinkCount 确保节点大小一致性（不受动态加载影响）
    const numLinks = nodeLinkCount.get(d.id) ?? 0
    return 2 + Math.sqrt(numLinks)
  }

  let hoveredNodeId: string | null = null
  let hoveredNeighbours: Set<string> = new Set()
  const linkRenderData: LinkRenderData[] = []
  const nodeRenderData: NodeRenderData[] = []
  function updateHoverInfo(newHoveredId: string | null) {
    hoveredNodeId = newHoveredId

    if (newHoveredId === null) {
      hoveredNeighbours = new Set()
      for (const n of nodeRenderData) {
        n.active = false
      }

      for (const l of linkRenderData) {
        l.active = false
      }
    } else {
      hoveredNeighbours = new Set()
      for (const l of linkRenderData) {
        const linkData = l.simulationData
        if (linkData.source.id === newHoveredId || linkData.target.id === newHoveredId) {
          hoveredNeighbours.add(linkData.source.id)
          hoveredNeighbours.add(linkData.target.id)
        }

        l.active = linkData.source.id === newHoveredId || linkData.target.id === newHoveredId
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
      let alpha = 1

      // if we are hovering over a node, we want to highlight the immediate neighbours
      // with full alpha and the rest with default alpha
      if (hoveredNodeId) {
        alpha = l.active ? 1 : 0.2
      }

      l.color = l.active ? computedStyleMap["--gray"] : computedStyleMap["--lightgray"]
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
            {
              alpha: 1,
              scale: { x: activeScale, y: activeScale },
            },
            100,
          ),
        )
      } else {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            {
              alpha: n.label.alpha,
              scale: { x: defaultScale, y: defaultScale },
            },
            100,
          ),
        )
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
      let alpha = 1

      // if we are hovering over a node, we want to highlight the immediate neighbours
      if (hoveredNodeId !== null && focusOnHover) {
        alpha = n.active ? 1 : 0.2
      }

      tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
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
    renderNodes()
    renderLinks()
    renderLabels()
  }

  tweens.forEach((tween) => tween.stop())
  tweens.clear()

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
  graph.appendChild(app.canvas)

  const stage = app.stage
  stage.interactive = false

  const labelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
  const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
  const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
  stage.addChild(nodesContainer, labelsContainer, linkContainer)

  // ====== 对象池初始化 ======
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

  for (const n of graphData.nodes) {
    const nodeId = n.id

    const label = new Text({
      interactive: false,
      eventMode: "none",
      text: n.text,
      alpha: 0,
      anchor: { x: 0.5, y: 1.2 },
      style: {
        fontSize: fontSize * 15,
        fill: computedStyleMap["--dark"],
        fontFamily: computedStyleMap["--bodyFont"],
      },
      resolution: window.devicePixelRatio * 4,
    })
    label.scale.set(1 / scale)

    let oldLabelOpacity = 0
    const isTagNode = nodeId.startsWith("tags/")
    const gfx = new Graphics({
      interactive: true,
      label: nodeId,
      eventMode: "static",
      hitArea: new Circle(0, 0, nodeRadius(n)),
      cursor: "pointer",
    })
      .circle(0, 0, nodeRadius(n))
      .fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })
      .on("pointerover", (e) => {
        updateHoverInfo(e.target.label)
        oldLabelOpacity = label.alpha
        if (!dragging) {
          renderPixiFromD3()
        }
      })
      .on("pointerleave", () => {
        updateHoverInfo(null)
        label.alpha = oldLabelOpacity
        if (!dragging) {
          renderPixiFromD3()
        }
      })

    if (isTagNode) {
      gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
    }

    nodesContainer.addChild(gfx)
    labelsContainer.addChild(label)

    const nodeRenderDatum: NodeRenderData = {
      simulationData: n,
      gfx,
      label,
      color: color(n),
      alpha: 1,
      active: false,
    }

    nodeRenderData.push(nodeRenderDatum)
  }

  for (const l of graphData.links) {
    const gfx = new Graphics({ interactive: false, eventMode: "none" })
    linkContainer.addChild(gfx)

    const linkRenderDatum: LinkRenderData = {
      simulationData: l,
      gfx,
      color: computedStyleMap["--lightgray"],
      alpha: 1,
      active: false,
    }

    linkRenderData.push(linkRenderDatum)
  }

  // 创建节点渲染对象的辅助函数（使用对象池）
  function createNodeRenderObject(n: NodeData): NodeRenderData {
    const nodeId = n.id
    const isTagNode = nodeId.startsWith("tags/")
    const radius = nodeRadius(n)

    // 从对象池获取 Text
    const label = textPool.acquire()
    label.text = n.text
    label.alpha = 0
    label.scale.set(1 / scale)

    // 从对象池获取 Graphics
    const gfx = graphicsPool.acquire()
    gfx.label = nodeId
    gfx.hitArea = new Circle(0, 0, radius + 8) // 扩大点击区域
    gfx.circle(0, 0, radius).fill({ color: isTagNode ? computedStyleMap["--light"] : color(n) })

    if (isTagNode) {
      gfx.stroke({ width: 2, color: computedStyleMap["--tertiary"] })
    }

    // 绑定 hover 事件
    gfx.on("pointerover", (e) => {
      updateHoverInfo(e.target.label)
      if (!dragging) {
        renderPixiFromD3()
      }
    })
    gfx.on("pointerleave", () => {
      updateHoverInfo(null)
      if (!dragging) {
        renderPixiFromD3()
      }
    })

    // 设置初始位置（靠近关联的核心节点）
    if (n.x === undefined || n.y === undefined) {
      const connectedCoreNode = graphData.nodes.find(
        (cn) =>
          cn.isCore &&
          allLinks.some(
            (l) =>
              (l.source.id === cn.id && l.target.id === n.id) ||
              (l.target.id === cn.id && l.source.id === n.id),
          ),
      )
      if (
        connectedCoreNode &&
        connectedCoreNode.x !== undefined &&
        connectedCoreNode.y !== undefined
      ) {
        n.x = connectedCoreNode.x + (Math.random() - 0.5) * 50
        n.y = connectedCoreNode.y + (Math.random() - 0.5) * 50
      } else {
        n.x = (Math.random() - 0.5) * width * 0.5
        n.y = (Math.random() - 0.5) * height * 0.5
      }
    }

    nodesContainer.addChild(gfx)
    labelsContainer.addChild(label)

    // ====== 创建徽章（显示关联边缘节点数量）======
    let badge: Graphics | undefined = undefined
    let badgeText: Text | undefined = undefined
    const edgeCount = n.edgeNodeCount ?? 0

    if (isGlobalGraph && edgeCount > 0) {
      // 创建徽章背景（增大尺寸使其更明显）
      badge = new Graphics()
      const badgeRadius = Math.max(8, Math.min(14, 6 + Math.sqrt(edgeCount) * 2))
      badge
        .circle(0, 0, badgeRadius)
        .fill({ color: computedStyleMap["--secondary"] })
        .stroke({ width: 1, color: computedStyleMap["--light"] })

      // 创建徽章文字
      badgeText = new Text({
        text: edgeCount > 99 ? "99+" : String(edgeCount),
        style: {
          fontSize: 10,
          fontFamily: computedStyleMap["--bodyFont"],
          fill: computedStyleMap["--light"],
          fontWeight: "bold",
        },
      })
      badgeText.anchor.set(0.5, 0.5)

      nodesContainer.addChild(badge)
      labelsContainer.addChild(badgeText)
    }

    const nodeRenderDatum: NodeRenderData = {
      simulationData: n,
      gfx,
      label,
      color: color(n),
      alpha: 1,
      active: false,
      badge,
      badgeText,
    }

    return nodeRenderDatum
  }

  // 创建链接渲染对象的辅助函数（使用对象池）
  function createLinkRenderObject(l: LinkData): LinkRenderData {
    const gfx = linkGraphicsPool.acquire()
    linkContainer.addChild(gfx)

    return {
      simulationData: l,
      gfx,
      color: computedStyleMap["--lightgray"],
      alpha: 1,
      active: false,
    }
  }

  // ====== 手动展开/收起节点的函数 ======
  // 记录哪些节点已被展开（展开的节点ID集合）
  const expandedNodeIds = new Set<SimpleSlug>()

  // 展开节点：显示与该节点关联的边缘节点
  function expandNode(nodeId: SimpleSlug) {
    if (expandedNodeIds.has(nodeId)) return // 已展开

    const edgeNodesToAdd = nodeToEdgeNodes.get(nodeId) ?? []
    const edgeLinksToAdd = nodeToEdgeLinks.get(nodeId) ?? []

    if (edgeNodesToAdd.length === 0) return // 没有可展开的边缘节点

    // 找到触发展开的节点，用于设置初始位置
    const parentNode = graphData.nodes.find((n) => n.id === nodeId)

    // 添加边缘节点
    for (const edgeNode of edgeNodesToAdd) {
      // 检查节点是否已存在
      if (graphData.nodes.some((n) => n.id === edgeNode.id)) continue

      // 设置初始位置（在父节点附近）
      if (parentNode && parentNode.x !== undefined && parentNode.y !== undefined) {
        edgeNode.x = parentNode.x + (Math.random() - 0.5) * 80
        edgeNode.y = parentNode.y + (Math.random() - 0.5) * 80
      }

      graphData.nodes.push(edgeNode)
      const renderData = createNodeRenderObject(edgeNode)
      nodeRenderData.push(renderData)
    }

    // 添加边缘链接
    for (const link of edgeLinksToAdd) {
      // 检查链接是否已存在
      if (
        graphData.links.some(
          (l) => l.source.id === link.source.id && l.target.id === link.target.id,
        )
      )
        continue

      graphData.links.push(link)
      const renderData = createLinkRenderObject(link)
      linkRenderData.push(renderData)
    }

    // 更新展开状态
    expandedNodeIds.add(nodeId)
    const nodeData = graphData.nodes.find((n) => n.id === nodeId)
    if (nodeData) nodeData.isExpanded = true

    // 更新 simulation（使用较小的 alpha 避免大幅度布局变化）
    simulation.nodes(graphData.nodes)
    simulation.force("link", forceLink(graphData.links).distance(linkDistance))
    simulation.alpha(0.1).restart()
  }

  // 收起节点：隐藏与该节点关联的边缘节点
  function collapseNode(nodeId: SimpleSlug) {
    if (!expandedNodeIds.has(nodeId)) return // 未展开

    const edgeNodesToRemove = nodeToEdgeNodes.get(nodeId) ?? []

    // 移除边缘节点（回收到对象池）
    for (const edgeNode of edgeNodesToRemove) {
      // 检查该边缘节点是否还被其他展开的节点引用
      let stillReferenced = false
      for (const expandedId of expandedNodeIds) {
        if (expandedId === nodeId) continue
        const otherEdges = nodeToEdgeNodes.get(expandedId) ?? []
        if (otherEdges.some((n) => n.id === edgeNode.id)) {
          stillReferenced = true
          break
        }
      }

      if (stillReferenced) continue // 仍被其他节点引用，不移除

      // 移除渲染对象
      const renderIdx = nodeRenderData.findIndex((r) => r.simulationData.id === edgeNode.id)
      if (renderIdx !== -1) {
        const renderData = nodeRenderData[renderIdx]
        graphicsPool.release(renderData.gfx)
        textPool.release(renderData.label)
        if (renderData.badge) graphicsPool.release(renderData.badge)
        if (renderData.badgeText) textPool.release(renderData.badgeText)
        nodeRenderData.splice(renderIdx, 1)
      }

      // 移除链接
      for (let i = linkRenderData.length - 1; i >= 0; i--) {
        const link = linkRenderData[i].simulationData
        if (link.source.id === edgeNode.id || link.target.id === edgeNode.id) {
          linkGraphicsPool.release(linkRenderData[i].gfx)
          linkRenderData.splice(i, 1)
        }
      }

      // 从 graphData 移除
      const nodeIdx = graphData.nodes.findIndex((n) => n.id === edgeNode.id)
      if (nodeIdx !== -1) graphData.nodes.splice(nodeIdx, 1)

      graphData.links = graphData.links.filter(
        (l) => l.source.id !== edgeNode.id && l.target.id !== edgeNode.id,
      )
    }

    // 更新展开状态
    expandedNodeIds.delete(nodeId)
    const nodeData = graphData.nodes.find((n) => n.id === nodeId)
    if (nodeData) nodeData.isExpanded = false

    // 更新 simulation（使用较小的 alpha 避免大幅度布局变化）
    simulation.nodes(graphData.nodes)
    simulation.force("link", forceLink(graphData.links).distance(linkDistance))
    simulation.alpha(0.05).restart()
  }

  // 切换节点展开/收起状态
  function toggleNodeExpansion(nodeId: SimpleSlug) {
    if (expandedNodeIds.has(nodeId)) {
      collapseNode(nodeId)
    } else {
      expandNode(nodeId)
    }
  }

  let currentTransform = zoomIdentity

  // ====== 双击检测状态 ======
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

          // 短时间内松开 = 点击
          if (Date.now() - dragStartTime < 300) {
            const nodeId = event.subject.id as SimpleSlug
            const now = Date.now()

            // 全局图谱：单击展开/收起，双击跳转
            if (isGlobalGraph) {
              if (lastClickedNodeId === nodeId && now - lastClickTime < DOUBLE_CLICK_DELAY) {
                // 双击：跳转
                const targ = resolveRelative(fullSlug, nodeId)
                window.spaNavigate(new URL(targ, window.location.toString()))
                lastClickedNodeId = null
                lastClickTime = 0
              } else {
                // 单击：展开/收起
                lastClickedNodeId = nodeId
                lastClickTime = now
                toggleNodeExpansion(nodeId)
              }
            } else {
              // 局部图谱：直接跳转
              const targ = resolveRelative(fullSlug, nodeId)
              window.spaNavigate(new URL(targ, window.location.toString()))
            }
          }
        }),
    )
  } else {
    // 非拖拽模式：绑定点击事件
    for (const node of nodeRenderData) {
      let clickTimeout: ReturnType<typeof setTimeout> | null = null

      node.gfx.on("click", () => {
        const nodeId = node.simulationData.id

        if (isGlobalGraph) {
          // 全局图谱：单击展开/收起，双击跳转
          if (clickTimeout) {
            // 双击：取消单击计时器并跳转
            clearTimeout(clickTimeout)
            clickTimeout = null
            const targ = resolveRelative(fullSlug, nodeId)
            window.spaNavigate(new URL(targ, window.location.toString()))
          } else {
            // 可能是单击：设置计时器
            clickTimeout = setTimeout(() => {
              clickTimeout = null
              toggleNodeExpansion(nodeId)
            }, DOUBLE_CLICK_DELAY)
          }
        } else {
          // 局部图谱：直接跳转
          const targ = resolveRelative(fullSlug, nodeId)
          window.spaNavigate(new URL(targ, window.location.toString()))
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
          currentTransform = transform
          stage.scale.set(transform.k, transform.k)
          stage.position.set(transform.x, transform.y)

          // zoom adjusts opacity of labels too
          const scale = transform.k * opacityScale
          let scaleOpacity = Math.max((scale - 1) / 3.75, 0)
          const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)

          for (const label of labelsContainer.children) {
            if (!activeNodes.includes(label)) {
              label.alpha = scaleOpacity
            }
          }
        }),
    )
  }

  let animationId: number | null = null
  function animate(time: number) {
    // 渲染所有节点
    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData
      if (x === undefined || y === undefined) continue

      const posX = x + width / 2
      const posY = y + height / 2
      n.gfx.position.set(posX, posY)
      if (n.label) {
        n.label.position.set(posX, posY)
      }
      // 更新徽章位置（在节点右上角，偏移更大使其更明显）
      if (n.badge) {
        const radius = nodeRadius(n.simulationData)
        n.badge.position.set(posX + radius + 4, posY - radius - 4)
      }
      if (n.badgeText) {
        const radius = nodeRadius(n.simulationData)
        n.badgeText.position.set(posX + radius + 4, posY - radius - 4)
      }
    }

    // 渲染所有链接
    for (const l of linkRenderData) {
      const linkData = l.simulationData
      const sourceX = linkData.source.x
      const sourceY = linkData.source.y
      const targetX = linkData.target.x
      const targetY = linkData.target.y

      if (
        sourceX === undefined ||
        sourceY === undefined ||
        targetX === undefined ||
        targetY === undefined
      ) {
        l.gfx.visible = false
        continue
      }

      l.gfx.visible = true
      l.gfx.clear()
      l.gfx.moveTo(sourceX + width / 2, sourceY + height / 2)
      l.gfx
        .lineTo(targetX + width / 2, targetY + height / 2)
        .stroke({ alpha: l.alpha, width: 1, color: l.color })
    }

    tweens.forEach((t) => t.update(time))
    app.renderer.render(stage)
    animationId = requestAnimationFrame(animate)
  }

  animationId = requestAnimationFrame(animate)
  return () => {
    if (animationId !== null) {
      cancelAnimationFrame(animationId)
      animationId = null
    }
    simulation.stop()  // 停止 D3 forceSimulation，释放内部定时器
    tweens.forEach((t) => t.stop())
    tweens.clear()
    graphicsPool.clear()    // 清理对象池，释放 GPU 内存
    textPool.clear()
    linkGraphicsPool.clear()
    app.destroy()
  }
}

let localGraphCleanups: (() => void)[] = []
let globalGraphCleanups: (() => void)[] = []

function cleanupLocalGraphs() {
  for (const cleanup of localGraphCleanups) {
    cleanup()
  }
  localGraphCleanups = []
}

function cleanupGlobalGraphs() {
  for (const cleanup of globalGraphCleanups) {
    cleanup()
  }
  globalGraphCleanups = []
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const slug = e.detail.url
  addToVisited(simplifySlug(slug))

  async function renderLocalGraph() {
    cleanupLocalGraphs()
    const localGraphContainers = document.getElementsByClassName("graph-container")
    for (const container of localGraphContainers) {
      localGraphCleanups.push(await renderGraph(container as HTMLElement, slug))
    }
  }

  await renderLocalGraph()
  const handleThemeChange = () => {
    void renderLocalGraph()
  }

  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    document.removeEventListener("themechange", handleThemeChange)
  })

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]
  async function renderGlobalGraph() {
    const slug = getFullSlug(window)
    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = "1"
      }

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)
      if (graphContainer) {
        globalGraphCleanups.push(await renderGraph(graphContainer, slug))
      }
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) {
        sidebar.style.zIndex = ""
      }
    }
  }

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyGlobalGraphOpen = containers.some((container) =>
        container.classList.contains("active"),
      )
      anyGlobalGraphOpen ? hideGlobalGraph() : renderGlobalGraph()
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
})

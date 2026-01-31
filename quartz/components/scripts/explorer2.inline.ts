import { FileTrieNode } from "../../util/fileTrie"
import { FullSlug } from "../../util/path"
import { ContentDetails } from "../../plugins/emitters/contentIndex"

// TODO
// - [ ] 添加对 stickyHeaders 选项的支持
// - [ ] 添加对定位按钮功能的支持

// stickyHeaders需要做到；
// - [ ]  吸顶效果：滚动时父级文件夹标题吸附在顶部
// - [ ]  当文件夹项出现在stickyheader时，隐藏对应的普通文件夹项

// 定位需要做到：
// - [ ]  自动展开目标文件所在路径的所有父级文件夹
// - [ ]  滚动定位至目标文件节点（即使其当前未渲染）
// - [ ]  若目标文件不在当前虚拟渲染窗口内，主动触发增量重渲染以确保其可见

type MaybeHTMLElement = HTMLElement | undefined

interface ParsedOptions {
  folderClickBehavior: "collapse" | "link"
  folderDefaultState: "collapsed" | "open"
  useSavedState: boolean
  renderThreshold: number
  virtualScrollThreshold: number
  virtualScrollWindowSize: number
  stickyHeaders: boolean // 吸顶效果：滚动时父级文件夹标题吸附在顶部
  sortFn: (a: FileTrieNode, b: FileTrieNode) => number
  filterFn: (node: FileTrieNode) => boolean
  mapFn: (node: FileTrieNode) => void
  order: "sort" | "filter" | "map"[]
}

type FolderState = {
  path: string
  collapsed: boolean
}

// ========== 步骤 1：扁平化数据层 ==========
// 扁平化节点：树形结构转换为扁平列表后的节点
interface FlatNode {
  node: FileTrieNode // 原始树节点引用
  level: number // 层级深度（0 = 根级）
  parentPath: string // 父级路径
  index: number // 在扁平数组中的索引
}

let currentExplorerState: Array<FolderState>
let globalOpts: ParsedOptions | null = null
let currentActiveSlug: FullSlug | null = null // 当前活跃文件
let isNavigating: boolean = false // 导航锁定标志，防止滚动事件干扰定位

// ========== 扁平化虚拟滚动状态（步骤 1） ==========
let flatNodes: FlatNode[] = [] // 扁平化后的所有节点
let expandedFolders: Set<string> = new Set() // 展开的文件夹 slug 集合
let flatRenderStart: number = 0 // 当前渲染起始索引（步骤 4 使用）
let flatRenderEnd: number = 0 // 当前渲染结束索引（步骤 4 使用）

// 全局引用（用于 refreshFlatExplorer）
let currentTrie: FileTrieNode | null = null // 当前文件树
let currentExplorerUl: Element | null = null // 当前 Explorer UL 元素

/**
 * 切换整个 Explorer 面板的展开/折叠状态
 * 主要用于移动端的菜单切换
 * @this HTMLElement - 触发点击的按钮元素
 */
function toggleExplorer(this: HTMLElement) {
  const nearestExplorer = this.closest(".explorer3") as HTMLElement
  if (!nearestExplorer) return
  const explorerCollapsed = nearestExplorer.classList.toggle("collapsed")
  nearestExplorer.setAttribute(
    "aria-expanded",
    nearestExplorer.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )

  if (!explorerCollapsed) {
    document.documentElement.classList.add("mobile-no-scroll")
  } else {
    document.documentElement.classList.remove("mobile-no-scroll")
  }
}

/**
 * 切换单个文件夹的展开/折叠状态
 * 处理用户点击文件夹箭头或按钮时的交互
 * 包含懒加载触发和状态持久化逻辑
 * @param evt - 鼠标点击事件
 */
function toggleFolder(evt: MouseEvent) {
  evt.stopPropagation()
  const target = evt.target as MaybeHTMLElement
  if (!target) return

  const isSvg = target.nodeName === "svg"

  let folderContainer: MaybeHTMLElement
  if (isSvg) {
    folderContainer = target.parentElement as MaybeHTMLElement
  } else {
    folderContainer = target.closest(".folder3-container") as MaybeHTMLElement
  }

  if (!folderContainer) return

  const folderPath = folderContainer.dataset.folderpath as string
  const wasExpanded = expandedFolders.has(folderPath)

  if (wasExpanded) {
    expandedFolders.delete(folderPath)
  } else {
    expandedFolders.add(folderPath)
  }
  saveExpandedState()

  console.log(
    `%c[toggleFolder] ${folderPath} -> ${wasExpanded ? "折叠" : "展开"}, expandedFolders: ${expandedFolders.size}`,
    "color: #ff8800; font-weight: bold",
  )

  // 重新生成扁平化数据并渲染
  refreshFlatExplorer()
}

/**
 * 创建单个文件节点的 DOM 元素
 * 使用模板克隆方式创建，设置链接和活跃状态
 * @param currentSlug - 当前页面的 slug
 * @param node - 文件节点数据（包含 slug 和 displayName）
 * @param level - 层级深度（用于扁平化结构的缩进），默认值 0（兼容旧调用）
 * @returns 创建的 li 元素
 */
function createFileNode(
  currentSlug: FullSlug,
  node: { slug: FullSlug; displayName: string },
  level: number = 0,
): HTMLLIElement {
  const template = document.getElementById("template-file3") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const a = li.querySelector("a") as HTMLAnchorElement
  // a.href = resolveRelative(currentSlug, node.slug)
  a.href = `/${node.slug}`
  a.dataset.for = node.slug
  a.textContent = node.displayName

  if (currentSlug === node.slug) {
    a.classList.add("active")
    li.dataset.isActive = "true"
  }

  // 步骤 3：扁平化结构动态缩进
  if (level > 0) {
    const indentPx = level * 20 // 每层 20px
    a.style.paddingLeft = `${indentPx + 12}px` // 12px 基础边距
  }

  return li
}

/**
 * 创建简化版文件夹节点（扁平化结构专用）
 * 不包含嵌套的 ul.content，只有文件夹本身的展示
 * @param node - 文件夹节点数据
 * @param level - 层级深度
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @returns 创建的 li 元素
 */
function createSimpleFolderNode(
  node: FileTrieNode,
  level: number,
  currentSlug: FullSlug,
  opts: ParsedOptions,
): HTMLLIElement {
  const template = document.getElementById("template-folder3") as HTMLTemplateElement
  const clone = template.content.cloneNode(true) as DocumentFragment
  const li = clone.querySelector("li") as HTMLLIElement
  const folderContainer = li.querySelector(".folder3-container") as HTMLElement
  const titleContainer = folderContainer.querySelector("div") as HTMLElement
  const folderOuter = li.querySelector(".folder3-outer") as HTMLElement

  // 设置文件夹路径
  const folderPath = node.slug
  folderContainer.dataset.folderpath = folderPath

  // 设置缩进
  const indentPx = level * 20
  folderContainer.style.paddingLeft = `${indentPx + 12}px`

  // 设置文件夹标题
  if (opts.folderClickBehavior === "link") {
    const button = titleContainer.querySelector(".folder3-button") as HTMLElement
    const a = document.createElement("a")
    // a.href = resolveRelative(currentSlug, folderPath)
    a.href = `/${node.slug}`
    a.dataset.for = folderPath
    a.textContent = node.displayName

    if (currentSlug === folderPath) {
      a.classList.add("active")
    }

    button.replaceWith(a)
  } else {
    const wrapper = titleContainer.querySelector(".folder3-content-wrapper") as HTMLElement
    const span = wrapper.querySelector(".folder3-title") as HTMLElement
    span.textContent = node.displayName

    if (currentSlug === folderPath) {
      wrapper.classList.add("active")
    }
  }

  // 设置展开状态（根据 expandedFolders）
  const isExpanded = expandedFolders.has(folderPath)
  if (isExpanded) {
    folderOuter.classList.add("open")
  } else {
    folderOuter.classList.remove("open")
  }

  // 移除 ul.content（扁平化结构不需要嵌套）
  const ul = folderOuter.querySelector("ul")
  if (ul) {
    ul.remove()
  }

  // 绑定点击事件到 SVG 图标（扁平化渲染需要在创建时绑定）
  const svgIcon = folderContainer.querySelector("svg") as SVGElement | null
  if (svgIcon) {
    svgIcon.addEventListener("click", toggleFolder)
  }

  // 如果是 collapse 模式，也绑定到按钮
  if (opts.folderClickBehavior === "collapse") {
    const button = folderContainer.querySelector(".folder3-button") as HTMLElement | null
    if (button) {
      button.addEventListener("click", toggleFolder)
    }
  }

  return li
}

/**
 * 为扁平化结构创建节点元素（文件夹或文件）
 * @param flatNode - 扁平节点数据
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @returns 创建的 li 元素
 */
function createFlatNode(
  flatNode: FlatNode,
  currentSlug: FullSlug,
  opts: ParsedOptions,
): HTMLLIElement {
  const { node, level, index } = flatNode

  let li: HTMLLIElement

  if (node.isFolder) {
    // 创建简化版文件夹节点（不包含嵌套的子元素）
    li = createSimpleFolderNode(node, level, currentSlug, opts)
  } else {
    // 创建文件节点（使用已修改的 createFileNode）
    li = createFileNode(currentSlug, node, level)
  }

  // 设置扁平索引标记
  li.dataset.flatIndex = index.toString()

  return li
}

/**
 * 定位到当前文件：展开所有父级文件夹并滚动到文件位置
 * 由定位按钮触发，调用 navigateToFile 实现
 */
function locateCurrentFile() {
  if (!currentActiveSlug) {
    console.log(`%c[定位] 没有当前活跃文件`, "color: #ff8800")
    return
  }

  console.log(`%c[定位] 开始定位到: ${currentActiveSlug}`, "color: #00aaff; font-weight: bold")

  // 设置导航锁定
  isNavigating = true
  navigateToFile(currentActiveSlug)

  // 使用 requestIdleCallback 在浏览器空闲时解锁
  const unlockNavigating = () => {
    isNavigating = false
    console.log(`%c[定位] 浏览器空闲，导航锁定已解除`, "color: #00cc88")
  }

  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(unlockNavigating, { timeout: 2000 })
  } else {
    setTimeout(unlockNavigating, 500)
  }
}

// 默认文件项高度（px）
// 注意：此值必须与 explorer3.scss 中的 li 高度 (28px) 保持一致
// 如果修改此处，请同步修改 explorer3.scss 中的 li { height: 28px }
const DEFAULT_ITEM_HEIGHT = 38

// ========== 步骤 2：状态管理函数 ==========

/**
 * 从 localStorage 加载展开状态
 */
function loadExpandedState(): Set<string> {
  // 回退方案：从旧的 folderExpandState 迁移
  const oldState = JSON.parse(localStorage.getItem("folderExpandState") || "[]")
  const expanded = oldState
    .filter((state: FolderState) => !state.collapsed)
    .map((state: FolderState) => state.path)

  console.log(
    `%c[loadExpandedState] 从旧 folderExpandState 迁移: ${expanded.length} 个文件夹`,
    "color: #ffaa00",
  )
  return new Set(expanded)
}

/**
 * 保存展开状态到 localStorage
 * 格式：FolderState[]，与 folderExpandState 兼容
 */
function saveExpandedState() {
  if (!currentExplorerState || currentExplorerState.length === 0) {
    console.warn(
      `%c[saveExpandedState] currentExplorerState 未初始化或为空，跳过保存`,
      "color: #ff6600; font-weight: bold",
    )
    return
  }

  const folderStates = currentExplorerState.map((item) => ({
    path: item.path,
    collapsed: !expandedFolders.has(item.path),
  }))

  localStorage.setItem("folderExpandState", JSON.stringify(folderStates))
  console.log(
    `%c[saveExpandedState] 保存到 localStorage: ${folderStates.length} 个文件夹状态`,
    "color: #00ff00",
  )
}

// ========== 步骤 1：扁平化数据层函数 ==========

/**
 * 将树形结构转换为扁平数组
 * @param node - 当前节点
 * @param level - 当前层级深度
 * @param parentPath - 父级路径
 * @param result - 结果数组
 * @returns 扁平化节点数组
 */
function flattenTree(
  node: FileTrieNode,
  level: number,
  parentPath: string,
  result: FlatNode[] = [],
): FlatNode[] {
  const flatNode: FlatNode = {
    node,
    level,
    parentPath,
    index: result.length,
  }

  result.push(flatNode)

  // 只在文件夹展开时递归子节点
  if (node.isFolder && expandedFolders.has(node.slug)) {
    node.children.forEach((child) => {
      flattenTree(child, level + 1, node.slug, result)
    })
  }

  return result
}

/**
 * 扁平化树形结构的入口函数
 * @param trie - 文件树根节点
 * @returns 扁平化节点数组
 */
function flattenTreeRoot(trie: FileTrieNode): FlatNode[] {
  const result: FlatNode[] = []
  trie.children.forEach((child) => {
    flattenTree(child, 0, "", result)
  })
  return result
}

// ========== 步骤 5：吸顶效果相关函数 ==========

/**
 * 文件夹范围：记录每个文件夹在 flatNodes 中的起止索引
 */
interface FolderRange {
  start: number // 文件夹标题在 flatNodes 中的索引
  end: number // 最后一个子节点的索引
  folderSlug: string // 文件夹 slug
  level: number // 层级深度
}

// 文件夹范围缓存
let folderRanges: Map<string, FolderRange> = new Map()

/**
 * 计算所有文件夹的范围
 * @param nodes - 扁平化节点数组
 * @returns 文件夹范围 Map
 */
function calculateFolderRanges(nodes: FlatNode[]): Map<string, FolderRange> {
  const ranges = new Map<string, FolderRange>()

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.node.isFolder) {
      const folderSlug = node.node.slug
      let end = i

      // 找到该文件夹的最后一个子节点
      for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[j].level <= node.level) break
        end = j
      }

      ranges.set(folderSlug, {
        start: i,
        end,
        folderSlug,
        level: node.level,
      })
    }
  }

  return ranges
}

/**
 * 计算应该吸顶的文件夹索引
 * @param nodes - 扁平化节点数组
 * @param ranges - 文件夹范围 Map
 * @param viewportStart - 视窗起始索引
 * @param viewportEnd - 视窗结束索引
 * @returns 应该吸顶的文件夹索引数组（按层级排序，level 小的在前）
 */
function calculateStickyFolders(
  nodes: FlatNode[],
  ranges: Map<string, FolderRange>,
  viewportStart: number,
  _viewportEnd: number, // 保留供将来使用
): number[] {
  const stickyIndices: number[] = []

  for (const [, range] of ranges) {
    // 条件1: 文件夹标题已经滚出视窗顶部（start < viewportStart）
    // 条件2: 文件夹的内容还在视窗内（end >= viewportStart）
    if (range.start < viewportStart && range.end >= viewportStart) {
      stickyIndices.push(range.start)
    }
  }

  // 按层级排序：level 小的在前（顶部），level 大的在后（靠近内容）
  stickyIndices.sort((a, b) => nodes[a].level - nodes[b].level)

  return stickyIndices
}

// ========== 步骤 4：单滚动条虚拟滚动函数 ==========

/**
 * 使用扁平化数据渲染 Explorer
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @param scrollTop - 当前滚动位置（用于计算初始渲染范围）
 */
function renderFlatExplorer(
  explorerUl: Element,
  currentSlug: FullSlug,
  opts: ParsedOptions,
  scrollTop: number = 0,
) {
  // 清空现有内容
  explorerUl.innerHTML = ""

  const totalCount = flatNodes.length
  const windowSize = opts.virtualScrollWindowSize || 50
  const buffer = Math.floor(windowSize / 4)

  // 根据滚动位置计算初始渲染范围
  const scrollBasedStart = Math.floor(scrollTop / DEFAULT_ITEM_HEIGHT)
  flatRenderStart = Math.max(0, scrollBasedStart - buffer)
  flatRenderEnd = Math.min(totalCount, flatRenderStart + windowSize)

  // 确保至少渲染 windowSize 个节点
  if (flatRenderEnd - flatRenderStart < windowSize) {
    if (flatRenderStart === 0) {
      flatRenderEnd = Math.min(windowSize, totalCount)
    } else if (flatRenderEnd === totalCount) {
      flatRenderStart = Math.max(0, totalCount - windowSize)
    }
  }

  console.log(
    `%c[renderFlatExplorer] 滚动位置: ${scrollTop}, 渲染范围: [${flatRenderStart}, ${flatRenderEnd})`,
    "color: #00ff00; font-weight: bold",
  )

  // 创建吸顶容器（仅在启用时创建）
  if (opts.stickyHeaders) {
    const stickyContainer = document.createElement("div")
    stickyContainer.className = "sticky-headers"
    explorerUl.appendChild(stickyContainer)
  }

  // 创建顶部占位元素
  const topSpacer = document.createElement("div")
  topSpacer.className = "virtual-spacer-top"
  topSpacer.style.height = `${flatRenderStart * DEFAULT_ITEM_HEIGHT}px`
  explorerUl.appendChild(topSpacer)

  // 渲染初始节点
  const fragment = document.createDocumentFragment()
  for (let i = flatRenderStart; i < flatRenderEnd; i++) {
    const li = createFlatNode(flatNodes[i], currentSlug, opts)
    fragment.appendChild(li)
  }
  explorerUl.appendChild(fragment)

  // 创建底部占位元素
  const bottomSpacer = document.createElement("div")
  bottomSpacer.className = "virtual-spacer-bottom"
  bottomSpacer.style.height = `${(totalCount - flatRenderEnd) * DEFAULT_ITEM_HEIGHT}px`
  explorerUl.appendChild(bottomSpacer)
}

/**
 * 刷新扁平化 Explorer（用于展开/折叠后重新渲染）
 * 使用全局的 currentTrie 和 currentExplorerUl
 */
function refreshFlatExplorer() {
  if (!currentTrie || !currentExplorerUl || !globalOpts || !currentActiveSlug) {
    console.warn("[refreshFlatExplorer] 缺少必要的全局引用")
    return
  }

  // 重新扁平化树（使用更新后的 expandedFolders）
  flatNodes = flattenTreeRoot(currentTrie)

  // 重新计算文件夹范围（仅在启用吸顶效果时）
  if (globalOpts.stickyHeaders) {
    folderRanges = calculateFolderRanges(flatNodes)
  }

  console.log(
    `%c[refreshFlatExplorer] 重新扁平化: ${flatNodes.length} 个节点, expandedFolders: ${expandedFolders.size}${globalOpts.stickyHeaders ? `, folderRanges: ${folderRanges.size}` : ""}`,
    "color: #00ccff; font-weight: bold",
  )

  // 保存当前滚动位置
  const scrollTop = currentExplorerUl.scrollTop

  // 重新渲染（保持当前滚动位置）
  renderFlatExplorer(currentExplorerUl, currentActiveSlug, globalOpts, scrollTop)
}

/**
 * 设置单滚动条虚拟滚动监听器
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function setupFlatVirtualScroll(explorerUl: Element, currentSlug: FullSlug, opts: ParsedOptions) {
  let ticking = false

  const handleScroll = () => {
    if (ticking || isNavigating) return
    ticking = true

    requestAnimationFrame(() => {
      updateFlatVirtualScroll(explorerUl as HTMLElement, currentSlug, opts)
      ticking = false
    })
  }

  explorerUl.addEventListener("scroll", handleScroll, { passive: true })
  window.addCleanup(() => explorerUl.removeEventListener("scroll", handleScroll))

  console.log(`%c[setupFlatVirtualScroll] 已注册单滚动条监听器`, "color: #aa00ff")
}

/**
 * 更新单滚动条虚拟滚动
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function updateFlatVirtualScroll(
  explorerUl: HTMLElement,
  currentSlug: FullSlug,
  opts: ParsedOptions,
) {
  const windowSize = opts.virtualScrollWindowSize || 50
  const scrollTop = explorerUl.scrollTop
  const viewportHeight = explorerUl.clientHeight
  const totalCount = flatNodes.length

  // 计算当前可见范围
  const visibleStart = Math.floor(scrollTop / DEFAULT_ITEM_HEIGHT)
  const visibleEnd = Math.ceil((scrollTop + viewportHeight) / DEFAULT_ITEM_HEIGHT)

  // 计算新的渲染范围（加上缓冲区）
  const buffer = Math.floor(windowSize / 4)
  let newStart = Math.max(0, visibleStart - buffer)
  let newEnd = Math.min(totalCount, visibleEnd + buffer)

  // 确保至少渲染 windowSize 个节点
  if (newEnd - newStart < windowSize) {
    if (newStart === 0) {
      newEnd = Math.min(windowSize, totalCount)
    } else if (newEnd === totalCount) {
      newStart = Math.max(0, totalCount - windowSize)
    }
  }

  // 边界强制更新：当接近顶部或底部时，强制更新到边界值
  const atTop = scrollTop < DEFAULT_ITEM_HEIGHT * 2
  const atBottom = scrollTop + viewportHeight >= (totalCount - 2) * DEFAULT_ITEM_HEIGHT

  if (atTop && flatRenderStart !== 0) {
    newStart = 0
    newEnd = Math.min(windowSize, totalCount)
  } else if (atBottom && flatRenderEnd !== totalCount) {
    newEnd = totalCount
    newStart = Math.max(0, totalCount - windowSize)
  }

  // 如果范围没有明显变化，不更新（但边界情况除外）
  const threshold = Math.floor(buffer / 2)
  const needsBoundaryUpdate =
    (atTop && flatRenderStart !== 0) || (atBottom && flatRenderEnd !== totalCount)
  if (
    !needsBoundaryUpdate &&
    Math.abs(newStart - flatRenderStart) < threshold &&
    Math.abs(newEnd - flatRenderEnd) < threshold
  ) {
    return
  }

  console.log(
    `%c[updateFlatVirtualScroll] 更新范围: [${flatRenderStart}, ${flatRenderEnd}) -> [${newStart}, ${newEnd})${needsBoundaryUpdate ? " (边界强制)" : ""}`,
    "color: #00cc88",
  )

  // 更新状态
  flatRenderStart = newStart
  flatRenderEnd = newEnd

  // 重新渲染
  rerenderFlatList(explorerUl, currentSlug, opts)

  // 更新吸顶文件夹（仅在启用时）
  if (opts.stickyHeaders) {
    updateStickyHeaders(explorerUl, currentSlug, opts, visibleStart)
  }
}

/**
 * 更新吸顶文件夹
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 * @param viewportStart - 视窗起始索引
 */
function updateStickyHeaders(
  explorerUl: HTMLElement,
  currentSlug: FullSlug,
  opts: ParsedOptions,
  viewportStart: number,
) {
  const stickyContainer = explorerUl.querySelector(".sticky-headers") as HTMLElement
  if (!stickyContainer) return

  // 计算应该吸顶的文件夹
  const stickyIndices = calculateStickyFolders(
    flatNodes,
    folderRanges,
    viewportStart,
    viewportStart + Math.ceil(explorerUl.clientHeight / DEFAULT_ITEM_HEIGHT),
  )

  // 如果没有需要吸顶的文件夹，清空容器
  if (stickyIndices.length === 0) {
    stickyContainer.innerHTML = ""
    stickyContainer.style.display = "none"
    return
  }

  // 检查是否需要更新（比较当前吸顶的文件夹索引）
  const currentStickyIndices = Array.from(
    stickyContainer.querySelectorAll("[data-flat-index]"),
  ).map((el) => parseInt((el as HTMLElement).dataset.flatIndex || "-1"))

  if (
    currentStickyIndices.length === stickyIndices.length &&
    currentStickyIndices.every((idx, i) => idx === stickyIndices[i])
  ) {
    return // 无需更新
  }

  // 清空并重新渲染吸顶文件夹
  stickyContainer.innerHTML = ""
  stickyContainer.style.display = "block"

  const fragment = document.createDocumentFragment()
  for (const idx of stickyIndices) {
    const flatNode = flatNodes[idx]
    const li = createFlatNode(flatNode, currentSlug, opts)
    li.classList.add("sticky-header")
    fragment.appendChild(li)
  }
  stickyContainer.appendChild(fragment)
}

/**
 * 重新渲染扁平化列表
 * @param explorerUl - Explorer 的 ul 容器
 * @param currentSlug - 当前页面 slug
 * @param opts - 配置选项
 */
function rerenderFlatList(explorerUl: HTMLElement, currentSlug: FullSlug, opts: ParsedOptions) {
  const totalCount = flatNodes.length

  // 更新顶部占位
  const topSpacer = explorerUl.querySelector(".virtual-spacer-top") as HTMLElement
  if (topSpacer) {
    topSpacer.style.height = `${flatRenderStart * DEFAULT_ITEM_HEIGHT}px`
  }

  // 更新底部占位
  const bottomSpacer = explorerUl.querySelector(".virtual-spacer-bottom") as HTMLElement
  if (bottomSpacer) {
    bottomSpacer.style.height = `${(totalCount - flatRenderEnd) * DEFAULT_ITEM_HEIGHT}px`
  }

  // 移除现有的节点（保留占位元素）
  const existingItems = explorerUl.querySelectorAll("li[data-flat-index]")
  existingItems.forEach((item) => item.remove())

  // 渲染新范围的节点
  const fragment = document.createDocumentFragment()
  for (let i = flatRenderStart; i < flatRenderEnd; i++) {
    const li = createFlatNode(flatNodes[i], currentSlug, opts)
    fragment.appendChild(li)
  }

  // 插入到顶部占位之后
  if (topSpacer) {
    topSpacer.after(fragment)
  }

  console.log(`%c[rerenderFlatList] 重新渲染完成`, "color: #00ff00")
}

/**
 * 清除所有高亮状态
 */
function clearHighlight() {
  const activeElements = document.querySelectorAll(".explorer3 .active")
  activeElements.forEach((el) => el.classList.remove("active"))

  const pathElements = document.querySelectorAll(".explorer3 .in-active-path")
  pathElements.forEach((el) => el.classList.remove("in-active-path"))
}

/**
 * 高亮目标元素及其父级路径
 * @param targetElement - 目标元素
 */
function highlightPath(targetElement: Element) {
  clearHighlight()
  targetElement.classList.add("active")

  // 向上查找并高亮父级文件夹
  let parent = targetElement.closest("li")
  while (parent) {
    parent.classList.add("in-active-path")
    parent = parent.parentElement?.closest("li") || null
  }
}

/**
 * 定位到指定文件（扁平化版本）
 * @param targetSlug - 目标文件的 slug
 * @returns 是否成功定位
 */
function navigateToFile(targetSlug: FullSlug): boolean {
  // 找到目标文件在 flatNodes 中的索引
  const targetIndex = flatNodes.findIndex((fn) => fn.node.slug === targetSlug && !fn.node.isFolder)

  if (targetIndex === -1) {
    console.log(`%c[导航定位] 未找到目标文件: ${targetSlug}`, "color: #ff0000")
    return false
  }

  // 确保目标文件的所有父级文件夹都展开
  const targetNode = flatNodes[targetIndex]
  let needsRefresh = false

  // 向前查找所有父级文件夹并展开
  for (let i = targetIndex - 1; i >= 0; i--) {
    const node = flatNodes[i]
    if (node.node.isFolder && node.level < targetNode.level) {
      if (!expandedFolders.has(node.node.slug)) {
        expandedFolders.add(node.node.slug)
        needsRefresh = true
      }
      if (node.level === 0) break
    }
  }

  if (needsRefresh) {
    saveExpandedState()
    refreshFlatExplorer()
  }

  // 找到目标元素并滚动
  const targetLi = document.querySelector(`li[data-flat-index="${targetIndex}"]`)
  if (targetLi) {
    const targetLink = targetLi.querySelector("a")
    if (targetLink) {
      highlightPath(targetLink)
    }
    targetLi.scrollIntoView({ behavior: "instant", block: "center" })
    console.log(`%c[导航定位] 已定位到: ${targetSlug}`, "color: #00cc88")
    return true
  }

  return false
}

/**
 * 异步重建 trie 数据（供展开/折叠、定位等交互使用）
 * 不阻塞 UI 渲染
 */
async function rebuildTrieData(opts: ParsedOptions) {
  try {
    const data = await fetchData
    const entries = [...Object.entries(data)] as [FullSlug, ContentDetails][]
    const trie = FileTrieNode.fromEntries(entries)

    for (const fn of opts.order) {
      switch (fn) {
        case "filter":
          if (opts.filterFn) trie.filter(opts.filterFn)
          break
        case "map":
          if (opts.mapFn) trie.map(opts.mapFn)
          break
        case "sort":
          if (opts.sortFn) trie.sort(opts.sortFn)
          break
      }
    }

    currentTrie = trie
    flatNodes = flattenTreeRoot(trie)

    if (opts.stickyHeaders) {
      folderRanges = calculateFolderRanges(flatNodes)
    }

    console.log("[rebuildTrieData] 异步重建完成，flatNodes:", flatNodes.length)
  } catch (e) {
    console.warn("[rebuildTrieData] 失败:", e)
  }
}

/**
 * 确保 trie 数据层已初始化
 * 在缓存恢复或 SPA 跳转后调用，确保 currentTrie 和 currentExplorerState 可用
 * @param opts - 配置选项
 */
async function ensureTrieInitialized(opts: ParsedOptions): Promise<void> {
  if (currentTrie && currentExplorerState) {
    console.log(
      `%c[ensureTrieInitialized] 已初始化，跳过`,
      "color: #888",
    )
    return // 已初始化，无需重复
  }

  console.log(
    `%c[ensureTrieInitialized] 开始初始化数据层... currentTrie=${!!currentTrie}, currentExplorerState=${!!currentExplorerState}`,
    "color: #ffaa00; font-weight: bold",
  )

  const storageTree = localStorage.getItem("folderExpandState")
  const serializedExplorerState =
    storageTree && opts.useSavedState ? JSON.parse(storageTree) : []
  const oldIndex = new Map<string, boolean>(
    serializedExplorerState.map((entry: FolderState) => [entry.path, entry.collapsed]),
  )

  await rebuildTrieData(opts)

  if (currentTrie) {
    const folderPaths = currentTrie.getFolderPaths()
    currentExplorerState = folderPaths.map((path) => {
      const previousState = oldIndex.get(path)
      return {
        path,
        collapsed:
          previousState === undefined
            ? opts.folderDefaultState === "collapsed"
            : previousState,
      }
    })

    // 同时初始化 expandedFolders，确保与 currentExplorerState 一致
    const savedExpandedFolders = loadExpandedState()
    const stateExpandedFolders = new Set(
      currentExplorerState.filter((item) => !item.collapsed).map((item) => item.path),
    )
    expandedFolders = new Set([...savedExpandedFolders, ...stateExpandedFolders])

    console.log(
      `%c[ensureTrieInitialized] 初始化完成: ${folderPaths.length} 个文件夹, ${expandedFolders.size} 个已展开`,
      "color: #00ff00",
    )
  } else {
    console.warn("[ensureTrieInitialized] currentTrie 仍为 null，初始化失败")
  }
}

/**
 * 从缓存恢复 Explorer UI
 */
function restoreFromCache(explorerUl: Element, currentSlug: FullSlug) {
  explorerUl.innerHTML = sessionStorage.getItem("explorer3Html") || ""
  explorerUl.scrollTop = parseInt(sessionStorage.getItem("explorer3ScrollTop") || "0")
  flatRenderStart = parseInt(sessionStorage.getItem("explorer3RenderStart") || "0")
  flatRenderEnd = parseInt(sessionStorage.getItem("explorer3RenderEnd") || "0")
  
  // 注意：不再从 sessionStorage 恢复 expandedFolders
  // expandedFolders 将在 ensureTrieInitialized 中从 localStorage 重建，确保与 currentExplorerState 一致

  // 更新 active 状态
  const currentLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
  if (currentLink) {
    highlightPath(currentLink)
  }

  console.log("[restoreFromCache] 恢复完成（expandedFolders 将由 ensureTrieInitialized 设置）")
}

/**
 * 初始化 Explorer3 组件
 * 核心入口函数，在每次 nav 事件时调用
 * 有缓存时快速恢复，无缓存时完整初始化
 */
async function setupExplorer3(currentSlug: FullSlug) {
  console.log("[setupExplorer3] Setting up explorer for slug:", currentSlug)

  const allExplorers = document.querySelectorAll("div.explorer3") as NodeListOf<HTMLElement>

  for (const explorer of allExplorers) {
    const dataFns = JSON.parse(explorer.dataset.dataFns || "{}")
    const opts: ParsedOptions = {
      folderClickBehavior: (explorer.dataset.behavior || "collapse") as "collapse" | "link",
      folderDefaultState: (explorer.dataset.collapsed || "collapsed") as "collapsed" | "open",
      useSavedState: explorer.dataset.savestate === "true",
      renderThreshold: parseInt(explorer.dataset.renderthreshold || "0"),
      virtualScrollThreshold: parseInt(explorer.dataset.virtualscrollthreshold || "200"),
      virtualScrollWindowSize: parseInt(explorer.dataset.virtualscrollwindowsize || "50"),
      stickyHeaders: explorer.dataset.stickyheaders !== "false",
      order: dataFns.order || ["filter", "map", "sort"],
      sortFn: new Function("return " + (dataFns.sortFn || "undefined"))(),
      filterFn: new Function("return " + (dataFns.filterFn || "undefined"))(),
      mapFn: new Function("return " + (dataFns.mapFn || "undefined"))(),
    }

    // 保存全局配置
    globalOpts = opts

    const explorerUl = explorer.querySelector(".explorer3-ul")
    if (!explorerUl) continue

    // 设置全局引用
    currentActiveSlug = currentSlug
    currentExplorerUl = explorerUl

    // 场景判断：
    // 1. 当前 DOM 有真实节点 → SPA 跳转，直接用 DOM，只更新 active
    // 2. 当前 DOM 无节点但缓存有真实内容 → 从缓存恢复
    // 3. 缓存也没有真实内容 → 首次加载，完整渲染
    const cachedHtml = sessionStorage.getItem("explorer3Html")
    const hasRealContentInDom = explorerUl.querySelectorAll("li[data-flat-index]").length > 0
    const hasRealContentInCache = cachedHtml && cachedHtml.includes("data-flat-index")

    console.log(
      `[setupExplorer3] hasRealContentInDom=${hasRealContentInDom}, hasRealContentInCache=${hasRealContentInCache}`,
    )

    if (hasRealContentInDom) {
      // ========== SPA 跳转：DOM 非空，直接用，只更新 active ==========
      console.log("[setupExplorer3] SPA 跳转，DOM 非空，只更新 active")
      
      // 防御性检查：确保数据层存在（理论上 SPA 跳转时应该已初始化）
      await ensureTrieInitialized(opts)
      
      const currentLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
      if (currentLink) {
        highlightPath(currentLink)
      } else {
        clearHighlight()
        console.log("[setupExplorer3] 当前页面不在渲染范围内，已清除 active")
      }
    } else if (hasRealContentInCache) {
      // ========== 从缓存恢复 ==========
      console.log("[setupExplorer3] 从缓存恢复")
      restoreFromCache(explorerUl, currentSlug)

      // 确保数据层已初始化（关键修复：支持后续交互如 toggleFolder）
      // 这里会从 localStorage 重新构建 expandedFolders
      await ensureTrieInitialized(opts)

      // 同步 DOM 箭头状态：因为 HTML 是从缓存恢复的，箭头方向可能与新的 expandedFolders 不一致
      // 需要更新所有文件夹的箭头方向
      const allFolders = explorerUl.querySelectorAll("li.folder")
      allFolders.forEach((li) => {
        const folderPath = li.getAttribute("data-folderpath")
        if (folderPath) {
          const button = li.firstElementChild as HTMLElement
          if (button && button.classList.contains("folder-button")) {
            const isExpanded = expandedFolders.has(folderPath)
            button.classList.toggle("collapsed", !isExpanded)
            console.log(
              `%c[syncArrows] ${folderPath}: ${isExpanded ? "展开" : "折叠"}`,
              "color: #888; font-size: 10px",
            )
          }
        }
      })

      // 检查当前页面是否在渲染范围内
      const currentLink = explorerUl.querySelector(`a[data-for="${currentSlug}"]`)
      if (!currentLink) {
        clearHighlight()
        console.log("[setupExplorer3] 当前页面不在渲染范围内，已清除 active")
      }
    } else {
      // ========== 首次加载：完整初始化 ==========
      console.log("[setupExplorer3] 首次加载，完整初始化")

      // 后台异步重建 trie（供展开/折叠使用）
      // 加载状态
      const storageTree = localStorage.getItem("folderExpandState")
      const serializedExplorerState =
        storageTree && opts.useSavedState ? JSON.parse(storageTree) : []
      const oldIndex = new Map<string, boolean>(
        serializedExplorerState.map((entry: FolderState) => [entry.path, entry.collapsed]),
      )

      await rebuildTrieData(opts)

      const folderPaths = currentTrie!.getFolderPaths()
      currentExplorerState = folderPaths.map((path) => {
        const previousState = oldIndex.get(path)
        return {
          path,
          collapsed:
            previousState === undefined ? opts.folderDefaultState === "collapsed" : previousState,
        }
      })

      // 初始化展开状态
      const savedExpandedFolders = loadExpandedState()
      const stateExpandedFolders = new Set(
        currentExplorerState.filter((item) => !item.collapsed).map((item) => item.path),
      )
      expandedFolders = new Set([...savedExpandedFolders, ...stateExpandedFolders])

      // 自动展开当前路径上的父级文件夹
      const currentPathParts = currentSlug.split("/")
      for (let i = 1; i < currentPathParts.length; i++) {
        const ancestorPath = currentPathParts.slice(0, i).join("/") + "/index"
        const folderState = currentExplorerState.find((item) => item.path === ancestorPath)
        if (folderState) expandedFolders.add(ancestorPath)
      }
      for (let i = 1; i <= currentPathParts.length; i++) {
        const ancestorPath = currentPathParts.slice(0, i).join("/")
        const folderState = currentExplorerState.find(
          (item) => item.path === ancestorPath || item.path === ancestorPath + "/index",
        )
        if (folderState) expandedFolders.add(folderState.path)
      }

      saveExpandedState()

      // 渲染
      const oldTopSpacer = explorerUl.querySelector(".virtual-spacer-top")
      const oldBottomSpacer = explorerUl.querySelector(".virtual-spacer-bottom")
      const oldStickyHeaders = explorerUl.querySelector(".sticky-headers")
      if (oldTopSpacer) oldTopSpacer.remove()
      if (oldBottomSpacer) oldBottomSpacer.remove()
      if (oldStickyHeaders) oldStickyHeaders.remove()

      const initialScrollTop = parseInt(sessionStorage.getItem("explorer3ScrollTop") || "0")
      renderFlatExplorer(explorerUl, currentSlug, opts, initialScrollTop)
      explorerUl.scrollTop = initialScrollTop
    }

    // 共同设置：虚拟滚动监听
    setupFlatVirtualScroll(explorerUl as HTMLElement, currentSlug, opts)

    // 首次加载时禁用虚拟滚动更新
    isNavigating = true
    const unlockNavigating = () => {
      isNavigating = false
    }
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(unlockNavigating, { timeout: 2000 })
    } else {
      setTimeout(unlockNavigating, 500)
    }

    // 定位按钮事件
    const locateBtn = explorer.querySelector(".locate-current-btn")
    if (locateBtn) {
      locateBtn.addEventListener("click", locateCurrentFile)
      window.addCleanup(() => locateBtn.removeEventListener("click", locateCurrentFile))
    }

    // Explorer 切换事件
    const explorerButtons = explorer.getElementsByClassName(
      "explorer3-toggle",
    ) as HTMLCollectionOf<HTMLElement>
    for (const button of explorerButtons) {
      button.addEventListener("click", toggleExplorer)
      window.addCleanup(() => button.removeEventListener("click", toggleExplorer))
    }

    // 文件夹点击事件
    if (opts.folderClickBehavior === "collapse") {
      const folderButtons = explorer.getElementsByClassName(
        "folder3-button",
      ) as HTMLCollectionOf<HTMLElement>
      for (const button of folderButtons) {
        button.addEventListener("click", toggleFolder)
        window.addCleanup(() => button.removeEventListener("click", toggleFolder))
      }
    }

    const folderIcons = explorer.getElementsByClassName(
      "folder3-icon",
    ) as HTMLCollectionOf<HTMLElement>
    for (const icon of folderIcons) {
      icon.addEventListener("click", toggleFolder)
      window.addCleanup(() => icon.removeEventListener("click", toggleFolder))
    }
  }
}

// 步骤 4：保存滚动位置（参考 explorer2）
document.addEventListener("prenav", async () => {
  const explorerUl = document.querySelector(".explorer3-ul")
  if (!explorerUl) return

  // 保存各个数据到独立的 sessionStorage 键
  // 注意：不再缓存 expandedFolders，改为从 localStorage 重建以保证状态一致性
  sessionStorage.setItem("explorer3Html", explorerUl.innerHTML)
  sessionStorage.setItem("explorer3ScrollTop", explorerUl.scrollTop.toString())
  sessionStorage.setItem("explorer3RenderStart", flatRenderStart.toString())
  sessionStorage.setItem("explorer3RenderEnd", flatRenderEnd.toString())
})

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  currentActiveSlug = currentSlug // 保存当前活跃文件
  console.log(`%c[NAV事件] 导航到: ${currentSlug}`, "color: #ff00ff; font-weight: bold")

  await setupExplorer3(currentSlug)

  for (const explorer of document.getElementsByClassName("explorer3")) {
    const mobileExplorer = explorer.querySelector(".mobile-explorer")
    if (!mobileExplorer) continue

    if (mobileExplorer.checkVisibility()) {
      explorer.classList.add("collapsed")
      explorer.setAttribute("aria-expanded", "false")
      document.documentElement.classList.remove("mobile-no-scroll")
    }

    mobileExplorer.classList.remove("hide-until-loaded")
  }
})

window.addEventListener("resize", function () {
  const explorer = document.querySelector(".explorer3")
  if (explorer && !explorer.classList.contains("collapsed")) {
    document.documentElement.classList.add("mobile-no-scroll")
    return
  }
})

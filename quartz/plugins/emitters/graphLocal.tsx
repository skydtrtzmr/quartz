import { QuartzEmitterPlugin } from "../types"
import { FullSlug, SimpleSlug, simplifySlug, joinSegments } from "../../util/path"
import { write } from "./helpers"
import { ContentDetails } from "./contentIndex"

// LocalGraphEdge 与 graph.inline.ts 中的 SimpleLinkData 对应
interface LocalGraphEdge {
  source: SimpleSlug
  target: SimpleSlug
  sourceField?: string // frontmatter field name, undefined for body references
}

// LocalGraphData.nodes 使用与 ContentDetails 一致的结构
// 这样 graph2.inline.ts 可以用相同的逻辑解析
interface LocalGraphData {
  version: number
  center: SimpleSlug // center node slug (renamed from 'slug' for clarity)
  depth: number
  generatedAt: number
  // nodes 格式与 contentIndex.json 中的条目格式一致
  nodes: Record<SimpleSlug, ContentDetails>
  edges: LocalGraphEdge[]
  /** 目录路径到 index.md frontmatter.title 的映射，供局部图谱聚合显示使用。 */
  folderTitles: Record<string, string>
}

interface Options {
  // depth 已移除，统一使用 cfg.graph.localDepth
  showTags: boolean
  removeTags: string[]
}

const defaultOptions: Options = {
  showTags: true,
  removeTags: [],
}

// 纯 JS djb2 哈希（与 graph2.inline.ts 保持一致，兼容 HTTP 非安全上下文）
function djb2Hash(message: string): string {
  let hash = 5381
  for (let i = 0; i < message.length; i++) {
    hash = (hash << 5) + hash + message.charCodeAt(i)
    hash = hash & 0xffffffff
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// Get local graph storage path (hierarchical directory)
// Structure: {hash(0,2)}/{hash(2,2)}/{slug}.json
// slug may contain '/', which creates subdirectories matching the original path structure
function getLocalGraphPath(slug: SimpleSlug): string {
  const hash = djb2Hash(slug).slice(0, 4)
  const dir1 = hash.slice(0, 2)
  const dir2 = hash.slice(2, 4)
  return `${dir1}/${dir2}/${slug}`
}

function buildFolderTitles(linkIndex: Map<SimpleSlug, ContentDetails>): Record<string, string> {
  const folderTitles: Record<string, string> = {}
  for (const [slug, details] of linkIndex.entries()) {
    const filePath = details.filePath as unknown as string | undefined
    const title = details.frontmatter?.title
    if (
      filePath &&
      (filePath === "index.md" || filePath.endsWith("/index.md")) &&
      typeof title === "string" &&
      title.trim() !== ""
    ) {
      const key = slug === "/" ? "/" : slug.replace(/^\/+|\/+$/g, "")
      folderTitles[key] = title.trim()
    }
  }
  return folderTitles
}

// Find frontmatter field containing the target link
function getFrontmatterFieldForLink(frontmatter: any, targetLink: string): string | undefined {
  if (!frontmatter) return undefined
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "string" && value.includes("[[" + targetLink + "]])")) {
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

export const GraphLocalEmitter: QuartzEmitterPlugin<Partial<Options>> = (opts) => {
  opts = { ...defaultOptions, ...opts }

  /**
   * 为指定 slug 集合生成 local graph 并写入文件。
   * linkIndex 必须包含全量数据。
   */
  async function* generateLocalGraphs(
    ctx: any,
    slugsToGenerate: Set<SimpleSlug>,
    linkIndex: Map<SimpleSlug, ContentDetails>,
    validLinks: Set<SimpleSlug>,
    virtualNodes: Set<SimpleSlug>,
    allTags: Set<SimpleSlug>,
    depth: number,
  ) {
    const folderTitles = buildFolderTitles(linkIndex)
    const createVirtualContentDetails = (slug: SimpleSlug, isTag: boolean): ContentDetails => ({
      slug: slug as unknown as FullSlug,
      filePath: "" as any,
      title: isTag ? "#" + slug.replace("tags/", "") : slug,
      links: [],
      tags: [],
      content: "",
      frontmatter: {},
    })

    for (const slug of slugsToGenerate) {
      let centerData: ContentDetails
      const isReal = linkIndex.has(slug)
      const isTag = allTags.has(slug)

      if (isReal) {
        centerData = linkIndex.get(slug)!
      } else {
        centerData = createVirtualContentDetails(slug, isTag)
      }

      const localGraph = calculateLocalGraph(
        slug,
        centerData,
        linkIndex,
        validLinks,
        virtualNodes,
        depth,
        folderTitles,
      )

      const path = getLocalGraphPath(slug)
      const fp = ("graph/local/" + path) as FullSlug

      yield write({
        ctx,
        content: JSON.stringify(localGraph),
        slug: fp,
        ext: ".json",
      })
    }
  }

  /**
   * 从 linkIndex 中收集所有 slug（real + tags + virtual），
   * 为每个 slug 生成 local graph。
   */
  async function* generateAllLocalGraphs(
    ctx: any,
    linkIndex: Map<SimpleSlug, ContentDetails>,
    depth: number,
  ) {
    const allExistingSlugs = new Set(linkIndex.keys())
    const allTags = new Set<SimpleSlug>()
    const virtualNodes = new Set<SimpleSlug>()

    for (const [, details] of linkIndex.entries()) {
      for (const tag of details.tags) {
        allTags.add(simplifySlug(("tags/" + tag) as FullSlug))
      }
    }

    for (const [, details] of linkIndex.entries()) {
      for (const link of details.links ?? []) {
        if (!allExistingSlugs.has(link) && !allTags.has(link) && !link.startsWith("tags/")) {
          virtualNodes.add(link)
        }
      }
    }

    const validLinks = new Set([...allExistingSlugs, ...allTags, ...virtualNodes])
    const allSlugs = new Set([...allExistingSlugs, ...allTags, ...virtualNodes])

    yield* generateLocalGraphs(ctx, allSlugs, linkIndex, validLinks, virtualNodes, allTags, depth)

    return { virtualNodes: virtualNodes.size, allTags: allTags.size, allSlugs: allSlugs.size }
  }

  return {
    name: "GraphLocalEmitter",

    // 全量构建
    async *emit(ctx, content) {
      const cfg = ctx.cfg.configuration
      if (!cfg.graph?.precomputeLocal) {
        console.log("[GraphLocal] Precomputation disabled, skipping")
        return
      }

      const linkIndex = new Map<SimpleSlug, ContentDetails>()
      for (const [, file] of content) {
        const fullSlug = file.data.slug!
        const simplifiedSlug = simplifySlug(fullSlug)
        linkIndex.set(simplifiedSlug, {
          slug: fullSlug,
          filePath: file.data.relativePath!,
          title: file.data.frontmatter?.title || simplifiedSlug,
          links: file.data.links ?? [],
          tags: file.data.frontmatter?.tags ?? [],
          content: file.data.text ?? "",
          frontmatter: file.data.frontmatter ?? {},
        })
      }

      const depth = cfg.graph?.localDepth ?? 1
      console.log(`[GraphLocal] Starting local graph generation (depth=${depth})...`)
      console.log(`[GraphLocal] Input files: ${linkIndex.size}`)

      const result = yield* generateAllLocalGraphs(ctx, linkIndex, depth)

      console.log(`[GraphLocal] Virtual nodes: ${result.virtualNodes}, Tags: ${result.allTags}`)
      console.log(`[GraphLocal] Generation complete: ${result.allSlugs} pages`)
    },

    // 增量构建：只重新生成受变更影响的页面
    async *partialEmit(ctx, _content, _resources, changeEvents) {
      const cfg = ctx.cfg.configuration
      if (!cfg.graph?.precomputeLocal) {
        console.log("[GraphLocal] Precomputation disabled, skipping")
        return
      }

      const fs = await import("fs/promises")
      const contentIndexPath = joinSegments(ctx.argv.output, "static", "contentIndex.json")
      let fullIndex: Record<string, ContentDetails> = {}
      try {
        const raw = await fs.readFile(contentIndexPath, "utf-8")
        fullIndex = JSON.parse(raw)
      } catch {
        console.log("[GraphLocal] contentIndex.json not found, skipping")
        return
      }

      // 构建全量 linkIndex
      const linkIndex = new Map<SimpleSlug, ContentDetails>()
      for (const [k, v] of Object.entries(fullIndex)) {
        linkIndex.set(simplifySlug(k as FullSlug), v)
      }

      const allExistingSlugs = new Set(linkIndex.keys())
      const allTags = new Set<SimpleSlug>()
      const virtualNodes = new Set<SimpleSlug>()

      for (const [, details] of linkIndex.entries()) {
        for (const tag of details.tags) {
          allTags.add(simplifySlug(("tags/" + tag) as FullSlug))
        }
      }
      for (const [, details] of linkIndex.entries()) {
        for (const link of details.links ?? []) {
          if (!allExistingSlugs.has(link) && !allTags.has(link) && !link.startsWith("tags/")) {
            virtualNodes.add(link)
          }
        }
      }
      const validLinks = new Set([...allExistingSlugs, ...allTags, ...virtualNodes])
      const folderTitles = buildFolderTitles(linkIndex)

      // 确定受影响的 slug：变更文件 + 入链/出链邻居
      const affectedSlugs = new Set<SimpleSlug>()
      const deletedSlugs = new Set<SimpleSlug>()

      for (const evt of changeEvents) {
        const slug = simplifySlug(
          evt.file?.data.slug ?? (evt.path.replace(/\.md$/, "") as SimpleSlug),
        )
        affectedSlugs.add(slug)

        if (evt.type === "delete") {
          deletedSlugs.add(slug)
        }

        // 添加出链目标（邻居的 local graph 需要更新）
        const data = linkIndex.get(slug)
        if (data) {
          for (const link of data.links ?? []) {
            affectedSlugs.add(link)
          }
          for (const tag of data.tags) {
            affectedSlugs.add(simplifySlug(("tags/" + tag) as FullSlug))
          }
        }

        // 添加入链来源（所有链接到此 slug 的页面）
        for (const [other, details] of linkIndex.entries()) {
          if (details.links?.includes(slug)) {
            affectedSlugs.add(other)
          }
        }
      }

      // 删除已不存在的文件对应的 local graph
      for (const slug of deletedSlugs) {
        const path = getLocalGraphPath(slug)
        const fp = joinSegments(ctx.argv.output, "graph", "local", path + ".json")
        try {
          await fs.unlink(fp)
          console.log(`[GraphLocal] Deleted local graph: ${slug}`)
        } catch {
          // 文件可能不存在，忽略
        }
      }

      // 只对关联的标签/虚拟节点生成，跳过实际存在的实体节点
      const slugsToGenerate = new Set<SimpleSlug>()
      for (const slug of affectedSlugs) {
        if (allExistingSlugs.has(slug)) {
          slugsToGenerate.add(slug)
        } else if (allTags.has(slug) || virtualNodes.has(slug)) {
          slugsToGenerate.add(slug)
        }
      }

      const depth = cfg.graph?.localDepth ?? 1
      console.log(`[GraphLocal] Incremental update (depth=${depth})...`)
      console.log(
        `[GraphLocal] Changed files: ${changeEvents.length}, Affected pages: ${slugsToGenerate.size}`,
      )

      let count = 0
      const createVirtualContentDetails = (slug: SimpleSlug, isTag: boolean): ContentDetails => ({
        slug: slug as unknown as FullSlug,
        filePath: "" as any,
        title: isTag ? "#" + slug.replace("tags/", "") : slug,
        links: [],
        tags: [],
        content: "",
        frontmatter: {},
      })

      for (const slug of slugsToGenerate) {
        let centerData: ContentDetails
        if (linkIndex.has(slug)) {
          centerData = linkIndex.get(slug)!
        } else {
          centerData = createVirtualContentDetails(slug, allTags.has(slug))
        }

        const localGraph = calculateLocalGraph(
          slug,
          centerData,
          linkIndex,
          validLinks,
          virtualNodes,
          depth,
          folderTitles,
        )
        const path = getLocalGraphPath(slug)
        const fp = ("graph/local/" + path) as FullSlug

        yield write({ ctx, content: JSON.stringify(localGraph), slug: fp, ext: ".json" })
        count++
      }

      console.log(`[GraphLocal] Incremental generation complete: ${count} pages updated`)
    },
  }
}

function calculateLocalGraph(
  centerSlug: SimpleSlug,
  centerData: ContentDetails,
  linkIndex: Map<SimpleSlug, ContentDetails>,
  validLinks: Set<SimpleSlug>,
  virtualNodes: Set<SimpleSlug>,
  depth: number,
  folderTitles: Record<string, string>,
): LocalGraphData {
  // nodes uses Record format consistent with contentIndex.json
  const nodes: Record<SimpleSlug, ContentDetails> = {}
  const edges: LocalGraphEdge[] = []
  const visited = new Set<SimpleSlug>()
  const queue: Array<{ slug: SimpleSlug; depth: number }> = [{ slug: centerSlug, depth: 0 }]

  // Add center node (use SimpleSlug as key for consistent lookup)
  nodes[centerSlug] = centerData

  while (queue.length > 0) {
    const { slug: current, depth: currentDepth } = queue.shift()!

    if (visited.has(current)) continue
    visited.add(current)

    if (currentDepth >= depth) continue

    const currentData = linkIndex.get(current)
    const currentIsVirtual = !currentData

    // Process outgoing links (only for real pages, not virtual nodes)
    if (currentData) {
      for (const dest of currentData.links ?? []) {
        if (!validLinks.has(dest)) continue

        const destData = linkIndex.get(dest)
        const sourceField = getFrontmatterFieldForLink(currentData.frontmatter, dest as string)

        if (destData) {
          nodes[dest] = destData
        } else if (virtualNodes.has(dest)) {
          // Virtual node: create minimal ContentDetails-like structure
          nodes[dest] = {
            slug: dest as unknown as FullSlug,
            filePath: "" as any,
            title: dest,
            links: [],
            tags: [],
            content: "",
          }
        }

        edges.push({ source: current, target: dest, sourceField })
        queue.push({ slug: dest, depth: currentDepth + 1 })
      }

      // Process tags
      for (const tag of currentData.tags) {
        const tagSlug = simplifySlug(("tags/" + tag) as FullSlug)

        // Tag node: create minimal ContentDetails-like structure
        nodes[tagSlug] = {
          slug: tagSlug as unknown as FullSlug,
          filePath: "" as any,
          title: "#" + tag,
          links: [],
          tags: [],
          content: "",
        }

        edges.push({ source: current, target: tagSlug })
        queue.push({ slug: tagSlug, depth: currentDepth + 1 })
      }
    }

    // Process incoming links (only first level)
    if (currentDepth === 0 || (currentIsVirtual && currentDepth < depth)) {
      for (const [source, details] of linkIndex.entries()) {
        if (source === current) continue

        const outgoing = details.links ?? []
        if (outgoing.includes(current)) {
          const sourceField = getFrontmatterFieldForLink(details.frontmatter, current as string)

          nodes[source] = details
          edges.push({ source, target: current, sourceField })
          // Only expand from center (depth 0), not from incoming nodes
        }
      }
    }
  }

  return {
    version: 1,
    center: centerSlug,
    depth,
    generatedAt: Date.now(),
    nodes,
    edges,
    folderTitles,
  }
}

export { LocalGraphData, LocalGraphEdge }

import { QuartzEmitterPlugin } from "../types"
import { FullSlug, SimpleSlug, simplifySlug } from "../../util/path"
import { write } from "./helpers"
import { ContentDetails } from "./contentIndex"
// TODO 现在这个局部图谱预构建功能，还不支持增量生成。

// LocalGraphEdge 与 graph.inline.ts 中的 SimpleLinkData 对应
interface LocalGraphEdge {
  source: SimpleSlug
  target: SimpleSlug
  sourceField?: string  // frontmatter field name, undefined for body references
}

// LocalGraphData.nodes 使用与 ContentDetails 一致的结构
// 这样 graph2.inline.ts 可以用相同的逻辑解析
interface LocalGraphData {
  version: number
  center: SimpleSlug     // center node slug (renamed from 'slug' for clarity)
  depth: number
  generatedAt: number
  // nodes 格式与 contentIndex.json 中的条目格式一致
  nodes: Record<SimpleSlug, ContentDetails>
  edges: LocalGraphEdge[]
}

interface Options {
  // depth 已移除，统一使用 cfg.graph.localDepth
  showTags: boolean,
  removeTags: string[],
}

const defaultOptions: Options = {
  showTags: true,
  removeTags: [],
}

// 纯 JS djb2 哈希（与 graph2.inline.ts 保持一致，兼容 HTTP 非安全上下文）
function djb2Hash(message: string): string {
  let hash = 5381
  for (let i = 0; i < message.length; i++) {
    hash = ((hash << 5) + hash) + message.charCodeAt(i)
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
  return {
    name: "GraphLocalEmitter",
    async *emit(ctx, content) {
      const cfg = ctx.cfg.configuration
      
      // Check if precomputation is enabled
      if (!cfg.graph?.precomputeLocal) {
        console.log("[GraphLocal] Precomputation disabled, skipping generation")
        return
      }

      // Count input files
      let contentCount = 0
      for (const _ of content) {
        contentCount++
      }
      
      // Build content index (use SimpleSlug as key for consistency)
      // Note: We store both the simplified slug (for neighbor lookup) and full slug (for hash/path generation)
      const linkIndex = new Map<SimpleSlug, ContentDetails>()
      const fullSlugToSimpleSlug = new Map<FullSlug, SimpleSlug>()
      
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
        fullSlugToSimpleSlug.set(fullSlug, simplifiedSlug)
      }

      // Collect all tags and virtual nodes
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
      
      // 统一使用 cfg.graph.localDepth（与 graph2.inline.ts 中的 precomputeDepth 一致）
      const depth = cfg.graph?.localDepth ?? 1
      if (!cfg.graph?.localDepth) {
        console.warn("[GraphLocal] cfg.graph.localDepth not set, using default depth=1")
      }
      console.log(`[GraphLocal] Starting local graph generation (depth=${depth})...`)
      console.log(`[GraphLocal] Input files: ${contentCount}`)
      console.log(`[GraphLocal] Virtual nodes: ${virtualNodes.size}, Tags: ${allTags.size}`)

      let generatedCount = 0

      // Helper to create a minimal ContentDetails for virtual nodes
      const createVirtualContentDetails = (slug: SimpleSlug, isTag: boolean): ContentDetails => ({
        slug: slug as unknown as FullSlug,
        filePath: "" as any,
        title: isTag ? "#" + slug.replace("tags/", "") : slug,
        links: [],
        tags: [],
        content: "",
        frontmatter: {},
      })

      // Generate local graph for each REAL page
      // Use SimpleSlug (linkIndex key) for center, FullSlug only for path hashing
      for (const [simpleSlug, centerData] of linkIndex.entries()) {
        const localGraph = calculateLocalGraph(
          simpleSlug,
          centerData,
          linkIndex,
          validLinks,
          virtualNodes,
          depth
        )

        // Use FullSlug for path generation to match runtime expectations
        const fullSlug = centerData.slug as FullSlug
        const path = getLocalGraphPath(fullSlug as unknown as SimpleSlug)
        const fp = ("graph/local/" + path) as FullSlug

        yield write({
          ctx,
          content: JSON.stringify(localGraph),
          slug: fp,
          ext: ".json",
        })
        generatedCount++
      }

      // Generate local graph for TAG pages
      for (const tagSlug of allTags) {
        // Skip if real file exists (shouldn't happen but be safe)
        if (linkIndex.has(tagSlug)) continue

        const virtualData = createVirtualContentDetails(tagSlug, true)
        const localGraph = calculateLocalGraph(
          tagSlug,
          virtualData,
          linkIndex,
          validLinks,
          virtualNodes,
          depth
        )

        const path = getLocalGraphPath(tagSlug)
        const fp = ("graph/local/" + path) as FullSlug

        yield write({
          ctx,
          content: JSON.stringify(localGraph),
          slug: fp,
          ext: ".json",
        })
        generatedCount++
      }

      // Generate local graph for PURE VIRTUAL nodes (links that don't exist anywhere)
      for (const vSlug of virtualNodes) {
        // Skip if it's already covered by tag or real file
        if (allTags.has(vSlug) || linkIndex.has(vSlug)) continue

        const virtualData = createVirtualContentDetails(vSlug, false)
        const localGraph = calculateLocalGraph(
          vSlug,
          virtualData,
          linkIndex,
          validLinks,
          virtualNodes,
          depth
        )

        const path = getLocalGraphPath(vSlug)
        const fp = ("graph/local/" + path) as FullSlug

        yield write({
          ctx,
          content: JSON.stringify(localGraph),
          slug: fp,
          ext: ".json",
        })
        generatedCount++
      }

      console.log(`[GraphLocal] Generation complete: ${generatedCount} pages`)
    },
  }
}

function calculateLocalGraph(
  centerSlug: SimpleSlug,
  centerData: ContentDetails,
  linkIndex: Map<SimpleSlug, ContentDetails>,
  validLinks: Set<SimpleSlug>,
  virtualNodes: Set<SimpleSlug>,
  depth: number
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
  }
}

export { LocalGraphData, LocalGraphEdge }

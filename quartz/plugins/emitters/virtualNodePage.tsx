import { QuartzEmitterPlugin } from "../types"
import { QuartzComponentProps } from "../../components/types"
import HeaderConstructor from "../../components/Header"
import BodyConstructor from "../../components/Body"
import { pageResources, renderPage } from "../../components/renderPage"
import { ProcessedContent, QuartzPluginData, defaultProcessedContent } from "../vfile"
import { FullPageLayout } from "../../cfg"
import {
  FullSlug,
  getAllSegmentPrefixes,
  joinSegments,
  pathToRoot,
  simplifySlug,
  SimpleSlug,
} from "../../util/path"
import { defaultListPageLayout, sharedPageComponents } from "../../../quartz.layout"
import VirtualNodeContent from "../../components/pages/VirtualNodeContent"
import { write } from "./helpers"
import { BuildCtx, GraphCache } from "../../util/ctx"
import { StaticResources } from "../../util/resources"
import * as Component from "../../components"

// quartz/plugins/emitters/virtualNodePage.tsx

function computeVirtualNodes(
  ctx: BuildCtx,
  allFiles: QuartzPluginData[]
): Set<string> {
  const graph = ctx.graphCache
  if (!graph) {
    // 如果没有图谱缓存，降级到遍历文件（全量构建时）
    return computeVirtualNodesFromFiles(allFiles)
  }

  // 使用图谱计算虚拟节点
  const existingSlugs = new Set(allFiles.map(f => simplifySlug(f.slug!)))
  const virtualNodes: Set<string> = new Set()

  // 遍历图谱的边，找出目标节点不存在的
  for (const edge of graph.edges) {
    const targetSlug = edge.target as any as SimpleSlug  // 强制类型转换
    if (!existingSlugs.has(targetSlug) && graph.nodes[edge.target]) {
      virtualNodes.add(edge.target)
    }
  }

  return virtualNodes
}

// ===== 降级逻辑：原来的实现 =====
function computeVirtualNodesFromFiles(allFiles: QuartzPluginData[]): Set<string> {
  const existingSlugs = new Set(allFiles.map(f => simplifySlug(f.slug!)))
  const virtualNodes: Set<string> = new Set()

  const allTags = new Set(
    allFiles
      .flatMap((data) => data.frontmatter?.tags ?? [])
      .flatMap(getAllSegmentPrefixes)
  )

  for (const file of allFiles) {
    const links = file.links ?? []
    for (const link of links) {
      if (!existingSlugs.has(link) && 
          !allTags.has(link) && 
          !link.startsWith("tags/")) {
        virtualNodes.add(link)
      }
    }
  }

  return virtualNodes
}

// ===== 新增：从图谱获取反向链接 =====
function computeBacklinks(slug: string, graph: GraphCache | undefined, allFiles: QuartzPluginData[]): QuartzPluginData[] {
  if (!graph) {
    // 降级：从文件列表计算
    return allFiles.filter(file => file.links?.includes(slug as SimpleSlug))
  }

  // 从图谱获取反向链接的 slugs
  const backlinkSlugs = graph.edges
    .filter(edge => edge.target === slug)
    .map(edge => edge.source)

  const backlinkSet = new Set(backlinkSlugs)

  // 返回对应的文件数据
  return allFiles.filter(file => backlinkSet.has(simplifySlug(file.slug!)))
}

async function processVirtualNodePage(
  ctx: BuildCtx,
  nodeName: string,
  backlinks: QuartzPluginData[],
  allFiles: QuartzPluginData[],
  opts: FullPageLayout,
  resources: StaticResources,
) {
  const slug = nodeName as FullSlug
  const file = defaultProcessedContent({
    slug,
    frontmatter: {
      title: nodeName,
      tags: [],
    },
  })

  const [tree, vfile] = file
  const cfg = ctx.cfg.configuration
  const externalResources = pageResources(pathToRoot(slug), resources)

// 将反向链接注入到 vfile.data
  vfile.data.backlinks = backlinks

  const componentData: QuartzComponentProps = {
    ctx,
    fileData: vfile.data,
    externalResources,
    cfg,
    children: [],
    tree,
    allFiles,
  }

  const content = renderPage(cfg, slug, componentData, opts, externalResources)
  return write({
    ctx,
    content,
    slug,
    ext: ".html",
  })
}

export const VirtualNodePage: QuartzEmitterPlugin = () => {
  const opts: FullPageLayout = {
    ...sharedPageComponents,
    ...defaultListPageLayout,
    pageBody: VirtualNodeContent(),
    right: [              // 添加此处配置，使得虚拟节点页面就会显示知识图谱和反向链接组件
      Component.Graph(),
      Component.Backlinks(),
    ],
  }

  const { head: Head, header, beforeBody, pageBody, afterBody, left, right, footer: Footer } = opts
  const Header = HeaderConstructor()
  const Body = BodyConstructor()

  return {
    name: "VirtualNodePage",
    getQuartzComponents() {
      return [
        Head,
        Header,
        Body,
        ...header,
        ...beforeBody,
        pageBody,
        ...afterBody,
        ...left,
        ...right,
        Footer,
      ]
    },
    async *emit(ctx, content, resources) {
      const allFiles = content.map((c) => c[1].data)
      const virtualNodes = computeVirtualNodes(ctx, allFiles)

      for (const nodeName of virtualNodes) {
        // 从图谱获取反向链接
        const backlinks = computeBacklinks(nodeName, ctx.graphCache, allFiles)
        yield processVirtualNodePage(ctx, nodeName, backlinks, allFiles, opts, resources)
      }
    },
  }
}
import { QuartzEmitterPlugin } from "../types"
import { QuartzComponentProps } from "../../components/types"
import HeaderConstructor from "../../components/Header"
import BodyConstructor from "../../components/Body"
import { pageResources, renderPage } from "../../components/renderPage"
import { QuartzPluginData, defaultProcessedContent } from "../vfile"
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
import { BuildCtx } from "../../util/ctx"
import { StaticResources } from "../../util/resources"
import * as Component from "../../components"

// quartz/plugins/emitters/virtualNodePage.tsx

/**
 * 计算所有虚拟节点
 * 虚拟节点：被某文件引用（links），但该文件不存在的 slug
 */
function computeAllVirtualNodes(allFiles: QuartzPluginData[]): Set<string> {
  const existingSlugs = new Set(allFiles.map(f => simplifySlug(f.slug!)))
  const virtualNodes: Set<string> = new Set()

  // 排除 tag 相关 slug
  const allTags = new Set(
    allFiles
      .flatMap((data) => data.frontmatter?.tags ?? [])
      .flatMap(getAllSegmentPrefixes),
  )

  for (const file of allFiles) {
    const links = file.links ?? []
    for (const link of links) {
      if (
        !existingSlugs.has(link) &&
        !allTags.has(link) &&
        !link.startsWith("tags/")
      ) {
        virtualNodes.add(link)
      }
    }
  }

  return virtualNodes
}

/**
 * 计算反向链接：所有引用该 slug 的文件
 */
function computeBacklinks(slug: string, allFiles: QuartzPluginData[]): QuartzPluginData[] {
  return allFiles.filter(file => file.links?.includes(slug as SimpleSlug))
}

/**
 * 生成虚拟节点的索引数据（供 Graph View 使用）
 */
function generateVirtualNodeIndex(
  virtualNodes: Set<string>,
  allFiles: QuartzPluginData[],
): Record<string, { title: string; links: SimpleSlug[]; content: string }> {
  const index: Record<string, { title: string; links: SimpleSlug[]; content: string }> = {}

  for (const nodeName of virtualNodes) {
    const backlinks = computeBacklinks(nodeName, allFiles)
    const links = backlinks.map(f => simplifySlug(f.slug!))

    index[nodeName] = {
      title: nodeName,
      links: links,
      content: `被以下页面引用: ${links.map(l => l).join(", ")}`,
    }
  }

  return index
}

/**
 * 处理虚拟节点页面
 */
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
    right: [
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
      const virtualNodes = computeAllVirtualNodes(allFiles)

      // 生成虚拟节点页面
      for (const nodeName of virtualNodes) {
        const backlinks = computeBacklinks(nodeName, allFiles)
        yield processVirtualNodePage(ctx, nodeName, backlinks, allFiles, opts, resources)
      }

      // 生成虚拟节点索引文件（供 Graph View 使用）
      if (virtualNodes.size > 0) {
        const virtualNodeIndex = generateVirtualNodeIndex(virtualNodes, allFiles)
        const fp = joinSegments("static", "virtualNodeIndex") as FullSlug
        yield write({
          ctx,
          content: JSON.stringify(virtualNodeIndex),
          slug: fp,
          ext: ".json",
        })
      }
    },
    async *partialEmit(ctx, content, resources, changeEvents) {
      const allFiles = content.map((c) => c[1].data)

      // 找出受影响的虚拟节点
      const affectedVirtualNodes: Set<string> = new Set()

      for (const changeEvent of changeEvents) {
        // 如果是删除事件，检查被删除文件的 links
        if (changeEvent.type === "delete" && changeEvent.file) {
          const links = changeEvent.file.data.links ?? []
          for (const link of links) {
            affectedVirtualNodes.add(link)
          }
        }

        // 如果是新增或修改事件
        if (changeEvent.type === "add" || changeEvent.type === "change") {
          if (!changeEvent.file) continue

          // 文件本身的 slug 可能成为虚拟节点（如果被其他文件引用）
          const fileSlug = simplifySlug(changeEvent.file.data.slug!)
          affectedVirtualNodes.add(fileSlug)

          // 文件的 links 中引用的 slug
          const links = changeEvent.file.data.links ?? []
          for (const link of links) {
            affectedVirtualNodes.add(link)
          }
        }
      }

      // 如果没有受影响的虚拟节点，跳过
      if (affectedVirtualNodes.size === 0) {
        return
      }

      // 计算所有虚拟节点（需要完整的 allFiles 状态来计算反向链接）
      const allVirtualNodes = computeAllVirtualNodes(allFiles)

      // 只生成受影响的虚拟节点页面
      for (const nodeName of allVirtualNodes) {
        if (affectedVirtualNodes.has(nodeName)) {
          const backlinks = computeBacklinks(nodeName, allFiles)
          yield processVirtualNodePage(ctx, nodeName, backlinks, allFiles, opts, resources)
        }
      }

      // 更新虚拟节点索引文件
      const virtualNodeIndex = generateVirtualNodeIndex(allVirtualNodes, allFiles)
      const fp = joinSegments("static", "virtualNodeIndex") as FullSlug
      yield write({
        ctx,
        content: JSON.stringify(virtualNodeIndex),
        slug: fp,
        ext: ".json",
      })
    },
  }
}

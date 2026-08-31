import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import fs from "fs"
import path from "path"
import { SortConfig } from "./quartz/util/sort"
import { AggregationConfig, CoreNodeFilterConfig } from "./quartz/util/aggregation"

// ===== LayoutConfig 接口（从 quartz.layout.json 读取）=====
// 统一设计：组件名作为第一级，aggregation 作为支持该功能的组件的属性

interface LayoutConfig {
  explorer?: {
    aggregation?: AggregationConfig
    sort?: SortConfig
  }
  backlinks?: {
    hideWhenEmpty?: boolean
    aggregation?: AggregationConfig
    sort?: SortConfig
  }
  folderPage?: {
    aggregation?: AggregationConfig
    sort?: SortConfig
  }
  graph?: {
    aggregation?: AggregationConfig
    colorBy?: string
    coreNodeFilter?: CoreNodeFilterConfig
    coreNodeLimit?: number
    regionRules?: AggregationConfig
    expandCoresOnRegionOpen?: boolean
    filterNonCoreNodes?: boolean
    filterOrphans?: boolean
  }
}

let layoutCfg: LayoutConfig = {}

// ===== 读取 layout.json =====

let settingsPath: string | undefined
const settingsArgIdx = process.argv.findIndex((a) => a === "--settings" || a.startsWith("--settings="))
if (settingsArgIdx !== -1) {
  const arg = process.argv[settingsArgIdx]
  if (arg.startsWith("--settings=")) {
    settingsPath = arg.split("=").slice(1).join("=")
  } else if (settingsArgIdx + 1 < process.argv.length) {
    settingsPath = process.argv[settingsArgIdx + 1]
  }
}

if (settingsPath) {
  // 确保 settingsPath 是目录（去掉末尾的 quartz.layout.json 如果有的话）
  if (settingsPath.endsWith("quartz.layout.json")) {
    settingsPath = path.dirname(settingsPath)
  }
  const layoutJsonPath = path.join(settingsPath, "quartz.layout.json")
  try {
    const raw = fs.readFileSync(layoutJsonPath, "utf-8")
    layoutCfg = JSON.parse(raw) as LayoutConfig
    console.log(`[settings] 已加载 ${layoutJsonPath}`)
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.warn(`[settings] 无法加载 ${layoutJsonPath}：${e.message}`)
    } else {
      console.log(`[settings] quartz.layout.json 不存在，使用默认布局`)
    }
  }
}

// ===== 从配置生成组件选项 =====

// 统一默认排序配置：当 layout.json 中未指定 sort 时，使用此默认值
// 所有组件（Explorer、FolderPage、Backlinks）共享同一默认排序
const defaultSortConfig: SortConfig = { type: "natural", order: "asc", field: "title" }

const backlinksCfg = {
  hideWhenEmpty: layoutCfg.backlinks?.hideWhenEmpty ?? false,
  aggregation: layoutCfg.backlinks?.aggregation,
  sort: layoutCfg.backlinks?.sort ?? defaultSortConfig,
}

// FolderContent 排序配置（供 folderPage.tsx 使用）
export const folderPageSort: SortConfig = layoutCfg.folderPage?.sort ?? defaultSortConfig

// Explorer2 排序配置（供 Explorer2.tsx 使用）
export const explorerSort: SortConfig = layoutCfg.explorer?.sort ?? defaultSortConfig

// Graph 聚合配置（供 Graph.tsx 使用，同时导出供 GraphGlobal 插件使用）
export const graphAggregation = layoutCfg.graph?.aggregation ?? undefined
export const graphCoreNodeFilter = layoutCfg.graph?.coreNodeFilter ?? undefined
export const graphCoreNodeLimit = layoutCfg.graph?.coreNodeLimit ?? undefined
export const graphRegionRules = layoutCfg.graph?.regionRules ?? undefined
export const graphExpandCoresOnRegionOpen = layoutCfg.graph?.expandCoresOnRegionOpen ?? false
export const graphFilterNonCoreNodes = layoutCfg.graph?.filterNonCoreNodes ?? true
export const graphFilterOrphans = layoutCfg.graph?.filterOrphans ?? false

// ===== 组件布局 =====

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {},
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs({
        rootName: "首页",
      }),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
    Component.FrontmatterMeta(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search2(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer2({
      stickyHeaders: false,
      sort: explorerSort,
    }),
  ],
  right: [
    Component.Graph({
      localGraph: { aggregation: graphAggregation },
      globalGraph: { aggregation: graphAggregation, coreNodeFilter: graphCoreNodeFilter, coreNodeLimit: graphCoreNodeLimit, regionRules: graphRegionRules, expandCoresOnRegionOpen: graphExpandCoresOnRegionOpen, filterNonCoreNodes: graphFilterNonCoreNodes, filterOrphans: graphFilterOrphans },
    }),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(backlinksCfg),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs({
      rootName: "首页",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta({ showReadingTime: false }),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          // [NOTE] 注意这里必须和上面一样选用相同的Search组件，否则会导致元素重复渲染问题
          Component: Component.Search2(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer2({
      stickyHeaders: false,
      sort: explorerSort,
    }),
  ],
  right: [
    // 文件夹页不需要关系图谱和反向链接
    // Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    // Component.Backlinks(backlinksCfg),
  ],
}

// 虚拟节点页面布局：基于文件夹页，但需要关系图谱和反向链接
export const virtualNodePageLayout: PageLayout = {
  ...defaultListPageLayout,
  right: [
    Component.Graph({
      localGraph: { aggregation: graphAggregation },
      globalGraph: { aggregation: graphAggregation, coreNodeFilter: graphCoreNodeFilter, coreNodeLimit: graphCoreNodeLimit, regionRules: graphRegionRules, expandCoresOnRegionOpen: graphExpandCoresOnRegionOpen, filterNonCoreNodes: graphFilterNonCoreNodes, filterOrphans: graphFilterOrphans },
    }),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(backlinksCfg),
  ],
}


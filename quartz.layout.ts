import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import { FileTrieNode } from "./quartz/util/fileTrie"
import fs from "fs"
import path from "path"

// ===== 预定义排序策略（esbuild 可以静态分析，esbuild 不会尝试解析函数内部逻辑）=====
//
// sortBy.key:  "name" | "date"
// sortBy.order: "asc" | "desc"
//
// 文件夹始终优先于文件，与排序策略无关。
// 对于 date 排序：使用 ContentDetails.date（对应 defaultDateType 配置的日期类型，
// 默认 "modified"），无日期的节点排在末尾。
//
type SortKey = "name" | "date"
type SortOrder = "asc" | "desc"

interface SortByConfig {
  key?: SortKey
  order?: SortOrder
}

function buildExplorerSortFn(
  sortBy?: SortByConfig,
): (a: FileTrieNode, b: FileTrieNode) => number {
  const key: SortKey = sortBy?.key ?? "name"
  const direction = sortBy?.order === "desc" ? -1 : 1

  return (a: FileTrieNode, b: FileTrieNode): number => {
    // 文件夹始终优先于文件（不受排序策略影响）
    if (a.isFolder !== b.isFolder) {
      return a.isFolder ? -1 : 1
    }

    if (key === "date") {
      const da = (a.data as any)?.date as Date | undefined
      const db = (b.data as any)?.date as Date | undefined
      // 无日期的节点排在末尾
      if (!da && !db) return 0
      if (!da) return 1
      if (!db) return -1
      return direction * (da.getTime() - db.getTime())
    }

    // key === "name"（默认）
    return (
      direction *
      a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    )
  }
}

// ===== 运行时读取 layout.json（fs.readFileSync 对 esbuild 透明）=====
interface LayoutConfig {
  explorer?: {
    sortBy?: SortByConfig
  }
  backlinks?: {
    hideWhenEmpty?: boolean
  }
  folderPage?: {
    sortBy?: SortByConfig
  }
}

let layoutCfg: LayoutConfig = {}
const settingsArg = process.argv.find((a) => a.startsWith("--settings="))
if (settingsArg) {
  const settingsPath = settingsArg.split("=").slice(1).join("=")
  const layoutJsonPath = path.join(settingsPath, "layout.json")
  try {
    const raw = fs.readFileSync(layoutJsonPath, "utf-8")
    layoutCfg = JSON.parse(raw)
    console.log(`[settings] 已加载 ${layoutJsonPath}`)
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.warn(`[settings] 无法加载 ${layoutJsonPath}：${e.message}`)
    }
  }
}

// 根据配置构建排序函数
const explorerSortFn = buildExplorerSortFn(layoutCfg.explorer?.sortBy)
const backlinksCfg = { hideWhenEmpty: layoutCfg.backlinks?.hideWhenEmpty ?? false }

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
      sortFn: explorerSortFn,
    }),
  ],
  right: [
    Component.Graph(),
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
      sortFn: explorerSortFn,
    }),
  ],
  right: [],
}



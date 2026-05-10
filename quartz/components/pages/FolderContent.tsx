import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "../types"

import style from "../styles/listPage.scss"
import { PageList, SortFn, BatchLoadOptions } from "../PageList"
import { Root } from "hast"
import { htmlToJsx } from "../../util/jsx"
import { i18n } from "../../i18n"
import { QuartzPluginData } from "../../plugins/vfile"
import { ComponentChildren } from "preact"
import { concatenateResources } from "../../util/resources"
import { trieFromAllFiles } from "../../util/ctx"
import {
  SortConfig,
  applySortDefaults,
  createStringComparator,
  createDateComparator,
  createNumericComparator,
} from "../../util/sort"
import { isFolderPath } from "../../util/path"

// ===== FolderContent 排序辅助函数 =====

/** 从 QuartzPluginData 中提取字符串字段值 */
function getStringFieldValue(item: QuartzPluginData, field: string): string {
  if (field === "title") {
    return item.frontmatter?.title ?? item.slug ?? ""
  }
  return String(item.frontmatter?.[field] ?? "")
}

/** 从 QuartzPluginData 中提取日期字段值（带 fallback 链） */
function getDateFieldValue(item: QuartzPluginData, field: string): Date | null {
  // 1. 尝试指定字段
  const rawValue = item.frontmatter?.[field]
  if (rawValue !== undefined && rawValue !== null) {
    const date = new Date(rawValue as string | number)
    if (!isNaN(date.getTime())) {
      return date
    }
    console.warn(`[FolderContent] field "${field}" 不是日期类型，fallback 到 modified`)
  }

  // 2. fallback 到 dates.date
  if (item.dates?.date) {
    return item.dates.date
  }

  // 3. fallback 到 dates.modified（必有）
  return item.dates?.modified ?? null
}

/** 从 QuartzPluginData 中提取数值字段值 */
function getNumericFieldValue(item: QuartzPluginData, field: string): number {
  const rawValue = item.frontmatter?.[field]
  if (rawValue !== undefined && rawValue !== null) {
    const num = Number(rawValue)
    if (!isNaN(num)) return num
  }
  return 0
}

/** 根据 SortConfig 创建 SortFn，文件夹始终优先，带 tie-breaker */
function createFolderPageSortFn(config: SortConfig): SortFn {
  const effectiveConfig = applySortDefaults(config)

  return (f1, f2) => {
    // 文件夹优先
    const f1IsFolder = isFolderPath(f1.slug ?? "")
    const f2IsFolder = isFolderPath(f2.slug ?? "")
    if (f1IsFolder && !f2IsFolder) return -1
    if (!f1IsFolder && f2IsFolder) return 1

    let primaryResult: number

    switch (effectiveConfig.type) {
      case "date":
        primaryResult = createDateComparator<QuartzPluginData>(
          effectiveConfig.order,
          (item) => getDateFieldValue(item, effectiveConfig.field),
        )(f1, f2)
        break

      case "numeric":
        primaryResult = createNumericComparator<QuartzPluginData>(
          effectiveConfig.order,
          (item) => getNumericFieldValue(item, effectiveConfig.field),
        )(f1, f2)
        break

      case "natural":
        primaryResult = createStringComparator<QuartzPluginData>(
          effectiveConfig.order,
          (item) => getStringFieldValue(item, effectiveConfig.field),
          true, // natural
        )(f1, f2)
        break

      case "lexical":
        primaryResult = createStringComparator<QuartzPluginData>(
          effectiveConfig.order,
          (item) => getStringFieldValue(item, effectiveConfig.field),
          false, // lexical
        )(f1, f2)
        break
    }

    // Tie-breaker: date/numeric 类型在值相等时用 title natural
    if (primaryResult === 0 && (effectiveConfig.type === "date" || effectiveConfig.type === "numeric")) {
      return createStringComparator<QuartzPluginData>(
        "asc",
        (item) => getStringFieldValue(item, "title"),
        true, // natural
      )(f1, f2)
    }

    return primaryResult
  }
}

// ===== 组件定义 =====

interface FolderContentOptions {
  /**
   * Whether to display number of folders
   */
  showFolderCount: boolean
  showSubfolders: boolean
  sort?: SortFn | SortConfig
  batchLoad?: BatchLoadOptions
}

const defaultOptions: FolderContentOptions = {
  showFolderCount: true,
  showSubfolders: true,
  batchLoad: { enable: true, initialCount: 20, loadMoreCount: 20 },
}

export default ((opts?: Partial<FolderContentOptions>) => {
  const options: FolderContentOptions = { ...defaultOptions, ...opts, batchLoad: { ...defaultOptions.batchLoad, ...opts?.batchLoad } }

  // 将 SortConfig 转为 SortFn（如果传入的是 SortConfig）
  const resolvedSort: SortFn | undefined = (() => {
    if (!options.sort) return undefined
    // SortFn 是函数，SortConfig 是对象 — 通过类型判断
    if (typeof options.sort === "function") return options.sort as SortFn
    return createFolderPageSortFn(options.sort as SortConfig)
  })()

  const FolderContent: QuartzComponent = (props: QuartzComponentProps) => {
    const { tree, fileData, allFiles, cfg } = props
    
    const trie = (props.ctx.trie ??= trieFromAllFiles(allFiles))
    
    const folder = trie.findNode(fileData.slug!.split("/"))
    if (!folder) {
      return null
    }

    const allPagesInFolder: QuartzPluginData[] =
      folder.children
        .map((node) => {
          // regular file, proceed
          if (node.data) {
            return node.data
          }

          if (node.isFolder && options.showSubfolders) {
            // folders that dont have data need synthetic files
            const getMostRecentDates = (): QuartzPluginData["dates"] => {
              let maybeDates: QuartzPluginData["dates"] | undefined = undefined
              for (const child of node.children) {
                if (child.data?.dates) {
                  // compare all dates and assign to maybeDates if its more recent or its not set
                  if (!maybeDates) {
                    maybeDates = { ...child.data.dates }
                  } else {
                    if (child.data.dates.created > maybeDates.created) {
                      maybeDates.created = child.data.dates.created
                    }

                    if (child.data.dates.modified > maybeDates.modified) {
                      maybeDates.modified = child.data.dates.modified
                    }

                    if (child.data.dates.published > maybeDates.published) {
                      maybeDates.published = child.data.dates.published
                    }
                  }
                }
              }
              return (
                maybeDates ?? {
                  created: new Date(),
                  modified: new Date(),
                  published: new Date(),
                }
              )
            }

            return {
              slug: node.slug,
              dates: getMostRecentDates(),
              frontmatter: {
                title: node.displayName,
                tags: [],
              },
            }
          }
        })
        .filter((page) => page !== undefined) ?? []
    // console.log("allPagesInFolder:", JSON.stringify(allPagesInFolder, null, 2));
    
    const cssClasses: string[] = fileData.frontmatter?.cssclasses ?? []
    const classes = cssClasses.join(" ")
    const listProps = {
      ...props,
      sort: resolvedSort,
      allFiles: allPagesInFolder,
    }

    const content = (
      (tree as Root).children.length === 0
        ? fileData.description
        : htmlToJsx(fileData.filePath!, tree)
    ) as ComponentChildren

    return (
      <div class="popover-hint">
        <article class={classes}>{content}</article>
        <div class="page-listing">
          {options.showFolderCount && (
            <p>
              {i18n(cfg.locale).pages.folderContent.itemsUnderFolder({
                count: allPagesInFolder.length,
              })}
            </p>
          )}
          <div>
            <PageList {...listProps} batchLoad={options.batchLoad} />
          </div>
        </div>
      </div>
    )
  }

  FolderContent.css = concatenateResources(style, PageList.css)
  FolderContent.afterDOMLoaded = PageList.afterDOMLoaded
  return FolderContent
}) satisfies QuartzComponentConstructor

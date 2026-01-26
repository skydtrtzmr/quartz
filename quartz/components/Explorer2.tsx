import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/explorer2.scss"

// @ts-ignore
import script from "./scripts/explorer2.inline"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"
import { FileTrieNode } from "../util/fileTrie"
import OverflowListFactory from "./OverflowList"
import { concatenateResources } from "../util/resources"

type OrderEntries = "sort" | "filter" | "map"

export interface Options {
    title?: string
    folderDefaultState: "collapsed" | "open"
    folderClickBehavior: "collapse" | "link"
    useSavedState: boolean
    accordionMode: boolean  // 手风琴模式：点开一个文件夹时自动收起其他
    // 性能优化配置
    lazyLoad: boolean  // 懒加载：默认只渲染文件夹，展开时才渲染文件
    renderThreshold: number  // 当文件夹内文件数超过此阈值时启用懒加载（0 = 始终启用）
    // 虚拟滚动配置
    virtualScrollThreshold: number  // 当文件夹内文件数超过此阈值时启用虚拟滚动（默认200）
    virtualScrollWindowSize: number  // 虚拟滚动窗口大小：同时渲染的文件数量（默认50）
    stickyHeaders: boolean  // 吸顶效果：滚动时父级文件夹标题吸附在顶部
    sortFn: (a: FileTrieNode, b: FileTrieNode) => number
    filterFn: (node: FileTrieNode) => boolean
    mapFn: (node: FileTrieNode) => void
    order: OrderEntries[]
}

const defaultOptions: Options = {
    folderDefaultState: "collapsed",
    folderClickBehavior: "link",
    useSavedState: true,
    accordionMode: false,  // 默认关闭手风琴模式
    lazyLoad: true,  // 默认启用懒加载优化
    renderThreshold: 0,  // 0 表示始终启用懒加载
    virtualScrollThreshold: 200,  // 超过200个文件时启用虚拟滚动
    virtualScrollWindowSize: 50,  // 每次渲染50个文件
    stickyHeaders: true,  // 默认启用吸顶效果
    mapFn: (node) => {
        return node
    },
    sortFn: (a, b) => {
        // Sort order: folders first, then files. Sort folders and files alphabetically
        if ((!a.isFolder && !b.isFolder) || (a.isFolder && b.isFolder)) {
            // numeric: true: Whether numeric collation should be used, such that "1" < "2" < "10"
            // sensitivity: "base": Only strings that differ in base letters compare as unequal. Examples: a ≠ b, a = á, a = A
            return a.displayName.localeCompare(b.displayName, undefined, {
                numeric: true,
                sensitivity: "base",
            })
        }

        if (!a.isFolder && b.isFolder) {
            return 1
        } else {
            return -1
        }
    },
    filterFn: (node) => node.slugSegment !== "tags",
    order: ["filter", "map", "sort"],
}

export type FolderState = {
    path: string
    collapsed: boolean
    // 虚拟滚动状态
    renderStart?: number
    renderEnd?: number
    fileCount?: number
}

let numExplorers = 0
export default ((userOpts?: Partial<Options>) => {
    const opts: Options = { ...defaultOptions, ...userOpts }
    const { OverflowList, overflowListAfterDOMLoaded } = OverflowListFactory()

    const Explorer3: QuartzComponent = ({ cfg, displayClass }: QuartzComponentProps) => {
        const id = `explorer3-${numExplorers++}`

        return (
            <div
                class={classNames(displayClass, "explorer3")}
                data-behavior={opts.folderClickBehavior}
                data-collapsed={opts.folderDefaultState}
                data-savestate={opts.useSavedState}
                data-accordion={opts.accordionMode}
                data-lazyload={opts.lazyLoad}
                data-renderthreshold={opts.renderThreshold}
                data-virtualscrollthreshold={opts.virtualScrollThreshold}
                data-virtualscrollwindowsize={opts.virtualScrollWindowSize}
                data-stickyheaders={opts.stickyHeaders}
                data-data-fns={JSON.stringify({
                    order: opts.order,
                    sortFn: opts.sortFn.toString(),
                    filterFn: opts.filterFn.toString(),
                    mapFn: opts.mapFn.toString(),
                })}
            >
                <button
                    type="button"
                    class="explorer3-toggle mobile-explorer hide-until-loaded"
                    data-mobile={true}
                    aria-controls={id}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="lucide-menu"
                    >
                        <line x1="4" x2="20" y1="12" y2="12" />
                        <line x1="4" x2="20" y1="6" y2="6" />
                        <line x1="4" x2="20" y1="18" y2="18" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="title-button explorer3-toggle desktop-explorer"
                    data-mobile={false}
                    aria-expanded={true}
                >
                    <h2>{opts.title ?? i18n(cfg.locale).components.explorer.title}</h2>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="5 8 14 8"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="fold"
                    >
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </button>
                <div id={id} class="explorer3-content" aria-expanded={false} role="group">
                    <OverflowList class="explorer3-ul" />
                    {/* TODO 暂时注释掉定位按钮，以后再做。 */}
                    {/* <button type="button" class="locate-current-btn" title="定位到当前文件">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button> */}
                </div>
                <template id="template-file3">
                    <li>
                        <a href="#" class="file-link"></a>
                    </li>
                </template>
                <template id="template-folder3">
                    <li>
                        <div class="folder3-container">
                            <div>
                                <button class="folder3-button">
                                    <span class="folder3-content-wrapper">
                                        <span class="folder3-title"></span>
                                    </span>
                                </button>
                            </div>
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class="folder3-icon"
                            >
                                <polyline points="9 6 15 12 9 18"></polyline>
                            </svg>
                        </div>
                        <div class="folder3-outer">
                            <ul class="content"></ul>
                        </div>
                    </li>
                </template>
            </div>
        )
    }

    Explorer3.css = style
    Explorer3.afterDOMLoaded = concatenateResources(script, overflowListAfterDOMLoaded)
    return Explorer3
}) satisfies QuartzComponentConstructor
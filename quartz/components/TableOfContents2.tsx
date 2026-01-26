import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import toc2Style from "./styles/toc2.scss"
import { classNames } from "../util/lang"

// @ts-ignore
import script from "./scripts/toc2.inline"
import { i18n } from "../i18n"

interface Options {
  collapseByDefault: boolean
}

const defaultOptions: Options = {
  collapseByDefault: true,
}

interface TocNode {
  text: string
  slug: string
  depth: number
  children: TocNode[]
}

// 构建树形结构
function buildTocTree(toc: { depth: number; text: string; slug: string }[]): TocNode[] {
  if (!toc || toc.length === 0) return []
  
  const root: TocNode[] = []
  const stack: TocNode[] = []
  
  for (const entry of toc) {
    const node: TocNode = {
      text: entry.text,
      slug: entry.slug,
      depth: entry.depth,
      children: [],
    }
    
    // 找到合适的父节点
    while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) {
      stack.pop()
    }
    
    if (stack.length === 0) {
      root.push(node)
    } else {
      stack[stack.length - 1].children.push(node)
    }
    
    stack.push(node)
  }
  
  return root
}

let numTocs = 0
export default ((opts?: Partial<Options>) => {
  const collapseByDefault = opts?.collapseByDefault ?? defaultOptions.collapseByDefault
  
  // 递归渲染TOC树
  const renderTocNode = (node: TocNode, isRoot: boolean, collapseChildren: boolean): any => {
    const hasChildren = node.children.length > 0
    const nodeId = `toc-item-${node.slug}`
    
    return (
      <li key={node.slug} class={`toc-item depth-${node.depth}`} data-slug={node.slug}>
        <div class="toc-item-content">
          {hasChildren && (
            <button
              type="button"
              class={collapseChildren ? "toc-toggle collapsed" : "toc-toggle"}
              aria-controls={nodeId}
              aria-expanded={!collapseChildren}
              data-slug={node.slug}
            >
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
                class="fold-icon"
              >
                <polyline points="9 6 15 12 9 18"></polyline>
              </svg>
            </button>
          )}
          <a href={`#${node.slug}`} data-for={node.slug} class="toc-link">
            {node.text}
          </a>
        </div>
        {hasChildren && (
          <ul
            id={nodeId}
            class={collapseChildren ? "toc-children collapsed" : "toc-children"}
          >
            {node.children.map((child) => renderTocNode(child, false, collapseChildren))}
          </ul>
        )}
      </li>
    )
  }
  
  const TableOfContents2: QuartzComponent = ({
    fileData,
    displayClass,
    cfg,
  }: QuartzComponentProps) => {
    if (!fileData.toc) {
      return null
    }

    const id = `toc2-${numTocs++}`
    const tocTree = buildTocTree(fileData.toc)
    const shouldCollapse = fileData.collapseToc ?? collapseByDefault
    
    return (
      <div class={classNames(displayClass, "toc2")}>
        <button
          type="button"
          class={shouldCollapse ? "collapsed toc2-header" : "toc2-header"}
          aria-controls={id}
          aria-expanded={!shouldCollapse}
        >
          <h3>{i18n(cfg.locale).components.tableOfContents.title}</h3>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
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
        <ul
          id={id}
          class={shouldCollapse ? "collapsed toc2-content" : "toc2-content"}
        >
          {tocTree.map((node) => renderTocNode(node, true, shouldCollapse))}
        </ul>
      </div>
    )
  }

  TableOfContents2.css = toc2Style
  TableOfContents2.afterDOMLoaded = script

  return TableOfContents2
}) satisfies QuartzComponentConstructor

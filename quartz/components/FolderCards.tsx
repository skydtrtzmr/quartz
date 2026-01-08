import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { FullSlug, resolveRelative } from "../util/path"
import { trieFromAllFiles } from "../util/ctx"
import style from "./styles/homepage.scss"

export interface FolderCardsOptions {
  /**
   * 要展示的一级目录名称（空数组表示展示所有一级目录）
   */
  topFolders?: string[]
  /**
   * 是否显示文件夹中的文件数量
   */
  showFolderCount?: boolean
  /**
   * 卡片标题（默认为"📂 探索内容"）
   */
  title?: string
}

const defaultOptions: FolderCardsOptions = {
  topFolders: [],
  showFolderCount: true,
  title: "📂 探索内容",
}

export default ((userOpts?: Partial<FolderCardsOptions>) => {
  const opts: FolderCardsOptions = { ...defaultOptions, ...userOpts }

  const FolderCards: QuartzComponent = (props: QuartzComponentProps) => {
    const { allFiles, fileData } = props

    // 构建文件树
    const trie = (props.ctx.trie ??= trieFromAllFiles(allFiles))
    const root = trie.findNode([])

    if (!root) {
      return null
    }

    // 获取一级目录
    const topLevelFolders = root.children.filter((node) => {
      if (!node.isFolder) return false
      // 过滤掉 tags 文件夹
      if (node.slugSegment === "tags") return false
      // 如果指定了特定文件夹，只显示这些文件夹
      if (opts.topFolders && opts.topFolders.length > 0) {
        return opts.topFolders.includes(node.slugSegment)
      }
      return true
    })

    if (topLevelFolders.length === 0) {
      return null
    }

    // 计算每个文件夹中的文件数量
    const getFolderFileCount = (node: any): number => {
      let count = 0
      for (const child of node.children) {
        if (child.data) {
          count++
        }
        if (child.isFolder) {
          count += getFolderFileCount(child)
        }
      }
      return count
    }

    return (
      <>
        <h2 class="homepage-section-title">{opts.title}</h2>
        <div class="folder-cards">
          {topLevelFolders.map((folder) => {
            const fileCount = getFolderFileCount(folder)
            const folderUrl = resolveRelative(fileData.slug!, folder.slug as FullSlug)
            return (
              <a href={folderUrl} class="folder-card">
                <div class="folder-card-icon">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                  </svg>
                </div>
                <div class="folder-card-content">
                  <h3 class="folder-card-title">{folder.displayName}</h3>
                  {opts.showFolderCount && (
                    <p class="folder-card-count">
                      {fileCount} {fileCount === 1 ? "篇文章" : "篇文章"}
                    </p>
                  )}
                </div>
              </a>
            )
          })}
        </div>
      </>
    )
  }

  FolderCards.css = style
  return FolderCards
}) satisfies QuartzComponentConstructor
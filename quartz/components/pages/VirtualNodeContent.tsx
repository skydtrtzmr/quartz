import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "../types"
import { QuartzPluginData } from "../../plugins/vfile"
import { simplifySlug } from "../../util/path"

const VirtualNodeContent: QuartzComponent = ({ fileData, allFiles }: QuartzComponentProps) => {
  const slug = simplifySlug(fileData.slug!)
  const title = fileData.title || fileData.slug

  // 动态计算反向链接（从 allFiles 中查找引用该 slug 的文件）
  // 排除 tag 相关的 slug
  const backlinks = allFiles.filter((file: QuartzPluginData) => {
    const fileLinks = file.links ?? []
    const fileSlug = simplifySlug(file.slug!)
    // 检查文件是否引用了当前虚拟节点
    const references = fileLinks.includes(slug) ||
      fileLinks.some(link => link === slug || link.endsWith('/' + slug))
    // 排除 tag 页面
    const isTagPage = fileSlug.startsWith("tags/")
    return references && !isTagPage
  })

  return (
    <div class="popover-hint">
      <article class="virtual-node">
        <h1>{title}</h1>
        <p class="virtual-node-description">
          不存在该页面，但是被以下页面引用:
        </p>
        {backlinks.length > 0 ? (
          <ul class="backlinks-list">
            {backlinks.map((file: QuartzPluginData) => (
              <li key={file.slug}>
                <a href={`/${file.slug}`}>{file.frontmatter?.title || file.slug}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No backlinks found.</p>
        )}
      </article>
    </div>
  )
}

export default (() => VirtualNodeContent) satisfies QuartzComponentConstructor
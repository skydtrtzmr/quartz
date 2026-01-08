import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "../types"

const VirtualNodeContent: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
  const slug = fileData.slug!
  const title = fileData.title || slug

  // 从 fileData.backlinks 获取反向链接（已在 emitter 中注入）
  const backlinks = (fileData.backlinks as any[]) || []

  return (
    <article class="virtual-node">
      <h1>{title}</h1>
      <p class="virtual-node-description">
        不存在该页面，但是被以下页面引用:
      </p>
      {backlinks.length > 0 ? (
        <ul class="backlinks-list">
          {backlinks.map((file: any) => (
            <li key={file.slug}>
              <a href={`/${file.slug}`}>{file.title || file.slug}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p>No backlinks found.</p>
      )}
    </article>
  )
}

export default (() => VirtualNodeContent) satisfies QuartzComponentConstructor
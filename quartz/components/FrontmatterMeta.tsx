import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { resolveRelative, slugifyFilePath } from "../util/path"
import { FullSlug, FilePath } from "../util/path"
import { i18n } from "../i18n"
import style from "./styles/contentMeta.scss"

// 定义内置元数据字段列表，这里的字段都不会显示
const builtinFields = [
  'title',
  'tags',
  // 'aliases', // 移除，让 aliases 可以显示
  'modified',
  'created',
  'published',
  'date',
  'description',
  'socialDescription',
  'publish',
  'draft',
  'lang',
  'enableToc',
  'cssclasses',
  'socialImage',
  'comments'
]

// 定义需要以标签形式渲染的字段（紧凑型列表）
const tagStyleFields = ['aliases', 'alias', 'tags', 'tag']

const FrontmatterMeta: QuartzComponent = ({ fileData, displayClass, cfg }: QuartzComponentProps) => {
  const frontmatter = fileData.frontmatter
  if (!frontmatter) return null

  // 从i18n读取字段名翻译
  const translations = i18n(cfg.locale)
  const fieldNameMap = translations.components.frontmatterMeta.fieldNames

  // 获取所有非内置的元数据字段（包括值为空的字段）
  const customFields = Object.keys(frontmatter).filter(
    key => !builtinFields.includes(key) && frontmatter[key] !== undefined
  )

  // 如果没有自定义字段，不渲染任何内容
  if (customFields.length === 0) {
    return null
  }

  // 处理值，支持链接渲染
  const renderValue = (value: any, fieldKey: string): any => {
    if (Array.isArray(value)) {
      // 检查是否需要以标签形式渲染
      if (tagStyleFields.includes(fieldKey)) {
        return (
          <div class="custom-meta-tags">
            {value.map((item, index) => (
              <span key={index} class="custom-meta-tag">
                {renderValue(item, fieldKey)}
              </span>
            ))}
          </div>
        )
      } else {
        // 普通列表渲染（每项一行）
        return (
          <ul class="custom-meta-list">
            {value.map((item, index) => (
              <li key={index}>{renderValue(item, fieldKey)}</li>
            ))}
          </ul>
        )
      }
    } else if (typeof value === 'string') {
      // 检查是否为内部链接格式 [[link]]
      const wikilinkRegex = /\[\[([^\]]+)\]\]/g
      if (wikilinkRegex.test(value)) {
        wikilinkRegex.lastIndex = 0 // 重置正则表达式索引
        const parts = value.split(wikilinkRegex)
        return (
          <>
            {parts.map((part, index) => {
              if (index % 2 === 1) {
                // 这是链接内容
                // 处理带别名的链接格式 [[path/to/file|title]]
                const pipeIndex = part.indexOf('|')
                const actualLink = pipeIndex !== -1 ? part.substring(0, pipeIndex) : part
                const linkText = pipeIndex !== -1 ? part.substring(pipeIndex + 1) : part

                // 使用 slugifyFilePath 来正确处理文件名
                const slugified = slugifyFilePath(`${actualLink}.md` as FilePath)
                const linkDest = resolveRelative(fileData.slug!, slugified)
                return (
                  <a href={linkDest} class="internal">
                    {linkText}
                  </a>
                )
              } else {
                // 这是普通文本
                return part
              }
            })}
          </>
        )
      } else if (value.startsWith("http://") || value.startsWith("https://")) {
        // 外部链接
        return (
          <a href={value} class="external" target="_blank" rel="noopener noreferrer">
            {value}
          </a>
        )
      }
      return value
    }
    return String(value)
  }

  return (
    <div class={classNames(displayClass, "custom-meta")}>
      {/* <h3>笔记元数据</h3> */}
      <table class="custom-meta-table">
        <tbody>
          {customFields.map(field => {
            const value = frontmatter[field]
            // 翻译字段名（如果有翻译则使用翻译，否则使用原始名称）
            const displayName = fieldNameMap[field] || field.replace(/_/g, ' ')
            // 渲染所有字段，包括空值
            return (
              <tr key={field}>
                <td class="custom-meta-key">{displayName}</td>
                <td class="custom-meta-value">
                  {(value === null || value === '') ? '' : renderValue(value, field)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

FrontmatterMeta.css = `
.custom-meta {
  margin: var(--meta-container-margin, 1rem 0);
  padding: var(--meta-container-padding, 1rem);
  background-color: var(--meta-container-background, var(--lightgray));
  border: var(--meta-container-border, none);
  border-radius: var(--meta-container-border-radius, 4px);
  box-shadow: var(--meta-container-shadow, none);
}
.custom-meta h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
}
.custom-meta-table {
  width: 100%;
  border-collapse: collapse;
  padding: var(--meta-table-padding, 0);
  border-radius: var(--meta-table-border-radius, 0);
}
.custom-meta-key {
  font-weight: var(--meta-key-font-weight, bold);
  width: 120px;
  vertical-align: top;
  padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  border-right: 1px solid var(--gray);
}
.custom-meta-value {
  padding: 0.5rem 0.75rem;
  vertical-align: top;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  max-width: 0;
}
.custom-meta-table tr:nth-child(even) {
  background-color: rgba(0, 0, 0, var(--meta-striped-opacity, 0.05));
}
.custom-meta-table tr:hover {
  background-color: rgba(0, 0, 0, var(--meta-row-hover-opacity, 0.1));
}
.custom-meta-list {
  margin: 0;
  padding-left: 1rem;
}
.custom-meta-list ul {
  margin: 0.25rem 0;
  padding-left: 1.5rem;
}
.custom-meta .internal {
  text-decoration: underline;
  color: var(--secondary);
}
.custom-meta .external {
  text-decoration: underline;
  color: var(--tertiary);
}
.custom-meta .internal:hover {
  color: var(--tertiary);
}
.custom-meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.custom-meta-tag {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  background: var(--highlight);
  border-radius: 12px;
  font-size: 0.95rem;
  line-height: 1.5;
  white-space: nowrap;
}
.custom-meta-tag a {
  text-decoration: none;
}
.custom-meta-tag:hover {
  background: var(--lightgray);
}
`

export default (() => FrontmatterMeta) satisfies QuartzComponentConstructor
import { Root } from "hast"
import { GlobalConfiguration } from "../../cfg"
import { getDate } from "../../components/Date"
import { escapeHTML } from "../../util/escape"
import { FilePath, FullSlug, SimpleSlug, joinSegments, simplifySlug, slugifyFilePath } from "../../util/path"
import { QuartzEmitterPlugin } from "../types"
import { toHtml } from "hast-util-to-html"
import { write } from "./helpers"
import { i18n } from "../../i18n"

export type ContentIndexMap = Map<FullSlug, ContentDetails>
export type ContentDetails = {
  slug: FullSlug
  filePath: FilePath
  title: string
  links: SimpleSlug[]
  tags: string[]
  content: string
  richContent?: string
  date?: Date
  description?: string
  frontmatter?: Record<string, any>
}

interface Options {
  enableSiteMap: boolean
  enableRSS: boolean
  rssLimit?: number
  rssFullHtml: boolean
  rssSlug: string
  includeEmptyFiles: boolean
}

const defaultOptions: Options = {
  enableSiteMap: true,
  enableRSS: true,
  rssLimit: 10,
  rssFullHtml: false,
  rssSlug: "index",
  includeEmptyFiles: true,
}

function generateSiteMap(cfg: GlobalConfiguration, idx: ContentIndexMap): string {
  const base = cfg.baseUrl ?? ""
  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<url>
    <loc>https://${joinSegments(base, encodeURI(slug))}</loc>
    ${content.date && `<lastmod>${content.date.toISOString()}</lastmod>`}
  </url>`
  const urls = Array.from(idx)
    .map(([slug, content]) => createURLEntry(simplifySlug(slug), content))
    .join("")
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`
}

function generateRSSFeed(cfg: GlobalConfiguration, idx: ContentIndexMap, limit?: number): string {
  const base = cfg.baseUrl ?? ""

  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<item>
    <title>${escapeHTML(content.title)}</title>
    <link>https://${joinSegments(base, encodeURI(slug))}</link>
    <guid>https://${joinSegments(base, encodeURI(slug))}</guid>
    <description><![CDATA[ ${content.richContent ?? content.description} ]]></description>
    <pubDate>${content.date?.toUTCString()}</pubDate>
  </item>`

  const items = Array.from(idx)
    .sort(([_, f1], [__, f2]) => {
      if (f1.date && f2.date) {
        return f2.date.getTime() - f1.date.getTime()
      } else if (f1.date && !f2.date) {
        return -1
      } else if (!f1.date && f2.date) {
        return 1
      }

      return f1.title.localeCompare(f2.title)
    })
    .map(([slug, content]) => createURLEntry(simplifySlug(slug), content))
    .slice(0, limit ?? idx.size)
    .join("")

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
      <title>${escapeHTML(cfg.pageTitle)}</title>
      <link>https://${base}</link>
      <description>${!!limit ? i18n(cfg.locale).pages.rss.lastFewNotes({ count: limit }) : i18n(cfg.locale).pages.rss.recentNotes} on ${escapeHTML(
        cfg.pageTitle,
      )}</description>
      <generator>Quartz -- quartz.jzhao.xyz</generator>
      ${items}
    </channel>
  </rss>`
}

export const ContentIndex: QuartzEmitterPlugin<Partial<Options>> = (opts) => {
  opts = { ...defaultOptions, ...opts }
  return {
    name: "ContentIndex",
    async *emit(ctx, content) {
      const cfg = ctx.cfg.configuration
      const linkIndex: ContentIndexMap = new Map()
      for (const [tree, file] of content) {
        const slug = file.data.slug!
        const date = getDate(ctx.cfg.configuration, file.data) ?? new Date()
        if (opts?.includeEmptyFiles || (file.data.text && file.data.text !== "")) {
          linkIndex.set(slug, {
            slug,
            filePath: file.data.relativePath!,
            // title: file.data.frontmatter?.title!,
            title: file.data.frontmatter?.title || slug,
            links: file.data.links ?? [],
            tags: file.data.frontmatter?.tags ?? [],
            content: file.data.text ?? "",
            richContent: opts?.rssFullHtml
              ? escapeHTML(toHtml(tree as Root, { allowDangerousHtml: true }))
              : undefined,
            date: date,
            description: file.data.description ?? "",
            frontmatter: file.data.frontmatter ?? {},
          })
        }
      }

      if (opts?.enableSiteMap) {
        yield write({
          ctx,
          content: generateSiteMap(cfg, linkIndex),
          slug: "sitemap" as FullSlug,
          ext: ".xml",
        })
      }

      if (opts?.enableRSS) {
        yield write({
          ctx,
          content: generateRSSFeed(cfg, linkIndex, opts.rssLimit),
          slug: (opts?.rssSlug ?? "index") as FullSlug,
          ext: ".xml",
        })
      }

      const fp = joinSegments("static", "contentIndex") as FullSlug
      const simplifiedIndex = Object.fromEntries(
        Array.from(linkIndex).map(([slug, content]) => {
          // remove description and from content index as nothing downstream
          // actually uses it. we only keep it in the index as we need it
          // for the RSS feed
          delete content.description
          delete content.date
          return [slug, content]
        }),
      )

      yield write({
        ctx,
        content: JSON.stringify(simplifiedIndex),
        slug: fp,
        ext: ".json",
      })
    },
    
    // 增量更新 contentIndex.json
    async *partialEmit(ctx, content, resources, changeEvents) {
      console.log("ContentIndex: partialEmit");
      
      const cfg = ctx.cfg.configuration
      const fp = joinSegments("static", "contentIndex") as FullSlug
      const contentIndexPath = joinSegments(ctx.argv.output, "static", "contentIndex.json")
      
      // 读取现有的 contentIndex.json
      let existingIndex: Record<string, ContentDetails> = {}
      try {
        const fs = await import('fs/promises')
        const existingContent = await fs.readFile(contentIndexPath, 'utf-8')
        existingIndex = JSON.parse(existingContent)
        console.log(`ContentIndex: Loaded existing index with ${Object.keys(existingIndex).length} entries`)
      } catch (err) {
        // 如果文件不存在或解析失败，使用空对象
        console.log('ContentIndex: Creating new index file')
      }
      
      // 处理变化事件
      for (const changeEvent of changeEvents) {
        if (changeEvent.type === 'delete') {
          console.log(`ContentIndex: 触发一个删除事件`);
          
          // 删除条目 - 从 path 计算 slug
          let slug = changeEvent.file?.data.slug
          if (!slug) {
            console.log(`no slug found for ${changeEvent.path}`);
            
            // 如果 file 不存在，从 path 计算 slug
            // changeEvent.path 可能是完整路径，需要提取文件名
            const relativePath = changeEvent.path
            const fileName = relativePath.split(/[/\\]/).pop() || relativePath
            slug = slugifyFilePath(fileName as FilePath)
          }
          console.log(`ContentIndex: 删除条目 - ${slug}`);
          
          if (slug && existingIndex[slug]) {
            delete existingIndex[slug]
            console.log(`ContentIndex: Removed ${slug}`)
          }
        } else if (changeEvent.type === 'change' || changeEvent.type === 'add') {
          // 更新或添加条目
          const file = changeEvent.file
          if (file) {
            const slug = file.data.slug!
            const date = getDate(ctx.cfg.configuration, file.data) ?? new Date()
            
            if (opts?.includeEmptyFiles || (file.data.text && file.data.text !== "")) {
              // 找到对应的 tree（HTML AST）- 只在 content 中查找真正变化的文件
              const matchingContent = content.find(([_, f]) => f.data.slug === slug)
              const tree = matchingContent?.[0]
              
              existingIndex[slug] = {
                slug,
                filePath: file.data.relativePath!,
                title: file.data.frontmatter?.title || slug,
                links: file.data.links ?? [],
                tags: file.data.frontmatter?.tags ?? [],
                content: file.data.text ?? "",
                richContent: opts?.rssFullHtml && tree
                  ? escapeHTML(toHtml(tree as Root, { allowDangerousHtml: true }))
                  : undefined,
                date: date,
                description: file.data.description ?? "",
                frontmatter: file.data.frontmatter ?? {},
              }
              
              // 移除不需要的字段
              delete existingIndex[slug].description
              delete existingIndex[slug].date
              
              console.log(`ContentIndex: Updated ${slug}`)
            }
          }
        }
      }
      
      console.log(`ContentIndex: Final index has ${Object.keys(existingIndex).length} entries`)
      
      // 写入更新后的 contentIndex.json
      yield write({
        ctx,
        content: JSON.stringify(existingIndex),
        slug: fp,
        ext: ".json",
      })
      
      // 如果启用了 sitemap 和 RSS，需要重新生成（因为它们需要全量数据）
      if (opts?.enableSiteMap || opts?.enableRSS) {
        // 重新构建 linkIndex 用于 sitemap 和 RSS
        const linkIndex: ContentIndexMap = new Map()
        for (const [slug, details] of Object.entries(existingIndex)) {
          linkIndex.set(slug as FullSlug, {
            ...details,
            date: new Date(), // 使用当前时间作为默认值
          })
        }
        
        if (opts?.enableSiteMap) {
          yield write({
            ctx,
            content: generateSiteMap(cfg, linkIndex),
            slug: "sitemap" as FullSlug,
            ext: ".xml",
          })
        }

        if (opts?.enableRSS) {
          yield write({
            ctx,
            content: generateRSSFeed(cfg, linkIndex, opts.rssLimit),
            slug: (opts?.rssSlug ?? "index") as FullSlug,
            ext: ".xml",
          })
        }
      }
    },
    
    externalResources: (ctx) => {
      if (opts?.enableRSS) {
        return {
          additionalHead: [
            <link
              rel="alternate"
              type="application/rss+xml"
              title="RSS Feed"
              href={`https://${ctx.cfg.configuration.baseUrl}/index.xml`}
            />,
          ],
        }
      }
    },
  }
}

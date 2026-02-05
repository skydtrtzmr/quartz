import { QuartzTransformerPlugin } from "../types"
import {
  FullSlug,
  RelativeURL,
  SimpleSlug,
  TransformOptions,
  stripSlashes,
  simplifySlug,
  splitAnchor,
  transformLink,
} from "../../util/path"
import path from "path"
import { visit } from "unist-util-visit"
import isAbsoluteUrl from "is-absolute-url"
import { Root } from "hast"
import { wikilinkRegex } from "./ofm"

// Type for processed frontmatter values
export type ProcessedFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | { text: string; href: string }
  | ProcessedFrontmatterValue[]
  | { [key: string]: ProcessedFrontmatterValue }

// Process a single frontmatter value, converting wikilinks to {text, href} objects
function processFrontmatterValue(
  value: unknown,
  slug: FullSlug,
  transformOptions: TransformOptions,
): ProcessedFrontmatterValue {
  if (value === null || value === undefined) {
    return null
  }

  if (Array.isArray(value)) {
    return value.map((item) => processFrontmatterValue(item, slug, transformOptions))
  }

  if (typeof value === "string") {
    // Reset regex lastIndex since it has global flag
    wikilinkRegex.lastIndex = 0
    const match = wikilinkRegex.exec(value)
    // Check if the entire string is a wikilink (not just contains one)
    if (match && match[0] === value && !value.startsWith("!")) {
      // ofm.ts wikilinkRegex capture groups:
      // [1] = file path (e.g., "MAPWD232")
      // [2] = anchor/heading with # (e.g., "#section")
      // [3] = alias with | or \| (e.g., "|display text" or "\|display text")
      const rawFp = match[1]?.trim() ?? ""
      const rawHeader = match[2]?.trim() ?? ""
      const rawAlias = match[3]

      const fp = rawFp
      const anchor = rawHeader
      // Remove leading | or \| from alias
      const alias = rawAlias?.replace(/^\\?\|/, "").trim()

      const actualLink = fp + anchor
      const displayText = alias ?? fp

      // Transform the link using the same logic as content links
      const dest = transformLink(slug, actualLink, transformOptions)

      return {
        text: displayText,
        href: dest,
      }
    }
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "object") {
    const result: { [key: string]: ProcessedFrontmatterValue } = {}
    for (const key in value as Record<string, unknown>) {
      result[key] = processFrontmatterValue(
        (value as Record<string, unknown>)[key],
        slug,
        transformOptions,
      )
    }
    return result
  }

  return String(value)
}

// Process all frontmatter fields
function processFrontmatterFields(
  frontmatter: Record<string, unknown>,
  slug: FullSlug,
  transformOptions: TransformOptions,
  outgoing: Set<SimpleSlug>,
): Record<string, ProcessedFrontmatterValue> {
  const result: Record<string, ProcessedFrontmatterValue> = {}

  for (const key in frontmatter) {
    const value = frontmatter[key]
    result[key] = processFrontmatterValue(value, slug, transformOptions)

    // Collect outgoing links from processed values
    collectOutgoingLinks(result[key], slug, outgoing)
  }

  return result
}

// Recursively collect outgoing links from processed frontmatter values
function collectOutgoingLinks(
  value: ProcessedFrontmatterValue,
  curSlug: FullSlug,
  outgoing: Set<SimpleSlug>,
): void {
  if (value === null || value === undefined) return

  if (Array.isArray(value)) {
    value.forEach((item) => collectOutgoingLinks(item, curSlug, outgoing))
    return
  }

  if (typeof value === "object" && "text" in value && "href" in value && typeof value.href === "string") {
    // This is a processed link
    try {
      const dest = value.href
      const curSlugSimple = simplifySlug(curSlug)
      const url = new URL(dest, "https://base.com/" + stripSlashes(curSlugSimple, true))
      const canonicalDest = url.pathname
      let [destCanonical, _destAnchor] = splitAnchor(canonicalDest)
      if (destCanonical.endsWith("/")) {
        destCanonical += "index"
      }
      const full = decodeURIComponent(stripSlashes(destCanonical, true)) as FullSlug
      const simple = simplifySlug(full)
      outgoing.add(simple)
    } catch (e) {
      // Ignore invalid URLs
    }
    return
  }

  if (typeof value === "object") {
    for (const key in value) {
      collectOutgoingLinks((value as Record<string, ProcessedFrontmatterValue>)[key], curSlug, outgoing)
    }
  }
}

interface Options {
  /** How to resolve Markdown paths */
  markdownLinkResolution: TransformOptions["strategy"]
  /** Strips folders from a link so that it looks nice */
  prettyLinks: boolean
  openLinksInNewTab: boolean
  lazyLoad: boolean
  externalLinkIcon: boolean
}

const defaultOptions: Options = {
  markdownLinkResolution: "absolute",
  prettyLinks: true,
  openLinksInNewTab: false,
  lazyLoad: false,
  externalLinkIcon: true,
}

export const CrawlLinks: QuartzTransformerPlugin<Partial<Options>> = (userOpts) => {
  const opts = { ...defaultOptions, ...userOpts }
  return {
    name: "LinkProcessing",
    htmlPlugins(ctx) {
      return [
        () => {
          return (tree: Root, file) => {
            const curSlug = simplifySlug(file.data.slug!)
            const outgoing: Set<SimpleSlug> = new Set()

            const transformOptions: TransformOptions = {
              strategy: opts.markdownLinkResolution,
              allSlugs: ctx.allSlugs,
            }

            // 处理frontmatter中的链接，生成 processedFrontmatter
            if (file.data.frontmatter) {
              file.data.processedFrontmatter = processFrontmatterFields(
                file.data.frontmatter as Record<string, unknown>,
                file.data.slug!,
                transformOptions,
                outgoing,
              )
            }

            visit(tree, "element", (node, _index, _parent) => {
              // rewrite all links
              if (
                node.tagName === "a" &&
                node.properties &&
                typeof node.properties.href === "string"
              ) {
                let dest = node.properties.href as RelativeURL
                const classes = (node.properties.className ?? []) as string[]
                const isExternal = isAbsoluteUrl(dest, { httpOnly: false })
                classes.push(isExternal ? "external" : "internal")

                if (isExternal && opts.externalLinkIcon) {
                  node.children.push({
                    type: "element",
                    tagName: "svg",
                    properties: {
                      "aria-hidden": "true",
                      class: "external-icon",
                      style: "max-width:0.8em;max-height:0.8em",
                      viewBox: "0 0 512 512",
                    },
                    children: [
                      {
                        type: "element",
                        tagName: "path",
                        properties: {
                          d: "M320 0H288V64h32 82.7L201.4 265.4 178.7 288 224 333.3l22.6-22.6L448 109.3V192v32h64V192 32 0H480 320zM32 32H0V64 480v32H32 456h32V480 352 320H424v32 96H64V96h96 32V32H160 32z",
                        },
                        children: [],
                      },
                    ],
                  })
                }

                // Check if the link has alias text
                if (
                  node.children.length === 1 &&
                  node.children[0].type === "text" &&
                  node.children[0].value !== dest
                ) {
                  // Add the 'alias' class if the text content is not the same as the href
                  classes.push("alias")
                }
                node.properties.className = classes

                if (isExternal && opts.openLinksInNewTab) {
                  node.properties.target = "_blank"
                }

                // don't process external links or intra-document anchors
                const isInternal = !(
                  isAbsoluteUrl(dest, { httpOnly: false }) || dest.startsWith("#")
                )
                if (isInternal) {
                  dest = node.properties.href = transformLink(
                    file.data.slug!,
                    dest,
                    transformOptions,
                  )

                  // url.resolve is considered legacy
                  // WHATWG equivalent https://nodejs.dev/en/api/v18/url/#urlresolvefrom-to
                  const url = new URL(dest, "https://base.com/" + stripSlashes(curSlug, true))
                  const canonicalDest = url.pathname
                  let [destCanonical, _destAnchor] = splitAnchor(canonicalDest)
                  if (destCanonical.endsWith("/")) {
                    destCanonical += "index"
                  }

                  // need to decodeURIComponent here as WHATWG URL percent-encodes everything
                  const full = decodeURIComponent(stripSlashes(destCanonical, true)) as FullSlug
                  const simple = simplifySlug(full)
                  outgoing.add(simple)
                  node.properties["data-slug"] = full
                }

                // rewrite link internals if prettylinks is on
                if (
                  opts.prettyLinks &&
                  isInternal &&
                  node.children.length === 1 &&
                  node.children[0].type === "text" &&
                  !node.children[0].value.startsWith("#")
                ) {
                  node.children[0].value = path.basename(node.children[0].value)
                }
              }

              // transform all other resources that may use links
              if (
                ["img", "video", "audio", "iframe"].includes(node.tagName) &&
                node.properties &&
                typeof node.properties.src === "string"
              ) {
                if (opts.lazyLoad) {
                  node.properties.loading = "lazy"
                }

                if (!isAbsoluteUrl(node.properties.src, { httpOnly: false })) {
                  let dest = node.properties.src as RelativeURL
                  dest = node.properties.src = transformLink(
                    file.data.slug!,
                    dest,
                    transformOptions,
                  )
                  node.properties.src = dest
                }
              }
            })

            file.data.links = [...outgoing]
          }
        },
      ]
    },
  }
}

declare module "vfile" {
  interface DataMap {
    links: SimpleSlug[]
    processedFrontmatter?: Record<string, ProcessedFrontmatterValue>
  }
}
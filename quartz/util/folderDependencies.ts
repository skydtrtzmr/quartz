/** Folder listings depend on descendants even when there is no Markdown link between them. */
export function ancestorFolderPages(slugs: Iterable<string>): Set<string> {
  const pages = new Set<string>()
  for (const slug of slugs) {
    const parts = slug.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/")
    parts.pop()
    while (parts.length > 0) {
      pages.add(`${parts.join("/")}/index`)
      parts.pop()
    }
    pages.add("index")
  }
  return pages
}

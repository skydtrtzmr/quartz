/** One frontmatter field per folder. Folder paths are relative to the content root. */
export interface ListingSortConfig {
  default?: string
  folders?: Record<string, string>
}

export function normalizeListingSort(raw: unknown): Required<ListingSortConfig> {
  if (raw == null) return { default: "title", folders: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration.listingSort must be a mapping")
  const value = raw as Record<string, unknown>
  const valid = (field: unknown) => typeof field === "string" && field.trim().length > 0
  if (value.default !== undefined && !valid(value.default)) throw new Error("configuration.listingSort.default must be a field name")
  const folders: Record<string, string> = {}
  if (value.folders !== undefined) {
    if (!value.folders || typeof value.folders !== "object" || Array.isArray(value.folders)) throw new Error("configuration.listingSort.folders must be a mapping")
    for (const [path, field] of Object.entries(value.folders)) {
      if (!path || path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || !valid(field)) {
        throw new Error(`Invalid listing sort for folder ${path}`)
      }
      folders[path] = field as string
    }
  }
  return { default: (value.default as string | undefined) ?? "title", folders }
}

export function resolveListingField(config: Required<ListingSortConfig>, folder: string): string {
  let current = folder
  while (current) {
    if (Object.hasOwn(config.folders, current)) return config.folders[current]
    const index = current.lastIndexOf("/")
    current = index < 0 ? "" : current.slice(0, index)
  }
  return config.default
}

type ListingItem = { slug?: string; frontmatter?: Record<string, unknown> }

function parentFolder(slug: string): string {
  const parts = slug.split("/").filter(Boolean)
  if (parts.at(-1) === "index") parts.pop()
  parts.pop()
  return parts.join("/")
}

function isFolder(slug: string): boolean { return slug.endsWith("/index") }

export function createFolderPageSort(config: Required<ListingSortConfig>) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  return (a: ListingItem, b: ListingItem): number => {
    const aFolder = isFolder(a.slug ?? "")
    const bFolder = isFolder(b.slug ?? "")
    if (aFolder !== bFolder) return aFolder ? -1 : 1
    const field = resolveListingField(config, parentFolder(a.slug ?? b.slug ?? ""))
    const value = (item: ListingItem): unknown => field === "title" ? item.frontmatter?.title : item.frontmatter?.[field]
    const av = value(a), bv = value(b)
    const missingA = av === undefined || av === null || av === ""
    const missingB = bv === undefined || bv === null || bv === ""
    if (missingA !== missingB) return missingA ? 1 : -1
    if (!missingA && !missingB) {
      const result = typeof av === "number" && typeof bv === "number" ? av - bv : collator.compare(String(av), String(bv))
      if (result) return result
    }
    return collator.compare(String(a.frontmatter?.title ?? ""), String(b.frontmatter?.title ?? ""))
      || collator.compare(a.slug ?? "", b.slug ?? "")
  }
}

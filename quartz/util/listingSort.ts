/** One frontmatter field and direction per folder. Folder paths are relative to the content root. */
export type ListingSortRule = { field: string; order: "asc" | "desc" }
export type ListingSortInput = string | { field: string; order?: "asc" | "desc" }

export interface ListingSortConfig {
  default?: ListingSortInput
  folders?: Record<string, ListingSortInput>
}

export type NormalizedListingSort = {
  default: ListingSortRule
  folders: Record<string, ListingSortRule>
}

function normalizeRule(raw: unknown, path: string): ListingSortRule {
  if (typeof raw === "string" && raw.trim()) return { field: raw, order: "asc" }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>
    if (
      typeof value.field === "string" &&
      value.field.trim() &&
      (value.order === undefined || value.order === "asc" || value.order === "desc") &&
      Object.keys(value).every((key) => key === "field" || key === "order")
    ) {
      return {
        field: value.field,
        order: (value.order as ListingSortRule["order"] | undefined) ?? "asc",
      }
    }
  }
  throw new Error(`${path} must specify a field and optional asc/desc order`)
}

export function normalizeListingSort(raw: unknown): NormalizedListingSort {
  if (raw == null) return { default: { field: "title", order: "asc" }, folders: {} }
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("configuration.listingSort must be a mapping")
  const value = raw as Record<string, unknown>
  const defaultRule =
    value.default === undefined
      ? ({ field: "title", order: "asc" } as ListingSortRule)
      : normalizeRule(value.default, "configuration.listingSort.default")
  const folders: Record<string, ListingSortRule> = {}
  if (value.folders !== undefined) {
    if (!value.folders || typeof value.folders !== "object" || Array.isArray(value.folders))
      throw new Error("configuration.listingSort.folders must be a mapping")
    for (const [path, rule] of Object.entries(value.folders)) {
      if (
        !path ||
        path.startsWith("/") ||
        path.endsWith("/") ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw new Error(`Invalid listing sort for folder ${path}`)
      }
      folders[path] = normalizeRule(rule, `configuration.listingSort.folders.${path}`)
    }
  }
  return { default: defaultRule, folders }
}

export function resolveListingRule(config: NormalizedListingSort, folder: string): ListingSortRule {
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

function isFolder(slug: string): boolean {
  return slug.endsWith("/index")
}

export function createFolderPageSort(config: NormalizedListingSort) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })
  return (a: ListingItem, b: ListingItem): number => {
    const aFolder = isFolder(a.slug ?? "")
    const bFolder = isFolder(b.slug ?? "")
    if (aFolder !== bFolder) return aFolder ? -1 : 1
    const rule = resolveListingRule(config, parentFolder(a.slug ?? b.slug ?? ""))
    const value = (item: ListingItem): unknown =>
      rule.field === "title" ? item.frontmatter?.title : item.frontmatter?.[rule.field]
    const av = value(a),
      bv = value(b)
    const missingA = av === undefined || av === null || av === ""
    const missingB = bv === undefined || bv === null || bv === ""
    if (missingA !== missingB) return missingA ? 1 : -1
    if (!missingA && !missingB) {
      const result =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : collator.compare(String(av), String(bv))
      if (result) return rule.order === "desc" ? -result : result
    }
    return (
      collator.compare(String(a.frontmatter?.title ?? ""), String(b.frontmatter?.title ?? "")) ||
      collator.compare(a.slug ?? "", b.slug ?? "")
    )
  }
}

const common = ["maxVisibleNodes", "expandBatchSize", "loadBatchSize", "coreMinLinks"]
const views = { local: "localGraph", folder: "folderGraph", dimension: "dimensionGraph", global: "globalGraph" } as const

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}

/** Shared business settings are resolved once for every graph component/emitter. */
export function sharedGraphOptions(graph: unknown, options: Record<string, unknown> = {}): Record<string, unknown> {
  for (const section of ["graph", "graphDefaults", ...Object.values(views)]) {
    const existing = options[section] as Record<string, unknown> | undefined
    for (const key of [...common, ...(section === "globalGraph" ? ["folders", "coreAggregationMaxLevels"] : [])]) {
      if (existing && Object.hasOwn(existing, key)) throw new Error(`Move graph-pro options.${section}.${key} to configuration.graph`)
    }
  }
  if (graph === undefined) return options
  const input = object(graph, "configuration.graph")
  const result = { ...options }
  for (const [section, value] of Object.entries(input)) {
    if (section !== "defaults" && !Object.hasOwn(views, section)) throw new Error(`Unknown configuration.graph.${section}`)
    const fields = object(value, `configuration.graph.${section}`)
    const allowed = [...common, ...(section === "global" ? ["folders", "coreAggregationMaxLevels"] : [])]
    for (const [key, field] of Object.entries(fields)) {
      const path = `configuration.graph.${section}.${key}`
      if (!allowed.includes(key)) throw new Error(`Unknown ${path}`)
      if (key === "folders") {
        if (!Array.isArray(field) || field.some(item => typeof item !== "string" || !item.trim() || item.startsWith("/") || item.includes("\\") || item.split("/").some((part: string) => !part || part === "." || part === ".."))) {
          throw new Error(`${path} must contain content-relative folder paths`)
        }
      } else if (!Number.isInteger(field) || (field as number) < (key === "coreMinLinks" ? 0 : 1)) {
        throw new Error(`${path} must be ${key === "coreMinLinks" ? "a non-negative" : "a positive"} integer`)
      }
    }
    const target = section === "defaults" ? "graphDefaults" : views[section as keyof typeof views]
    result[target] = { ...options[target] as object, ...fields }
  }
  return result
}

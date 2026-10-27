/** 将全局图谱配置传给所有 graph-pro 组件和 emitter，不逐字段重复校验。 */
const sections = { defaults: "graphDefaults", local: "localGraph", folder: "folderGraph", dimension: "dimensionGraph", global: "globalGraph" } as const

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}

export function sharedGraphOptions(graph: unknown, options: Record<string, unknown> = {}): Record<string, unknown> {
  if (Object.keys(options).length) throw new Error("Move graph-pro options to configuration.graph")
  if (graph === undefined) return {}
  const result: Record<string, unknown> = {}
  for (const [section, value] of Object.entries(object(graph, "configuration.graph"))) {
    if (section === "precomputeLocal") {
      result.graph = { precomputeLocal: value }
    } else {
      if (!Object.hasOwn(sections, section)) throw new Error(`Unknown configuration.graph.${section}`)
      result[sections[section as keyof typeof sections]] = { ...object(value, `configuration.graph.${section}`) }
    }
  }
  return result
}

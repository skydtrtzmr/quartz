const explorerFields = ["hideFiles", "dimensionFolders", "dimensionMaxLevels", "dimensionMaxValues"] as const

/** Only site configuration supplies the shared explorer display policy. */
export function sharedExplorerOptions(
  explorer: unknown,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const key of explorerFields) {
    if (Object.hasOwn(options, key)) {
      throw new Error(`Move explorer-pro options.${key} to configuration.explorer.${key}`)
    }
  }
  if (explorer === undefined) return options
  if (explorer === null || typeof explorer !== "object" || Array.isArray(explorer)) {
    throw new Error("configuration.explorer must be an object")
  }
  for (const [key, value] of Object.entries(explorer)) {
    if (!explorerFields.includes(key as typeof explorerFields[number])) {
      throw new Error(`Unknown configuration.explorer.${key}`)
    }
    if (key === "hideFiles" || key === "dimensionFolders") {
      if (typeof value !== "boolean") throw new Error(`configuration.explorer.${key} must be a boolean`)
    } else if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`configuration.explorer.${key} must be a positive integer`)
    }
  }
  return { ...options, ...explorer }
}

/** Property display chains are accepted only in configuration.properties. */
export function sharedPropertiesOptions(
  properties: unknown,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  if (Object.hasOwn(options, "properties")) {
    throw new Error("Move note-properties-pro options.properties to configuration.properties")
  }
  if (properties === undefined) return options
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("configuration.properties must be an object")
  }
  return { ...options, properties }
}

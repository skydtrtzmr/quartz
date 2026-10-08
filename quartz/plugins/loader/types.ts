import {
  QuartzTransformerPlugin,
  QuartzFilterPlugin,
  QuartzEmitterPlugin,
  QuartzPageTypePlugin,
} from "../types"
import { BuildCtx } from "../../util/ctx"

export type PluginCategory = "transformer" | "filter" | "emitter" | "pageType" | "component"

export type LayoutPosition = "left" | "right" | "beforeBody" | "afterBody" | "header" | "footer"

export type LayoutDisplay = "all" | "mobile-only" | "desktop-only"

/**
 * Component manifest metadata
 */
export interface ComponentManifest {
  name: string
  displayName: string
  description: string
  version: string
  quartzVersion?: string
  author?: string
  homepage?: string
}

/**
 * Layout defaults for a component declared in a plugin manifest.
 * These are used as fallback values when no user layout config is specified.
 */
export interface ComponentLayoutDefaults {
  displayName: string
  description?: string
  defaultPosition?: LayoutPosition
  defaultPriority?: number
}

/**
 * Plugin manifest metadata for discovery and documentation.
 *
 * This corresponds to the `quartz` field in a plugin's `package.json`.
 */
export interface PluginManifest {
  name: string
  displayName: string
  description: string
  version: string
  author?: string
  homepage?: string
  keywords?: string[]
  category?: PluginCategory | PluginCategory[]
  quartzVersion?: string
  /** Plugin sources this plugin depends on (e.g., "@quartz-community/crawl-links") */
  dependencies?: string[]
  /** Default numeric execution order (0-100 convention, lower = runs first). Defaults to 50. */
  defaultOrder?: number
  /** Whether the plugin is enabled by default on install. Defaults to true. */
  defaultEnabled?: boolean
  /** Default options applied when no user options are specified */
  defaultOptions?: Record<string, unknown>
  /** JSON Schema for the plugin's options object, used for validation and TUI generation */
  configSchema?: object
  /** Components provided by this plugin, keyed by component export name */
  components?: Record<string, ComponentManifest & ComponentLayoutDefaults>
  /** Page frames provided by this plugin, keyed by export name. Each entry maps to a PageFrame object. */
  frames?: Record<string, { exportName: string }>
  /** Whether the plugin requires `npm install` after cloning (e.g. for native dependencies like sharp). */
  requiresInstall?: boolean
}

/**
 * Loaded plugin with metadata
 */
export interface LoadedPlugin {
  plugin: QuartzTransformerPlugin | QuartzFilterPlugin | QuartzEmitterPlugin | QuartzPageTypePlugin
  manifest: PluginManifest
  type: PluginCategory
  source: string
}

/**
 * Plugin resolution result
 */
export interface PluginResolution {
  /** Successfully loaded plugins */
  plugins: LoadedPlugin[]
  /** Errors that occurred during resolution */
  errors: PluginResolutionError[]
}

/**
 * Plugin resolution error
 */
export interface PluginResolutionError {
  /** Plugin name that failed to load */
  plugin: string
  /** Error message */
  message: string
  /** Error type */
  type: "not-found" | "invalid-manifest" | "version-mismatch" | "import-error"
}

/**
 * Options for plugin resolution
 */
export interface PluginResolutionOptions {
  /** Current Quartz version for compatibility checking */
  quartzVersion: string
  /** Build context for logging */
  ctx: BuildCtx
  /** Whether to enable verbose logging */
  verbose?: boolean
}

/**
 * Plugin specifier - can be:
 * - String package name (e.g., "@quartz-community/my-plugin")
 * - Object with name and options (e.g., { name: "@quartz-community/my-plugin", options: {...} })
 * - Inline plugin object (already loaded plugin instance)
 */
export type PluginSpecifier =
  | string
  | { name: string; options?: unknown }
  | { plugin: LoadedPlugin["plugin"]; manifest?: Partial<PluginManifest> }

/** Layout declaration for a component-providing plugin in quartz.config.yaml */
export interface PluginLayoutDeclaration {
  position: LayoutPosition
  priority: number
  /**
   * 指定用插件里的哪个组件（**导出名**）占位。
   *
   * 默认按「插件名」解析组件，只有恰好一个组件的插件会把插件名登记为组件别名；
   * 多组件插件解析不到 → 该条目被静默跳过。需要为多组件插件分别定位时显式声明本字段，
   * 同一 source 可写多条条目，把它的不同组件放到不同位置（如侧栏 Graph + header 的全局图谱宿主）。
   */
  component?: string
  display?: LayoutDisplay
  condition?: string
  group?: string
  groupOptions?: {
    grow?: boolean
    shrink?: boolean
    basis?: string
    order?: number
    align?: "start" | "end" | "center" | "stretch"
    justify?: "start" | "end" | "center" | "between" | "around"
  }
}

/** Object form of a plugin source (for monorepo / advanced config) */
export interface PluginSourceObject {
  repo: string
  subdir?: string
  ref?: string
  name?: string
}

/** A plugin source can be a string shorthand or an object with additional fields */
export type PluginSource = string | PluginSourceObject

/** A single plugin entry in quartz.config.yaml */
export interface PluginJsonEntry {
  source: PluginSource
  enabled: boolean
  options?: Record<string, unknown>
  order?: number
  layout?: PluginLayoutDeclaration
}

/** Flex group configuration in the top-level layout section */
export interface FlexGroupConfig {
  /** Explicit priority for the group. Overrides first-member priority. Lower = renders first. */
  priority?: number
  direction?: "row" | "row-reverse" | "column" | "column-reverse"
  wrap?: "nowrap" | "wrap" | "wrap-reverse"
  gap?: string
}

/** Per-page-type layout overrides */
export interface PageTypeLayoutOverride {
  exclude?: string[]
  positions?: Partial<Record<LayoutPosition, PluginLayoutDeclaration[]>>
  /** Override the page frame template (e.g. "default", "full-width", "minimal") */
  template?: string
}

/** Top-level layout section of quartz.config.yaml */
export interface LayoutConfig {
  groups?: Record<string, FlexGroupConfig>
  byPageType?: Record<string, PageTypeLayoutOverride>
}

/** Root type for quartz.config.yaml */
export interface QuartzPluginsJson {
  $schema?: string
  configuration: Record<string, unknown>
  plugins: PluginJsonEntry[]
  layout?: LayoutConfig
}

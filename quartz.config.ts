import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"
import { oceanColors } from "./quartz/themes"
import {
  graphAggregation,
  graphCoreNodeFilter,
  graphCoreNodeLimit,
  graphRegionRules,
  graphFilterNonCoreNodes,
  graphFilterOrphans,
} from "./quartz.layout"
import fs from "fs"
import path from "path"
/**
 * Quartz 4 Configuration
 *
 * See https://quartz.jzhao.xyz/configuration for more information.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "源悦知识库",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "zh-CN",
    baseUrl: "127.0.0.1:8767/xm",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "modified",
    graph: {
      precomputeLocal: true, // 是否预计算局部图谱（构建时生成）
      localDepth: 1, // 预计算的深度（1 或 2）
      fallbackToBfs: true, // 预计算文件缺失时是否回退到 BFS 计算
    },
    theme: {
      fontOrigin: "local",
      cdnCaching: false,
      typography: {
        header: "Schibsted Grotesk",
        body: "Source Sans Pro",
        code: "IBM Plex Mono",
      },
      // colors: {
      //   lightMode: {
      //     light: "#faf8f8",
      //     lightgray: "#e5e5e5",
      //     gray: "#b8b8b8",
      //     darkgray: "#4e4e4e",
      //     dark: "#2b2b2b",
      //     secondary: "#284b63",
      //     tertiary: "#84a59d",
      //     highlight: "rgba(143, 159, 169, 0.15)",
      //     textHighlight: "#fff23688",
      //   },
      //   darkMode: {
      //     light: "#161618",
      //     lightgray: "#393639",
      //     gray: "#646464",
      //     darkgray: "#d4d4d4",
      //     dark: "#ebebec",
      //     secondary: "#7b97aa",
      //     tertiary: "#84a59d",
      //     highlight: "rgba(143, 159, 169, 0.15)",
      //     textHighlight: "#b3aa0288",
      //   },
      // },
      colors: oceanColors,
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({
        parseTags: false, // 禁用从正文提取标签
        enableInHtmlEmbed: false,
      }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.HardLineBreaks(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      // Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.VirtualNodePage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.GraphGlobal({
        // 配置从 quartz.layout.json 自动加载，无需在此重复维护
        coreNodeFilter: graphCoreNodeFilter,
        coreNodeLimit: graphCoreNodeLimit,
        regionRules: graphRegionRules,
        aggregation: graphAggregation,
        filterNonCoreNodes: graphFilterNonCoreNodes,
        filterOrphans: graphFilterOrphans,
      }),
      // 必须在 ContentIndex 之后，生成精简版图谱所需数据。
      Plugin.GraphLocalEmitter({
        // depth 已移除，统一使用 quartz.config.ts 中的 graph.localDepth 配置
        showTags: true,
        removeTags: [],
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      // Comment out CustomOgImages to speed up build time
      // Plugin.CustomOgImages(),
    ],
  },
}

// ===== 运行时 JSON 覆盖（对 esbuild 透明，使用 fs.readFileSync）=====
//
// 仅覆盖 configuration 中的纯数据字段，plugins 始终保持不变。
// JSON 文件中存在的字段以 JSON 为准，其余字段保留 quartz.config.ts 默认值。

// 支持 --settings=<path> 和 --settings <path> 两种格式
// --settings 参数应该是目录路径
let settingsPath: string | undefined
const settingsArgIndex = process.argv.findIndex(
  (a) => a === "--settings" || a.startsWith("--settings="),
)
if (settingsArgIndex !== -1) {
  if (process.argv[settingsArgIndex].startsWith("--settings=")) {
    // --settings=<path> 格式
    settingsPath = process.argv[settingsArgIndex].split("=").slice(1).join("=")
  } else if (settingsArgIndex + 1 < process.argv.length) {
    // --settings <path> 格式
    settingsPath = process.argv[settingsArgIndex + 1]
  }
}

if (settingsPath) {
  // 确保 settingsPath 是目录（去掉末尾的 .json 文件名如果有的话）
  if (settingsPath.endsWith(".json")) {
    settingsPath = path.dirname(settingsPath)
  }
  const configJsonPath = path.join(settingsPath, "quartz.config.json")
  try {
    const raw = fs.readFileSync(configJsonPath, "utf-8")
    const override = JSON.parse(raw) as Partial<typeof config.configuration>
    // 深度合并：递归合并嵌套对象（如 graph 配置）
    deepMerge(config.configuration, override)
    console.log(
      `[settings] 已加载 ${configJsonPath}，覆盖字段：${Object.keys(override).join(", ")}`,
    )
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      // 文件不存在时静默跳过；其他错误（如 JSON 格式错误）打印警告
      console.warn(`[settings] 无法加载 ${configJsonPath}：${e.message}`)
    }
  }
}

// 深度合并函数
function deepMerge(target: any, source: any): void {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        // 如果目标对象没有该属性，创建一个空对象
        if (!target.hasOwnProperty(key)) {
          target[key] = {}
        }
        // 递归合并嵌套对象
        deepMerge(target[key], source[key])
      } else {
        // 直接赋值（覆盖）
        target[key] = source[key]
      }
    }
  }
}

export default config

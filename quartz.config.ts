import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"
import { defaultColors, oceanColors } from "./quartz/themes"
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
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
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
const settingsArg = process.argv.find((a) => a.startsWith("--settings="))
if (settingsArg) {
  const settingsPath = settingsArg.split("=").slice(1).join("=") // 兼容路径中含 "=" 的情况
  const configJsonPath = path.join(settingsPath, "config.json")
  try {
    const raw = fs.readFileSync(configJsonPath, "utf-8")
    const override = JSON.parse(raw) as Partial<typeof config.configuration>
    // 浅合并：只覆盖 configuration 层，不触碰 plugins
    Object.assign(config.configuration, override)
    console.log(`[settings] 已加载 ${configJsonPath}，覆盖字段：${Object.keys(override).join(", ")}`)
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      // 文件不存在时静默跳过；其他错误（如 JSON 格式错误）打印警告
      console.warn(`[settings] 无法加载 ${configJsonPath}：${e.message}`)
    }
  }
}

export default config

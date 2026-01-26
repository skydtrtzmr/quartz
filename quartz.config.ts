import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"
// === 主题引入 ===
import { defaultColors, oceanColors } from "./quartz/themes"
import { defaultStyle, cardStyle} from "./quartz/themes"

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
    // 关闭在线分析
    analytics: null,
    locale: "zh-CN",
    // 注意此处配置，影响静态资源加载路径。
    baseUrl: "localhost:8181",
    ignorePatterns: ["private", "templates", ".obsidian", "journals"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: false,
      typography: {
        header: "Schibsted Grotesk",
        body: "Source Sans Pro",
        code: "IBM Plex Mono",
      },
      // 颜色主题🎨在 quartz/themes/colors/ 中查看所有可用主题
      colors: oceanColors,
      // 样式主题🖼️在 quartz/themes/styles/ 中查看所有可用样式
      styles: cardStyle,
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        // 可选值：priority: ["frontmatter", "git", "filesystem"],
        priority: ["frontmatter"],
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
      Plugin.ContentIndex({
        // 关闭站点地图和 RSS
        enableSiteMap: false,
        enableRSS: false,
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

export default config

import { StyleTheme } from "../../quartz/themes"

export interface ColorScheme {
  light: string
  lightgray: string
  gray: string
  darkgray: string
  dark: string
  secondary: string
  tertiary: string
  highlight: string
  textHighlight: string
}

interface Colors {
  lightMode: ColorScheme
  darkMode: ColorScheme
}

export type FontSpecification =
  | string
  | {
      name: string
      weights?: number[]
      includeItalic?: boolean
    }

export interface Theme {
  typography: {
    title?: FontSpecification
    header: FontSpecification
    body: FontSpecification
    code: FontSpecification
  }
  cdnCaching: boolean
  colors: Colors
  fontOrigin: "googleFonts" | "local"
  styles?: StyleTheme  // 样式主题
}

export type ThemeKey = keyof Colors

const DEFAULT_SANS_SERIF =
  'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"'
const DEFAULT_MONO = "ui-monospace, SFMono-Regular, SF Mono, Menlo, monospace"

export function getFontSpecificationName(spec: FontSpecification): string {
  if (typeof spec === "string") {
    return spec
  }

  return spec.name
}

function formatFontSpecification(
  type: "title" | "header" | "body" | "code",
  spec: FontSpecification,
) {
  if (typeof spec === "string") {
    spec = { name: spec }
  }

  const defaultIncludeWeights = type === "header" ? [400, 700] : [400, 600]
  const defaultIncludeItalic = type === "body"
  const weights = spec.weights ?? defaultIncludeWeights
  const italic = spec.includeItalic ?? defaultIncludeItalic

  const features: string[] = []
  if (italic) {
    features.push("ital")
  }

  if (weights.length > 1) {
    const weightSpec = italic
      ? weights
          .flatMap((w) => [`0,${w}`, `1,${w}`])
          .sort()
          .join(";")
      : weights.join(";")

    features.push(`wght@${weightSpec}`)
  }

  if (features.length > 0) {
    return `${spec.name}:${features.join(",")}`
  }

  return spec.name
}

export function googleFontHref(theme: Theme) {
  const { header, body, code } = theme.typography
  const headerFont = formatFontSpecification("header", header)
  const bodyFont = formatFontSpecification("body", body)
  const codeFont = formatFontSpecification("code", code)

  return `https://fonts.googleapis.com/css2?family=${headerFont}&family=${bodyFont}&family=${codeFont}&display=swap`
}

export function googleFontSubsetHref(theme: Theme, text: string) {
  const title = theme.typography.title || theme.typography.header
  const titleFont = formatFontSpecification("title", title)

  return `https://fonts.googleapis.com/css2?family=${titleFont}&text=${encodeURIComponent(text)}&display=swap`
}

export interface GoogleFontFile {
  url: string
  filename: string
  extension: string
}

const fontMimeMap: Record<string, string> = {
  truetype: "ttf",
  woff: "woff",
  woff2: "woff2",
  opentype: "otf",
}

export async function processGoogleFonts(
  stylesheet: string,
  baseUrl: string,
): Promise<{
  processedStylesheet: string
  fontFiles: GoogleFontFile[]
}> {
  const fontSourceRegex =
    /url\((https:\/\/fonts.gstatic.com\/.+(?:\/|(?:kit=))(.+?)[.&].+?)\)\sformat\('(\w+?)'\);/g
  const fontFiles: GoogleFontFile[] = []
  let processedStylesheet = stylesheet

  let match
  while ((match = fontSourceRegex.exec(stylesheet)) !== null) {
    const url = match[1]
    const filename = match[2]
    const extension = fontMimeMap[match[3].toLowerCase()]
    // 使用相对路径，让浏览器根据当前协议自动选择 http/https
    const staticUrl = `/static/fonts/${filename}.${extension}`

    processedStylesheet = processedStylesheet.replace(url, staticUrl)
    fontFiles.push({ url, filename, extension })
  }

  return { processedStylesheet, fontFiles }
}

export function joinStyles(theme: Theme, ...stylesheet: string[]) {
  const styles = theme.styles
  
  return `
${stylesheet.join("\n\n")}

:root {
  --light: ${theme.colors.lightMode.light};
  --lightgray: ${theme.colors.lightMode.lightgray};
  --gray: ${theme.colors.lightMode.gray};
  --darkgray: ${theme.colors.lightMode.darkgray};
  --dark: ${theme.colors.lightMode.dark};
  --secondary: ${theme.colors.lightMode.secondary};
  --tertiary: ${theme.colors.lightMode.tertiary};
  --highlight: ${theme.colors.lightMode.highlight};
  --textHighlight: ${theme.colors.lightMode.textHighlight};

  --titleFont: "${getFontSpecificationName(theme.typography.title || theme.typography.header)}", ${DEFAULT_SANS_SERIF};
  --headerFont: "${getFontSpecificationName(theme.typography.header)}", ${DEFAULT_SANS_SERIF};
  --bodyFont: "${getFontSpecificationName(theme.typography.body)}", ${DEFAULT_SANS_SERIF};
  --codeFont: "${getFontSpecificationName(theme.typography.code)}", ${DEFAULT_MONO};
  
  ${styles ? `
  /* Explorer 样式变量 */
  --explorer-folder-font-weight: ${styles.explorer.folderFontWeight};
  --explorer-folder-font-size: ${styles.explorer.folderFontSize};
  --explorer-folder-padding: ${styles.explorer.folderPadding};
  --explorer-folder-border-radius: ${styles.explorer.folderBorderRadius};
  --explorer-folder-bg-hover: ${styles.explorer.folderBackgroundHover};
  --explorer-item-spacing: ${styles.explorer.itemSpacing};
  --explorer-file-font-size: ${styles.explorer.fileFontSize};
  
  /* CustomMeta 容器样式变量 */
  --meta-container-padding: ${styles.customMeta.containerPadding};
  --meta-container-margin: ${styles.customMeta.containerMargin};
  --meta-container-background: ${styles.customMeta.containerBackground};
  --meta-container-border: ${styles.customMeta.containerBorder};
  --meta-container-border-radius: ${styles.customMeta.containerBorderRadius};
  --meta-container-shadow: ${styles.customMeta.containerShadow};
  
  /* CustomMeta 表格样式变量 */
  --meta-table-border-radius: ${styles.customMeta.tableBorderRadius};
  --meta-table-padding: ${styles.customMeta.tablePadding};
  --meta-key-font-weight: ${styles.customMeta.keyFontWeight};
  --meta-row-hover-opacity: ${styles.customMeta.rowHoverOpacity};
  --meta-striped-opacity: ${styles.customMeta.stripedRowOpacity};
  
  /* Homepage 首页样式变量 */
  --homepage-card-padding: ${styles.homepage.cardPadding};
  --homepage-card-border-radius: ${styles.homepage.cardBorderRadius};
  --homepage-card-border: ${styles.homepage.cardBorder};
  --homepage-card-shadow: ${styles.homepage.cardShadow};
  --homepage-card-hover-transform: ${styles.homepage.cardHoverTransform};
  --homepage-card-hover-shadow: ${styles.homepage.cardHoverShadow};
  
  --homepage-tag-padding: ${styles.homepage.tagPadding};
  --homepage-tag-border-radius: ${styles.homepage.tagBorderRadius};
  --homepage-tag-border: ${styles.homepage.tagBorder};
  --homepage-tag-count-size: ${styles.homepage.tagCountSize};
  --homepage-tag-count-border-radius: ${styles.homepage.tagCountBorderRadius};
  ` : ''}
}

:root[saved-theme="dark"] {
  --light: ${theme.colors.darkMode.light};
  --lightgray: ${theme.colors.darkMode.lightgray};
  --gray: ${theme.colors.darkMode.gray};
  --darkgray: ${theme.colors.darkMode.darkgray};
  --dark: ${theme.colors.darkMode.dark};
  --secondary: ${theme.colors.darkMode.secondary};
  --tertiary: ${theme.colors.darkMode.tertiary};
  --highlight: ${theme.colors.darkMode.highlight};
  --textHighlight: ${theme.colors.darkMode.textHighlight};
}
`
}

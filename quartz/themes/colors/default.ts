import { ColorScheme } from "../../util/theme"

/**
 * 默认配色主题 - 原始 Quartz 配色
 */
export const defaultColors = {
  name: "默认配色",
  description: "Quartz 原始配色方案",
  lightMode: {
    light: "#faf8f8",
    lightgray: "#e5e5e5",
    gray: "#b8b8b8",
    darkgray: "#4e4e4e",
    dark: "#2b2b2b",
    secondary: "#284b63",
    tertiary: "#84a59d",
    highlight: "rgba(143, 159, 169, 0.15)",
    textHighlight: "#fff23688",
  } as ColorScheme,
  darkMode: {
    light: "#161618",
    lightgray: "#393639",
    gray: "#646464",
    darkgray: "#d4d4d4",
    dark: "#ebebec",
    secondary: "#7b97aa",
    tertiary: "#84a59d",
    highlight: "rgba(143, 159, 169, 0.15)",
    textHighlight: "#b3aa0288",
  } as ColorScheme,
}

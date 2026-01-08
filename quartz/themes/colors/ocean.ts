import { ColorScheme } from "../../util/theme"

export const oceanColors = {
  name: "深海蓝",
  description: "深蓝配色",
  lightMode: {
    light: "#f8fafc",           // 极浅的蓝灰色背景
    lightgray: "#e2e8f0",       // 浅蓝灰
    gray: "#94a3b8",            // 中灰蓝
    darkgray: "#334155",        // 深蓝灰
    dark: "#0f172a",            // 深蓝黑
    secondary: "#0369a1",       // 主蓝色（链接等）
    tertiary: "#0891b2",        // 青色（强调）
    highlight: "rgba(3, 105, 161, 0.1)",
    textHighlight: "#fef3c7aa",
  } as ColorScheme,
  darkMode: {
    light: "#0f172a",           // 深蓝黑背景
    lightgray: "#1e293b",       // 深蓝灰
    gray: "#475569",            // 中蓝灰
    darkgray: "#cbd5e1",        // 浅蓝灰
    dark: "#f1f5f9",            // 浅色文字
    secondary: "#38bdf8",       // 亮蓝色
    tertiary: "#22d3ee",        // 亮青色
    highlight: "rgba(56, 189, 248, 0.15)",
    textHighlight: "#fef3c788",
  } as ColorScheme,
}

import { ColorScheme } from "../../util/theme"

export const oceanColors = {
  name: "深海蓝",
  description: "深蓝配色",
  lightMode: {
    light: "#ffffff",           // 纯白背景，去除灰蒙感
    lightgray: "#dce3ec",       // 分隔线略加深，层次更清晰
    gray: "#64748b",            // 中间色加深一档（节点默认色/次要文字，"看不清"主因）
    darkgray: "#334155",        // 深蓝灰
    dark: "#0f172a",            // 深蓝黑
    secondary: "#0369a1",       // 主蓝色（链接等）
    tertiary: "#0891b2",        // 青色（强调）
    highlight: "rgba(3, 105, 161, 0.1)",
    textHighlight: "#fef3c7aa",
  } as ColorScheme,
  darkMode: {
    light: "#0b1220",           // 背景更深，给节点留对比空间
    lightgray: "#243244",       // 边框提一档
    gray: "#7c8ba1",            // 节点/中间色大幅提亮，解决暗色糊成一片
    darkgray: "#cbd5e1",        // 浅蓝灰
    dark: "#f1f5f9",            // 浅色文字
    secondary: "#38bdf8",       // 亮蓝色
    tertiary: "#22d3ee",        // 亮青色
    highlight: "rgba(56, 189, 248, 0.15)",
    textHighlight: "#fef3c788",
  } as ColorScheme,
}

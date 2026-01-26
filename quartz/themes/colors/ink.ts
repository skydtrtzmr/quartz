import { ColorScheme } from "../../util/theme"

export const inkColors = {
  name: "黑白灰配色",
  description: "",
  lightMode: {
    light: "#ffffff",
    lightgray: "#f5f5f5",
    gray: "#9ca3af",
    darkgray: "#374151", 
    dark: "#111827", 
    secondary: "#4b5563",
    tertiary: "#6b7280", 
    highlight: "rgba(75, 85, 99, 0.08)",
    textHighlight: "#fef3c788",
  } as ColorScheme,
  darkMode: {
    light: "#0a0a0a",
    lightgray: "#1a1a1a", 
    gray: "#525252",
    darkgray: "#d4d4d4",
    dark: "#fafafa",
    secondary: "#a3a3a3",
    tertiary: "#d4d4d4",
    highlight: "rgba(163, 163, 163, 0.12)",
    textHighlight: "#fef3c766",
  } as ColorScheme,
}

// Quartz 主题系统
// 类型定义，主题配置导出

import { ColorScheme } from "../util/theme"

// === 类型定义 ===

// 颜色主题接口
export interface ColorTheme {
  name: string
  description?: string
  lightMode: ColorScheme
  darkMode: ColorScheme
}

// 样式主题接口
// 目前只包含视觉风格相关的配置（颜色、圆角、阴影、边框等），字号、间距等基础样式在源码中直接定义

export interface StyleTheme {
  name: string
  description?: string
  
  // Explorer 目录样式
  explorer: {
    folderFontWeight: string          // 字重（影响视觉层次）
    folderFontSize: string            // 文件夹字体大小
    folderPadding: string             // 内边距（影响可点击区域）
    folderBorderRadius: string        // 圆角
    folderBackgroundHover: string     // 悬停背景色
    itemSpacing: string               // 项目间距（影响布局视觉）
    fileFontSize: string              // 文件字体大小
  }
  
  // CustomMeta 元数据样式
  customMeta: {
    // 容器视觉风格
    containerPadding: string          // 容器内边距
    containerMargin: string           // 容器外边距
    containerBackground: string       // 背景色
    containerBorder: string           // 边框样式
    containerBorderRadius: string     // 圆角
    containerShadow: string           // 阴影效果
    
    // 表格视觉细节
    tableBorderRadius: string         // 表格圆角
    tablePadding: string              // 表格内边距
    keyFontWeight: string             // 键的字重
    rowHoverOpacity: string           // 行悬停透明度
    stripedRowOpacity: string         // 斑马纹透明度
  }
  
  // Homepage 首页样式
  homepage: {
    // 文件夹卡片样式
    cardPadding: string               // 卡片内边距
    cardBorderRadius: string          // 卡片圆角
    cardBorder: string                // 卡片边框
    cardShadow: string                // 卡片阴影
    cardHoverTransform: string        // 悬停变换效果
    cardHoverShadow: string           // 悬停阴影
    
    // 标签样式
    tagPadding: string                // 标签内边距
    tagBorderRadius: string           // 标签圆角
    tagBorder: string                 // 标签边框
    tagCountSize: string              // 数字徽章大小
    tagCountBorderRadius: string      // 数字徽章圆角
  }
}

// === 主题导出 ===

// 导出配色主题
export * from "./colors/default"
export * from "./colors/ocean"
export * from "./colors/ink"

// 导出样式主题
// export * from "./styles/default"
// export * from "./styles/card"

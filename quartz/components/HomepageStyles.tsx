import { QuartzComponent, QuartzComponentConstructor } from "./types"
import style from "./styles/homepage.scss"

/**
 * HomepageStyles - 一个隐藏的组件，用于确保 homepage.scss 样式被加载
 * 
 * 这个组件不渲染任何内容，只是用来触发 homepage.scss 的加载。
 * 由于 FolderCards、FeaturedTags、RecentUpdates 都共享同一个 homepage.scss，
 * 我们需要确保至少有一个组件被无条件加载，以触发 CSS 的全局注入。
 */
export default (() => {
  const HomepageStyles: QuartzComponent = () => {
    return null // 不渲染任何内容
  }

  HomepageStyles.css = style // 关键：加载 homepage.scss
  return HomepageStyles
}) satisfies QuartzComponentConstructor

// 对于CSS 模块化 + 条件渲染导致的样式丢失问题：
// 1. 共享的样式文件需要确保至少有一个组件被无条件加载
// 2. 条件渲染的组件可能导致 CSS 不被收集
// 3. 使用隐藏的样式加载组件是一个可行解决方案
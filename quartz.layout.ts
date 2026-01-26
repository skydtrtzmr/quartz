import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {
      GitHub: "https://github.com/jackyzha0/quartz",
      "Discord Community": "https://discord.gg/cRFFHYye7t",
    },
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
    Component.FrontmatterMeta(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search2(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer2({
      stickyHeaders: false,
    }),
  ],
  right: [
    Component.Graph({
      localGraph: {
        // ... 其他配置
        // fontSize: 0.4, // 减小初始字体大小（默认0.6）
        // opacityScale: 0.5, // 减小透明度缩放，需要更大缩放才显示label（默认1）
      },
      globalGraph: {
        // ... 其他配置
        fontSize: 0.4, // 减小初始字体大小（默认0.6）
        opacityScale: 0.6, // 减小透明度缩放，需要更大缩放才显示label（默认1）
      },
    }),
    Component.DesktopOnly(Component.TableOfContents2()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          // [NOTE] 注意这里必须和上面一样选用相同的Search组件，否则会导致元素重复渲染问题
          Component: Component.Search2(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer2({
      stickyHeaders: false,
    }),
  ],
  right: [],
}

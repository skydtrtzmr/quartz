import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

export interface HomepageTitleOptions {
  /**
   * 首页主标题（默认使用页面 title）
   */
  title?: string
  /**
   * 首页描述文本
   */
  description?: string
}

const defaultOptions: HomepageTitleOptions = {
  title: undefined,
  description: undefined,
}

export default ((userOpts?: Partial<HomepageTitleOptions>) => {
  const opts: HomepageTitleOptions = { ...defaultOptions, ...userOpts }

  const HomepageTitle: QuartzComponent = ({ fileData }: QuartzComponentProps) => {
    const title = opts.title || fileData.frontmatter?.title || "首页"
    const description = opts.description || fileData.frontmatter?.description

    return (
      <div class="homepage-title-wrapper">
        <h1 class="homepage-title">{title}</h1>
        {description && <p class="homepage-description">{description}</p>}
      </div>
    )
  }

  HomepageTitle.css = `
.homepage-title-wrapper {
  margin-bottom: 2rem;
}
.homepage-title {
  font-size: 2.5rem;
  font-weight: 700;
  margin: 2rem 0 1rem 0;
  color: var(--secondary);
  font-family: var(--headerFont);
  text-align: center;
  position: relative;
  padding-bottom: 1rem;
}
.homepage-title::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100px;
  height: 3px;
  background: var(--secondary);
  border-radius: 2px;
}
.homepage-description {
  text-align: center;
  font-size: 1rem;
  color: var(--gray);
  margin: 0 0 1rem 0;
  line-height: 1.6;
}
@media (max-width: 800px) {
  .homepage-title {
    font-size: 2rem;
    margin: 1.5rem 0 0.75rem 0;
  }
  
  .homepage-description {
    font-size: 0.95rem;
  }
}
`

  return HomepageTitle
}) satisfies QuartzComponentConstructor
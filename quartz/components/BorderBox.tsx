import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"

export interface BorderBoxOptions {
  /**
   * 要包裹的组件
   */
  component: QuartzComponent
}

export default ((opts: BorderBoxOptions) => {
  const BorderBox: QuartzComponent = (props: QuartzComponentProps) => {
    const Component = opts.component

    return (
      <div class="border-box-wrapper">
        <Component {...props} />
      </div>
    )
  }

  BorderBox.css = `
.border-box-wrapper {
  max-width: 100%;
  height: 100%; /* 拉伸以占满父容器高度 */
  padding: 1.5rem;
  margin-bottom: 2rem;
  background: var(--light);
  border: 1px solid var(--lightgray);
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  box-sizing: border-box;
  display: flex; /* 使用 flex 布局 */
  flex-direction: column; /* 垂直方向 */
  
  @media (max-width: 800px) {
    padding: 1rem;
    margin-bottom: 1.5rem;
  }
}
`

  return BorderBox
}) satisfies QuartzComponentConstructor<BorderBoxOptions>
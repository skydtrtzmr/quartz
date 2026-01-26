import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/search.scss"
// @ts-ignore
import script from "./scripts/search2.inline"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"

export interface Search2Options {
  enablePreview: boolean
  initialDisplayCount: number  // 首批显示的数量
  loadMoreCount: number  // 每批加载更多的数量
}

const defaultOptions: Search2Options = {
  enablePreview: true,
  initialDisplayCount: 10,
  loadMoreCount: 10,
}

export default ((userOpts?: Partial<Search2Options>) => {
  const Search2: QuartzComponent = ({ displayClass, cfg }: QuartzComponentProps) => {
    const opts = { ...defaultOptions, ...userOpts }
    const searchPlaceholder = i18n(cfg.locale).components.search.searchBarPlaceholder
    return (
      <div class={classNames(displayClass, "search")} data-initial-display={opts.initialDisplayCount} data-load-more={opts.loadMoreCount}>
        <button class="search-button">
          <svg role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19.9 19.7">
            <title>Search</title>
            <g class="search-path" fill="none">
              <path stroke-linecap="square" d="M18.5 18.3l-5.4-5.4" />
              <circle cx="8" cy="8" r="7" />
            </g>
          </svg>
          <p>{i18n(cfg.locale).components.search.title}</p>
        </button>
        <div class="search-container">
          <div class="search-space">
            <input
              autocomplete="off"
              class="search-bar"
              name="search"
              type="text"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
            />
            <div class="search-layout" data-preview={opts.enablePreview}></div>
          </div>
        </div>
      </div>
    )
  }

  Search2.afterDOMLoaded = script
  Search2.css = style

  return Search2
}) satisfies QuartzComponentConstructor

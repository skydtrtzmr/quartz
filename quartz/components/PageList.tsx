import { FullSlug, isFolderPath, resolveRelative } from "../util/path"
import { QuartzPluginData } from "../plugins/vfile"
import { Date, getDate, formatDate } from "./Date"
import { QuartzComponent, QuartzComponentProps } from "./types"
import { GlobalConfiguration } from "../cfg"
// @ts-ignore
import script from "./scripts/pageList.inline"

export type SortFn = (f1: QuartzPluginData, f2: QuartzPluginData) => number

export function byDateAndAlphabetical(cfg: GlobalConfiguration): SortFn {
  return (f1, f2) => {
    // Sort by date/alphabetical
    if (f1.dates && f2.dates) {
      // sort descending
      return getDate(cfg, f2)!.getTime() - getDate(cfg, f1)!.getTime()
    } else if (f1.dates && !f2.dates) {
      // prioritize files with dates
      return -1
    } else if (!f1.dates && f2.dates) {
      return 1
    }

    // otherwise, sort lexographically by title
    const f1Title = f1.frontmatter?.title.toLowerCase() ?? ""
    const f2Title = f2.frontmatter?.title.toLowerCase() ?? ""
    return f1Title.localeCompare(f2Title)
  }
}

export function byDateAndAlphabeticalFolderFirst(cfg: GlobalConfiguration): SortFn {
  return (f1, f2) => {
    // Sort folders first
    const f1IsFolder = isFolderPath(f1.slug ?? "")
    const f2IsFolder = isFolderPath(f2.slug ?? "")
    if (f1IsFolder && !f2IsFolder) return -1
    if (!f1IsFolder && f2IsFolder) return 1

    // If both are folders or both are files, sort by date/alphabetical
    if (f1.dates && f2.dates) {
      // sort descending
      return getDate(cfg, f2)!.getTime() - getDate(cfg, f1)!.getTime()
    } else if (f1.dates && !f2.dates) {
      // prioritize files with dates
      return -1
    } else if (!f1.dates && f2.dates) {
      return 1
    }

    // otherwise, sort lexographically by title
    const f1Title = f1.frontmatter?.title.toLowerCase() ?? ""
    const f2Title = f2.frontmatter?.title.toLowerCase() ?? ""
    return f1Title.localeCompare(f2Title)
  }
}

export type BatchLoadOptions = {
  enable?: boolean
  initialCount?: number
  loadMoreCount?: number
}

interface BatchPageData {
  slug: string
  title: string
  tags: string[]
  dateStr?: string
}

type Props = {
  limit?: number
  sort?: SortFn
  batchLoad?: BatchLoadOptions
} & QuartzComponentProps

export const PageList: QuartzComponent = ({ cfg, fileData, allFiles, limit, sort, batchLoad }: Props) => {
  const sorter = sort ?? byDateAndAlphabeticalFolderFirst(cfg)
  let list = allFiles.sort(sorter)
  if (limit) {
    list = list.slice(0, limit)
  }

  const initialCount = batchLoad?.initialCount ?? 10
  const isBatchEnabled = batchLoad?.enable && !limit && list.length > initialCount

  let displayList = list
  let remainingData: string = "[]"

  if (isBatchEnabled) {
    displayList = list.slice(0, initialCount)
    const remaining: BatchPageData[] = list.slice(initialCount).map((page) => {
      const date = getDate(cfg, page)
      return {
        slug: page.slug!,
        title: page.frontmatter?.title ?? "",
        tags: page.frontmatter?.tags ?? [],
        dateStr: date ? formatDate(date, cfg.locale) : undefined,
      }
    })
    remainingData = JSON.stringify(remaining)
  }

  return (
    <ul
      class="section-ul"
      data-batch-load={isBatchEnabled ? "true" : undefined}
      data-current-slug={fileData.slug}
      data-initial-count={isBatchEnabled ? initialCount : undefined}
      data-load-more-count={isBatchEnabled ? (batchLoad?.loadMoreCount ?? 10) : undefined}
      data-remaining-pages={isBatchEnabled ? remainingData : undefined}
    >
      {displayList.map((page) => {
        const title = page.frontmatter?.title
        const tags = page.frontmatter?.tags ?? []

        return (
          <li class="section-li">
            <div class="section">
              <p class="meta">
                {page.dates && <Date date={getDate(cfg, page)!} locale={cfg.locale} />}
              </p>
              <div class="desc">
                <h3>
                  <a href={resolveRelative(fileData.slug!, page.slug!)} class="internal">
                    {title}
                  </a>
                </h3>
              </div>
              <ul class="tags">
                {tags.map((tag) => (
                  <li>
                    <a
                      class="internal tag-link"
                      href={resolveRelative(fileData.slug!, `tags/${tag}` as FullSlug)}
                    >
                      {tag}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

PageList.css = `
.section h3 {
  margin: 0;
}

.section > .tags {
  margin: 0;
}

.load-more-item {
  list-style: none;
  margin-top: 1em;
  text-align: center;
}

.load-more-btn {
  padding: 0.5em 1.5em;
  background-color: var(--lightgray);
  border: 1px dashed var(--gray);
  border-radius: 6px;
  color: var(--darkgray);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover {
  background-color: var(--highlight);
  border-color: var(--secondary);
  color: var(--secondary);
}
`

PageList.afterDOMLoaded = script

import { FullSlug, resolveRelative } from "../../util/path"

interface BatchPageData {
  slug: string
  title: string
  tags: string[]
  dateStr?: string
}

function setupPageListBatchLoad() {
  const lists = document.querySelectorAll('ul.section-ul[data-batch-load="true"]') as NodeListOf<HTMLElement>

  lists.forEach((ul) => {
    if (ul.dataset.batchInitialized === "true") return
    ul.dataset.batchInitialized = "true"

    const currentSlug = ul.dataset.currentSlug!
    const loadMoreCount = parseInt(ul.dataset.loadMoreCount || "10")
    let remaining: BatchPageData[] = JSON.parse(ul.dataset.remainingPages || "[]")

    const updateLoadMoreButton = () => {
      let loadMoreItem = ul.querySelector(".load-more-item") as HTMLElement | null
      if (remaining.length === 0) {
        if (loadMoreItem) loadMoreItem.remove()
        return
      }

      if (!loadMoreItem) {
        loadMoreItem = document.createElement("li")
        loadMoreItem.className = "load-more-item"
        const btn = document.createElement("button")
        btn.className = "page-list-load-more-btn"
        btn.type = "button"
        btn.addEventListener("click", () => {
          const count = loadMoreCount
          const batch = remaining.slice(0, count)
          remaining = remaining.slice(count)

          const fragment = document.createDocumentFragment()
          for (const page of batch) {
            const li = document.createElement("li")
            li.className = "section-li"

            const dateHtml = page.dateStr
              ? `<p class="meta"><time datetime="">${page.dateStr}</time></p>`
              : `<p class="meta"></p>`

            const tagsHtml = page.tags.length
              ? `<ul class="tags">${page.tags
                  .map((tag) => {
                    const tagHref = resolveRelative(currentSlug as FullSlug, `tags/${tag}` as FullSlug)
                    return `<li><a class="internal tag-link" href="${tagHref}">${tag}</a></li>`
                  })
                  .join("")}</ul>`
              : `<ul class="tags"></ul>`

            const pageHref = resolveRelative(currentSlug as FullSlug, page.slug as FullSlug)

            li.innerHTML = `
              <div class="section">
                ${dateHtml}
                <div class="desc">
                  <h3><a href="${pageHref}" class="internal">${page.title}</a></h3>
                </div>
                ${tagsHtml}
              </div>
            `
            fragment.appendChild(li)
          }

          loadMoreItem!.before(fragment)
          updateLoadMoreButton()
        })
        loadMoreItem.appendChild(btn)
        ul.appendChild(loadMoreItem)
      }

      const btn = loadMoreItem.querySelector(".page-list-load-more-btn") as HTMLButtonElement
      btn.textContent = `加载更多 (剩余 ${remaining.length} 条)`
    }

    if (remaining.length > 0) {
      updateLoadMoreButton()
    }
  })
}

document.addEventListener("nav", () => {
  setupPageListBatchLoad()
})

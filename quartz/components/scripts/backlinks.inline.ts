import { FullSlug, resolveRelative } from "../../util/path"

interface BacklinkItem {
  slug: string
  title: string
}

interface SerializedNode {
  segment: string
  totalCount: number
  files: BacklinkItem[]
  children: SerializedNode[]
}

function renderGroupNode(
  ul: HTMLElement,
  node: SerializedNode,
  threshold: number,
  currentSlug: string,
  level: number,
) {
  // 1. 渲染 files 分批
  let remainingFiles = [...node.files]

  const renderFilesBatch = () => {
    const batch = remainingFiles.slice(0, threshold)
    remainingFiles = remainingFiles.slice(threshold)

    const fragment = document.createDocumentFragment()
    for (const item of batch) {
      const li = document.createElement("li")
      li.innerHTML = `<a href="${resolveRelative(
        currentSlug as FullSlug,
        item.slug as FullSlug,
      )}" class="internal">${item.title}</a>`
      fragment.appendChild(li)
    }

    // 移除旧的加载更多按钮
    const oldMore = ul.querySelector(".group-load-more")
    if (oldMore) oldMore.remove()

    ul.appendChild(fragment)

    if (remainingFiles.length > 0) {
      const moreLi = document.createElement("li")
      moreLi.className = "group-load-more"
      const moreBtn = document.createElement("button")
      moreBtn.type = "button"
      moreBtn.className = "backlinks-load-more-btn"
      moreBtn.textContent = `加载更多 (剩余 ${remainingFiles.length} 条)`
      moreBtn.addEventListener("click", renderFilesBatch)
      moreLi.appendChild(moreBtn)
      ul.appendChild(moreLi)
    }
  }

  if (node.files.length > 0) {
    renderFilesBatch()
  }

  // 2. 渲染子分组
  for (const child of node.children) {
    const childLi = document.createElement("li")
    childLi.className = "backlink-group nested"
    const paddingLeft = `${0.35 + (level + 1) * 0.5}rem`
    childLi.innerHTML = `
      <button type="button" class="group-header" style="padding-left: ${paddingLeft}">
        <span class="group-arrow">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </span>
        <span class="group-title">${escapeHtml(child.segment)}</span>
        <span class="group-count">(${child.totalCount})</span>
      </button>
      <div class="group-content">
        <ul class="group-list" data-remaining="${escapeHtml(JSON.stringify(child))}"></ul>
      </div>
    `
    ul.appendChild(childLi)
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

// ===== 全局事件委托：处理分组展开/折叠和根目录加载更多 =====
function setupBacklinksDelegation() {
  // 1. 分组展开/折叠事件委托
  document.addEventListener("click", (e) => {
    const header = (e.target as HTMLElement).closest(".backlinks-list .group-header") as HTMLButtonElement | null
    if (!header) return

    const groupLi = header.closest(".backlink-group") as HTMLElement
    const content = groupLi.querySelector(".group-content") as HTMLElement
    const groupList = content.querySelector(".group-list") as HTMLElement
    const isOpen = content.classList.toggle("open")
    header.classList.toggle("open", isOpen)

    if (isOpen && !groupList.dataset.groupInitialized) {
      groupList.dataset.groupInitialized = "true"
      const remainingRaw = groupList.dataset.remaining
      const node: SerializedNode = remainingRaw ? JSON.parse(remainingRaw) : { files: [], children: [] }

      const list = header.closest(".backlinks-list") as HTMLElement
      const threshold = parseInt(list.dataset.threshold || "20")
      const currentSlug = list.dataset.currentSlug!

      renderGroupNode(groupList, node, threshold, currentSlug, 0)
    }
  })

  // 2. 根目录加载更多事件委托
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".backlinks-list .root-load-more") as HTMLButtonElement | null
    if (!btn) return

    const rootMoreItem = btn.closest(".backlink-root-more") as HTMLElement
    const list = rootMoreItem.closest(".backlinks-list") as HTMLElement
    const threshold = parseInt(list.dataset.threshold || "20")
    const currentSlug = list.dataset.currentSlug!
    const remainingRaw = rootMoreItem.dataset.remaining
    let remaining: BacklinkItem[] = remainingRaw ? JSON.parse(remainingRaw) : []

    if (remaining.length === 0) {
      rootMoreItem.remove()
      return
    }

    const batch = remaining.slice(0, threshold)
    remaining = remaining.slice(threshold)
    rootMoreItem.dataset.remaining = JSON.stringify(remaining)

    const fragment = document.createDocumentFragment()
    for (const item of batch) {
      const li = document.createElement("li")
      li.className = "backlink-root-item"
      li.innerHTML = `<a href="${resolveRelative(
        currentSlug as FullSlug,
        item.slug as FullSlug,
      )}" class="internal">${item.title}</a>`
      fragment.appendChild(li)
    }
    rootMoreItem.before(fragment)

    if (remaining.length === 0) {
      rootMoreItem.remove()
    } else {
      btn.textContent = `加载更多 (剩余 ${remaining.length} 条)`
    }
  })
}

let delegationInitialized = false

document.addEventListener("nav", () => {
  if (!delegationInitialized) {
    setupBacklinksDelegation()
    delegationInitialized = true
  }

  // 自动初始化所有默认展开的分组（用于 total <= threshold 的情况）
  const openGroups = document.querySelectorAll(
    '.backlinks-list .group-content.open > .group-list:not([data-group-initialized])',
  ) as NodeListOf<HTMLElement>

  for (const groupList of openGroups) {
    groupList.dataset.groupInitialized = "true"
    const remainingRaw = groupList.dataset.remaining
    const node: SerializedNode = remainingRaw ? JSON.parse(remainingRaw) : { files: [], children: [] }
    const list = groupList.closest(".backlinks-list") as HTMLElement
    const threshold = parseInt(list.dataset.threshold || "20")
    const currentSlug = list.dataset.currentSlug!
    renderGroupNode(groupList, node, threshold, currentSlug, 0)
  }
})

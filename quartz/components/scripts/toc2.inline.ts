// 切换子级目录的折叠/展开
function toggleSubToc(this: HTMLElement, event: Event) {
  event.stopPropagation()
  event.preventDefault()
  
  this.classList.toggle("collapsed")
  this.setAttribute(
    "aria-expanded",
    this.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )
  
  const targetId = this.getAttribute("aria-controls")
  if (!targetId) return
  
  const childrenList = document.getElementById(targetId)
  if (childrenList) {
    childrenList.classList.toggle("collapsed")
  }
}

function toggleToc2(this: HTMLElement) {
  this.classList.toggle("collapsed")
  this.setAttribute(
    "aria-expanded",
    this.getAttribute("aria-expanded") === "true" ? "false" : "true",
  )
  const content = this.nextElementSibling as HTMLElement | undefined
  if (!content) return
  content.classList.toggle("collapsed")
}

// 高亮指定slug的TOC项
function highlightTocItem(slug: string) {
  // 移除所有active状态
  document.querySelectorAll(".toc-item.active").forEach((item) => {
    item.classList.remove("active")
  })
  
  // 添加新的active状态
  const tocLink = document.querySelector(`a[data-for="${slug}"]`)
  if (tocLink) {
    const parentLi = tocLink.closest(".toc-item")
    if (parentLi) {
      parentLi.classList.add("active")
    }
  }
}

// 查找元素所属的最近标题
function findNearestHeadingSlug(element: Element): string | null {
  let current: Element | null = element
  
  // 向上查找，直到找到标题或到达顶部
  while (current && current !== document.body) {
    // 如果当前元素就是标题
    if (current.tagName.match(/^H[1-6]$/)) {
      return current.id || null
    }
    
    // 查找前面的兄弟标题
    let sibling = current.previousElementSibling
    while (sibling) {
      if (sibling.tagName.match(/^H[1-6]$/)) {
        return sibling.id || null
      }
      // 递归查找兄弟元素中的标题
      const headingInSibling = sibling.querySelector("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")
      if (headingInSibling) {
        return headingInSibling.id || null
      }
      sibling = sibling.previousElementSibling
    }
    
    current = current.parentElement
  }
  
  return null
}

function setupToc2() {
  for (const toc of document.getElementsByClassName("toc2")) {
    // 设置主折叠按钮
    const button = toc.querySelector(".toc2-header")
    const content = toc.querySelector(".toc2-content")
    if (!button || !content) return
    button.addEventListener("click", toggleToc2)
    window.addCleanup(() => button.removeEventListener("click", toggleToc2))
    
    // 设置每个子级折叠按钮
    const toggleButtons = toc.querySelectorAll(".toc-toggle")
    toggleButtons.forEach((toggleBtn) => {
      toggleBtn.addEventListener("click", toggleSubToc)
      window.addCleanup(() => toggleBtn.removeEventListener("click", toggleSubToc))
    })
    
    // 点击TOC链接时高亮
    const links = toc.querySelectorAll(".toc-link")
    links.forEach((link) => {
      link.addEventListener("click", function(this: HTMLElement) {
        const slug = this.getAttribute("data-for")
        if (slug) {
          highlightTocItem(slug)
        }
      })
    })
  }
  
  // 监听文章内容区域的点击事件
  const articleContent = document.querySelector("article.popover-hint") || document.querySelector("article")
  
  if (articleContent) {
    const clickHandler = (event: Event) => {
      const target = event.target as Element
      
      // 查找点击位置最近的标题
      const slug = findNearestHeadingSlug(target)
      
      if (slug) {
        highlightTocItem(slug)
      }
    }
    
    articleContent.addEventListener("click", clickHandler)
    window.addCleanup(() => articleContent.removeEventListener("click", clickHandler))
    // console.log("[TOC2] Article click listener attached")
  } else {
    // console.warn("[TOC2] Article content element not found!")
  }
}

document.addEventListener("nav", () => {
  setupToc2()
})

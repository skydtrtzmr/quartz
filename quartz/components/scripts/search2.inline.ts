import FlexSearch, { DefaultDocumentSearchResults } from "flexsearch"
import { ContentDetails } from "../../plugins/emitters/contentIndex"
import { registerEscapeHandler, removeAllChildren } from "./util"
import { FullSlug, normalizeRelativeURLs, resolveRelative } from "../../util/path"

interface Item {
  id: number
  slug: FullSlug
  title: string
  content: string
  tags: string[]
  frontmatter?: Record<string, any>
  [key: string]: any
}

// Can be expanded with things like "term" in the future
type SearchType = "basic" | "tags" | "yaml"
let searchType: SearchType = "basic"
let currentSearchTerm: string = ""

// 新增：存储所有搜索结果和显示控制
let allSearchResults: Item[] = []
let currentDisplayCount: number = 10
let initialDisplayCount: number = 10
let loadMoreCount: number = 10

const encoder = (str: string): string[] => {
  // 最终返回的token数组
  const tokens: string[] = []
  // -1表示"当前没有正在处理的英文单词"
  let bufferStart = -1
  let bufferEnd = -1
  // 转小写,实现大小写不敏感
  const lower = str.toLowerCase()

  // 字符串索引位置
  let i = 0 
  for (const char of lower) {
    // 获取Unicode码点
    const code = char.codePointAt(0)!

    // ========== 第一步:判断字符类型 ==========
    const isCJK =
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x20000 && code <= 0x2a6df)

    const isWhitespace =
      code === 32 || // 空格
      code === 9 || // Tab
      code === 10 || // 换行\n
      code === 13 // 回车\r

    // ========== 第二步:根据字符类型处理 ==========
    if (isCJK) {
      // 情况1: 遇到中文字符
      if (bufferStart !== -1) {
        // 如果之前正在处理英文单词,先输出它
        tokens.push(lower.slice(bufferStart, bufferEnd))
        // 重置buffer
        bufferStart = -1
      }
      // 中文字符直接作为独立token
      tokens.push(char)
    } else if (isWhitespace) {
      // 情况2: 遇到空格
      if (bufferStart !== -1) {
        // 如果之前正在处理英文单词,输出它
        tokens.push(lower.slice(bufferStart, bufferEnd))
        // 重置buffer
        bufferStart = -1
      }
      // 空格本身不作为token
    } else {
      // 情况3: 遇到英文字符或其他字符
      if (bufferStart === -1) {
        // 如果是英文单词的第一个字符,记录起始位置
        bufferStart = i
      }
      // 更新结束位置
      bufferEnd = i + char.length
    }
    // 移动索引(处理emoji等多字节字符)
    i += char.length
  }

  // ========== 第三步:处理剩余的buffer ==========
  if (bufferStart !== -1) {
    // 如果最后还有未输出的英文单词,输出它
    tokens.push(lower.slice(bufferStart))
  }

  return tokens
}

// 配置分词器
// 这边的tokenize方式只会影响英文
let index = new FlexSearch.Document<Item>({
  encode: encoder,
  document: {
    id: "id",
    tag: "tags",
    index: [
      {
        field: "title",
        tokenize: "forward",
        // tokenize: "full",
      },
      {
        field: "content",
        tokenize: "forward",
        // tokenize: "full",
      },
      {
        field: "tags",
        tokenize: "forward",
        // tokenize: "full",
      },
    ],
  },
})

const p = new DOMParser()
const fetchContentCache: Map<FullSlug, Element[]> = new Map()
const contextWindowWords = 30
const numTagResults = 5

const tokenizeTerm = (term: string) => {
  const tokens = term.split(/\s+/).filter((t) => t.trim() !== "")
  const tokenLen = tokens.length
  if (tokenLen > 1) {
    for (let i = 1; i < tokenLen; i++) {
      tokens.push(tokens.slice(0, i + 1).join(" "))
    }
  }

  return tokens.sort((a, b) => b.length - a.length) // always highlight longest terms first
}

function highlight(searchTerm: string, text: string, trim?: boolean) {
  const tokenizedTerms = tokenizeTerm(searchTerm)
  let tokenizedText = text.split(/\s+/).filter((t) => t !== "")

  let startIndex = 0
  let endIndex = tokenizedText.length - 1
  if (trim) {
    const includesCheck = (tok: string) =>
      tokenizedTerms.some((term) => tok.toLowerCase().startsWith(term.toLowerCase()))
    const occurrencesIndices = tokenizedText.map(includesCheck)

    let bestSum = 0
    let bestIndex = 0
    for (let i = 0; i < Math.max(tokenizedText.length - contextWindowWords, 0); i++) {
      const window = occurrencesIndices.slice(i, i + contextWindowWords)
      const windowSum = window.reduce((total, cur) => total + (cur ? 1 : 0), 0)
      if (windowSum >= bestSum) {
        bestSum = windowSum
        bestIndex = i
      }
    }

    startIndex = Math.max(bestIndex - contextWindowWords, 0)
    endIndex = Math.min(startIndex + 2 * contextWindowWords, tokenizedText.length - 1)
    tokenizedText = tokenizedText.slice(startIndex, endIndex)
  }

  const slice = tokenizedText
    .map((tok) => {
      // see if this tok is prefixed by any search terms
      for (const searchTok of tokenizedTerms) {
        if (tok.toLowerCase().includes(searchTok.toLowerCase())) {
          const regex = new RegExp(searchTok.toLowerCase(), "gi")
          return tok.replace(regex, `<span class="highlight">$&</span>`)
        }
      }
      return tok
    })
    .join(" ")

  return `${startIndex === 0 ? "" : "..."}${slice}${
    endIndex === tokenizedText.length - 1 ? "" : "..."
  }`
}

function highlightHTML(searchTerm: string, el: HTMLElement) {
  const p = new DOMParser()
  const tokenizedTerms = tokenizeTerm(searchTerm)
  const html = p.parseFromString(el.innerHTML, "text/html")

  const createHighlightSpan = (text: string) => {
    const span = document.createElement("span")
    span.className = "highlight"
    span.textContent = text
    return span
  }

  const highlightTextNodes = (node: Node, term: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const nodeText = node.nodeValue ?? ""
      const regex = new RegExp(term.toLowerCase(), "gi")
      const matches = nodeText.match(regex)
      if (!matches || matches.length === 0) return
      const spanContainer = document.createElement("span")
      let lastIndex = 0
      for (const match of matches) {
        const matchIndex = nodeText.indexOf(match, lastIndex)
        spanContainer.appendChild(document.createTextNode(nodeText.slice(lastIndex, matchIndex)))
        spanContainer.appendChild(createHighlightSpan(match))
        lastIndex = matchIndex + match.length
      }
      spanContainer.appendChild(document.createTextNode(nodeText.slice(lastIndex)))
      node.parentNode?.replaceChild(spanContainer, node)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as HTMLElement).classList.contains("highlight")) return
      Array.from(node.childNodes).forEach((child) => highlightTextNodes(child, term))
    }
  }

  for (const term of tokenizedTerms) {
    highlightTextNodes(html.body, term)
  }

  return html.body
}

async function setupSearch(searchElement: Element, currentSlug: FullSlug, data: ContentIndex) {
  const container = searchElement.querySelector(".search-container") as HTMLElement
  if (!container) return

  const sidebar = container.closest(".sidebar") as HTMLElement | null

  const searchButton = searchElement.querySelector(".search-button") as HTMLButtonElement
  if (!searchButton) return

  const searchBar = searchElement.querySelector(".search-bar") as HTMLInputElement
  if (!searchBar) return

  const searchLayout = searchElement.querySelector(".search-layout") as HTMLElement
  if (!searchLayout) return

  // 从 data-* 属性读取配置
  initialDisplayCount = parseInt(searchElement.getAttribute("data-initial-display") || "10")
  loadMoreCount = parseInt(searchElement.getAttribute("data-load-more") || "10")
  currentDisplayCount = initialDisplayCount

  const idDataMap = Object.keys(data) as FullSlug[]
  const appendLayout = (el: HTMLElement) => {
    searchLayout.appendChild(el)
  }

  const enablePreview = searchLayout.dataset.preview === "true"
  let preview: HTMLDivElement | undefined = undefined
  let previewInner: HTMLDivElement | undefined = undefined
  const results = document.createElement("div")
  results.className = "results-container"
  appendLayout(results)

  if (enablePreview) {
    preview = document.createElement("div")
    preview.className = "preview-container"
    appendLayout(preview)
  }

  function hideSearch() {
    container.classList.remove("active")
    searchBar.value = "" // clear the input when we dismiss the search
    if (sidebar) sidebar.style.zIndex = ""
    removeAllChildren(results)
    if (preview) {
      removeAllChildren(preview)
    }
    searchLayout.classList.remove("display-results")
    searchType = "basic" // reset search type after closing
    // 重置显示计数
    currentDisplayCount = initialDisplayCount
    allSearchResults = []
    searchButton.focus()
  }

  function showSearch(searchTypeNew: SearchType) {
    searchType = searchTypeNew
    if (sidebar) sidebar.style.zIndex = "1"
    container.classList.add("active")
    searchBar.focus()
  }

  let currentHover: HTMLInputElement | null = null
  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "k" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const searchBarOpen = container.classList.contains("active")
      searchBarOpen ? hideSearch() : showSearch("basic")
      return
    } else if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // Hotkey to open tag search
      e.preventDefault()
      const searchBarOpen = container.classList.contains("active")
      searchBarOpen ? hideSearch() : showSearch("tags")

      // add "#" prefix for tag search
      searchBar.value = "#"
      return
    }

    if (currentHover) {
      currentHover.classList.remove("focus")
    }

    // If search is active, then we will render the first result and display accordingly
    if (!container.classList.contains("active")) return
    if (e.key === "Enter" && !e.isComposing) {
      // If result has focus, navigate to that one, otherwise pick first result
      if (results.contains(document.activeElement)) {
        const active = document.activeElement as HTMLInputElement
        if (active.classList.contains("no-match") || active.classList.contains("load-more-btn")) return
        await displayPreview(active)
        active.click()
      } else {
        const anchor = document.getElementsByClassName("result-card")[0] as HTMLInputElement | null
        if (!anchor || anchor.classList.contains("no-match")) return
        await displayPreview(anchor)
        anchor.click()
      }
    } else if (e.key === "ArrowUp" || (e.shiftKey && e.key === "Tab")) {
      e.preventDefault()
      if (results.contains(document.activeElement)) {
        // If an element in results-container already has focus, focus previous one
        const currentResult = currentHover
          ? currentHover
          : (document.activeElement as HTMLInputElement | null)
        const prevResult = currentResult?.previousElementSibling as HTMLInputElement | null
        currentResult?.classList.remove("focus")
        prevResult?.focus()
        if (prevResult) currentHover = prevResult
        await displayPreview(prevResult)
      }
    } else if (e.key === "ArrowDown" || e.key === "Tab") {
      e.preventDefault()
      // The results should already been focused, so we need to find the next one.
      // The activeElement is the search bar, so we need to find the first result and focus it.
      if (document.activeElement === searchBar || currentHover !== null) {
        const firstResult = currentHover
          ? currentHover
          : (document.getElementsByClassName("result-card")[0] as HTMLInputElement | null)
        const secondResult = firstResult?.nextElementSibling as HTMLInputElement | null
        firstResult?.classList.remove("focus")
        secondResult?.focus()
        if (secondResult) currentHover = secondResult
        await displayPreview(secondResult)
      }
    }
  }

  // 格式化搜索结果用于显示，支持混合高亮
  const formatForDisplay = (searchInfo: { text?: string, tags?: string[], yamlQueries?: any[] }, id: number) => {
    const slug = idDataMap[id]
    const doc = data[slug]
    
    // 收集所有需要高亮的词
    const highlightTerms: string[] = []
    
    // 添加文本搜索词
    if (searchInfo.text && searchInfo.text.trim()) {
      highlightTerms.push(searchInfo.text.trim())
    }
    
    // 添加标签搜索词
    if (searchInfo.tags && searchInfo.tags.length > 0) {
      highlightTerms.push(...searchInfo.tags)
    }
    
    // 添加YAML搜索词
    if (searchInfo.yamlQueries && searchInfo.yamlQueries.length > 0) {
      searchInfo.yamlQueries.forEach(query => {
        if (query.key) highlightTerms.push(query.key)
        if (query.value) highlightTerms.push(query.value)
      })
    }
    
    // 合并所有搜索词用于高亮
    const combinedTerm = highlightTerms.join(' ')
    
    return {
      id,
      slug,
      title: combinedTerm ? highlight(combinedTerm, doc.title ?? "") : doc.title ?? "",
      content: combinedTerm ? highlight(combinedTerm, doc.content ?? "", true) : doc.content ?? "",
      tags: searchInfo.tags && searchInfo.tags.length > 0 
        ? highlightTags(searchInfo.tags, doc.tags) 
        : formatTags(doc.tags),
    }
  }

  // 高亮标签（支持多个搜索词）
  function highlightTags(searchTags: string[], tags: string[]) {
    if (!tags || tags.length === 0) {
      return []
    }

    return tags
      .map((tag) => {
        const isMatch = searchTags.some(searchTag => 
          tag.toLowerCase().includes(searchTag.toLowerCase())
        )
        if (isMatch) {
          return `<li><p class="match-tag">#${tag}</p></li>`
        } else {
          return `<li><p>#${tag}</p></li>`
        }
      })
      .slice(0, numTagResults)
  }
  
  // 格式化标签（不高亮）
  function formatTags(tags: string[]) {
    if (!tags || tags.length === 0) {
      return []
    }
    return tags
      .map((tag) => `<li><p>#${tag}</p></li>`)
      .slice(0, numTagResults)
  }

  function resolveUrl(slug: FullSlug): URL {
    return new URL(resolveRelative(currentSlug, slug), location.toString())
  }

  const resultToHTML = ({ slug, title, content, tags }: Item) => {
    const htmlTags = tags.length > 0 ? `<ul class="tags">${tags.join("")}</ul>` : ``
    const itemTile = document.createElement("a")
    itemTile.classList.add("result-card")
    itemTile.id = slug
    itemTile.href = resolveUrl(slug).toString()
    itemTile.innerHTML = `
      <h3 class="card-title">${title}</h3>
      ${htmlTags}
      <p class="card-description">${content}</p>
    `
    itemTile.addEventListener("click", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      hideSearch()
    })

    const handler = (event: MouseEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      hideSearch()
    }

    async function onMouseEnter(ev: MouseEvent) {
      if (!ev.target) return
      const target = ev.target as HTMLInputElement
      await displayPreview(target)
    }

    itemTile.addEventListener("mouseenter", onMouseEnter)
    window.addCleanup(() => itemTile.removeEventListener("mouseenter", onMouseEnter))
    itemTile.addEventListener("click", handler)
    window.addCleanup(() => itemTile.removeEventListener("click", handler))

    return itemTile
  }

  // 新增：创建“加载更多”按钮
  function createLoadMoreButton(remainingCount: number): HTMLDivElement {
    const loadMoreBtn = document.createElement("div")
    loadMoreBtn.classList.add("result-card", "load-more-btn")
    loadMoreBtn.innerHTML = `
      <h3 class="card-title" style="text-align: center; cursor: pointer;">加载更多 (剩余 ${remainingCount} 条)</h3>
    `
    loadMoreBtn.addEventListener("click", async () => {
      currentDisplayCount += loadMoreCount
      await displayResults(allSearchResults)
    })
    return loadMoreBtn
  }

  // 新增：创建结果统计信息
  function createResultStats(displayCount: number, totalCount: number): HTMLDivElement {
    const statsDiv = document.createElement("div")
    statsDiv.classList.add("result-card", "result-stats")
    statsDiv.innerHTML = `
      <p style="text-align: center; color: var(--gray); margin: 0;">显示 ${displayCount}/${totalCount} 条结果</p>
    `
    return statsDiv
  }

  async function displayResults(finalResults: Item[]) {
    removeAllChildren(results)
    
    if (finalResults.length === 0) {
      results.innerHTML = `<a class="result-card no-match">
          <h3>No results.</h3>
          <p>Try another search term?</p>
      </a>`
    } else {
      // 显示统计信息
      const displayCount = Math.min(currentDisplayCount, finalResults.length)
      results.appendChild(createResultStats(displayCount, finalResults.length))
      
      // 显示结果
      const itemsToShow = finalResults.slice(0, currentDisplayCount)
      results.append(...itemsToShow.map(resultToHTML))
      
      // 如果还有更多结果，显示“加载更多”按钮
      if (currentDisplayCount < finalResults.length) {
        const remainingCount = finalResults.length - currentDisplayCount
        results.appendChild(createLoadMoreButton(remainingCount))
      }
    }

    if (finalResults.length === 0 && preview) {
      // no results, clear previous preview
      removeAllChildren(preview)
    } else {
      // focus on first result (skip stats div)
      const firstCard = results.querySelector(".result-card:not(.result-stats):not(.load-more-btn)") as HTMLElement
      if (firstCard) {
        firstCard.classList.add("focus")
        currentHover = firstCard as HTMLInputElement
        await displayPreview(firstCard)
      }
    }
  }

  async function fetchContent(slug: FullSlug): Promise<Element[]> {
    if (fetchContentCache.has(slug)) {
      return fetchContentCache.get(slug) as Element[]
    }

    const targetUrl = resolveUrl(slug).toString()
    const contents = await fetch(targetUrl)
      .then((res) => res.text())
      .then((contents) => {
        if (contents === undefined) {
          throw new Error(`Could not fetch ${targetUrl}`)
        }
        const html = p.parseFromString(contents ?? "", "text/html")
        normalizeRelativeURLs(html, targetUrl)
        return [...html.getElementsByClassName("popover-hint")]
      })

    fetchContentCache.set(slug, contents)
    return contents
  }

  async function displayPreview(el: HTMLElement | null) {
    if (!searchLayout || !enablePreview || !el || !preview) return
    if (el.classList.contains("result-stats") || el.classList.contains("load-more-btn")) return
    const slug = el.id as FullSlug
    
    // 解析当前搜索词，收集所有需要高亮的词
    const parsed = parseSearchQuery(currentSearchTerm)
    const highlightTerms: string[] = []
    
    if (parsed.text.trim()) {
      highlightTerms.push(parsed.text.trim())
    }
    if (parsed.tags.length > 0) {
      highlightTerms.push(...parsed.tags)
    }
    if (parsed.yamlQueries.length > 0) {
      parsed.yamlQueries.forEach(query => {
        if (query.key) highlightTerms.push(query.key)
        if (query.value) highlightTerms.push(query.value)
      })
    }
    
    const previewHighlightTerm = highlightTerms.join(' ')
    
    const innerDiv = await fetchContent(slug).then((contents) =>
      contents.flatMap((el) => [...highlightHTML(previewHighlightTerm, el as HTMLElement).children]),
    )
    previewInner = document.createElement("div")
    previewInner.classList.add("preview-inner")
    previewInner.append(...innerDiv)
    preview.replaceChildren(previewInner)

    // scroll to longest
    const highlights = [...preview.getElementsByClassName("highlight")].sort(
      (a, b) => b.innerHTML.length - a.innerHTML.length,
    )
    highlights[0]?.scrollIntoView({ block: "start" })
  }

  // 检查文档是否包含所有必需的搜索词/短语
  function matchesAllTerms(text: string, searchTerms: string[]): boolean {
    const lowerText = text.toLowerCase()
    return searchTerms.every(term => lowerText.includes(term.toLowerCase()))
  }

  // 将搜索词分解为必需的terms
  function extractRequiredTerms(searchTerm: string): string[] {
    // 按空格分割，得到独立的词或短语
    const parts = searchTerm.trim().split(/\s+/)
    return parts.filter(p => p.length > 0)
  }

  // 解析混合搜索：分离YAML搜索、标签搜索和普通文本
  // 示例："@author:张三 #AI 机器学习" → { yamlQueries: [{key:'author',value:'张三'}], tags: ['AI'], text: '机器学习' }
  function parseSearchQuery(searchTerm: string): {
    yamlQueries: Array<{ type: 'key-value' | 'value-only' | 'key-only', key?: string, value?: string }>,
    tags: string[],
    text: string
  } {
    const yamlQueries: Array<{ type: 'key-value' | 'value-only' | 'key-only', key?: string, value?: string }> = []
    const tags: string[] = []
    const textParts: string[] = []
    
    // 按空格分割
    const tokens = searchTerm.trim().split(/\s+/)
    
    for (const token of tokens) {
      if (token.startsWith('@')) {
        // YAML搜索
        const yamlTerm = token.substring(1)
        const colonIndex = yamlTerm.indexOf(':')
        
        if (colonIndex === -1) {
          // @key - 搜索包含该键的文档
          const key = yamlTerm.trim()
          if (key) yamlQueries.push({ type: 'key-only', key })
        } else {
          const key = yamlTerm.substring(0, colonIndex).trim()
          const value = yamlTerm.substring(colonIndex + 1).trim()
          
          if (!key && value) {
            // @:value - 搜索所有字段的值
            yamlQueries.push({ type: 'value-only', value })
          } else if (key && !value) {
            // @key: - 搜索包含该键的文档
            yamlQueries.push({ type: 'key-only', key })
          } else if (key && value) {
            // @key:value - 搜索指定键值对
            yamlQueries.push({ type: 'key-value', key, value })
          }
        }
      } else if (token.startsWith('#')) {
        // 标签搜索
        const tag = token.substring(1).trim()
        if (tag) tags.push(tag)
      } else {
        // 普通文本
        textParts.push(token)
      }
    }
    
    return {
      yamlQueries,
      tags,
      text: textParts.join(' ')
    }
  }

  // 模糊匹配 YAML 字段 - 支持三种模式
  function matchYamlField(doc: any, yamlSearch: { type: 'key-value' | 'value-only' | 'key-only', key?: string; value?: string }): boolean {
    if (!doc.frontmatter) return false
    
    // 遍历所有 frontmatter 字段
    for (const [key, value] of Object.entries(doc.frontmatter)) {
      // 跳过 title 和 tags，它们有专门的搜索方式
      if (key === 'title' || key === 'tags') continue
      
      const lowerKey = key.toLowerCase()
      
      if (yamlSearch.type === 'key-only') {
        // 模式1: @key 或 @key: - 只要文档包含该键即可
        const lowerSearchKey = yamlSearch.key!.toLowerCase()
        if (lowerKey.includes(lowerSearchKey)) {
          return true
        }
      } else if (yamlSearch.type === 'value-only') {
        // 模式2: @:value - 在所有字段值中搜索
        if (value === null || value === undefined) continue
        const valueStr = Array.isArray(value) 
          ? value.join(' ') 
          : String(value)
        const lowerSearchValue = yamlSearch.value!.toLowerCase()
        if (valueStr.toLowerCase().includes(lowerSearchValue)) {
          return true
        }
      } else if (yamlSearch.type === 'key-value') {
        // 模式3: @key:value - 键值都要匹配
        const lowerSearchKey = yamlSearch.key!.toLowerCase()
        const lowerSearchValue = yamlSearch.value!.toLowerCase()
        
        // 模糊匹配 key
        if (!lowerKey.includes(lowerSearchKey)) continue
        
        // 模糊匹配 value
        if (value === null || value === undefined) continue
        const valueStr = Array.isArray(value) 
          ? value.join(' ') 
          : String(value)
        
        if (valueStr.toLowerCase().includes(lowerSearchValue)) {
          return true
        }
      }
    }
    
    return false
  }
  
  // 检查文档是否匹配所有YAML查询条件
  function matchAllYamlQueries(doc: any, yamlQueries: Array<{ type: 'key-value' | 'value-only' | 'key-only', key?: string, value?: string }>): boolean {
    return yamlQueries.every(query => matchYamlField(doc, query))
  }

  async function onType(e: HTMLElementEventMap["input"]) {
    if (!searchLayout || !index) return
    currentSearchTerm = (e.target as HTMLInputElement).value
    searchLayout.classList.toggle("display-results", currentSearchTerm !== "")
      
    // 重置显示计数
    currentDisplayCount = initialDisplayCount
  
    // 解析搜索查询
    const parsed = parseSearchQuery(currentSearchTerm)
    const hasYaml = parsed.yamlQueries.length > 0
    const hasTags = parsed.tags.length > 0
    const hasText = parsed.text.trim().length > 0
      
    // 如果只有标签搜索，使用原有的tags搜索逻辑
    if (hasTags && !hasYaml && !hasText && parsed.tags.length === 1) {
      searchType = "tags"
      const tagTerm = parsed.tags[0]
      const searchResults = await index.searchAsync({
        query: tagTerm,
        limit: 10000,
        index: ["tags"],
      })
        
      const getByField = (field: string): number[] => {
        const results = searchResults.filter((x) => x.field === field)
        return results.length === 0 ? [] : ([...results[0].result] as number[])
      }
        
      const allIds: Set<number> = new Set([...getByField("tags")])
      const requiredTerms = extractRequiredTerms(tagTerm)
      const filteredIds = [...allIds].filter((id) => {
        const slug = idDataMap[id]
        const doc = data[slug]
        const combinedText = (doc.tags ?? []).join(" ")
        return matchesAllTerms(combinedText, requiredTerms)
      })
        
      allSearchResults = filteredIds.map((id) => formatForDisplay({ tags: [tagTerm] }, id))
      await displayResults(allSearchResults)
      return
    }
      
    // 混合搜索逻辑
    let candidateIds: Set<number> = new Set()
      
    // 第一步：如果有文本搜索，使用FlexSearch获取候选结果
    if (hasText) {
      searchType = "basic"
      const searchResults = await index.searchAsync({
        query: parsed.text,
        // 这里的limit可能需要根据实际情况调整
        limit: 10000,
        index: ["title", "content"],
      })
        
      const getByField = (field: string): number[] => {
        const results = searchResults.filter((x) => x.field === field)
        return results.length === 0 ? [] : ([...results[0].result] as number[])
      }
        
      candidateIds = new Set([
        ...getByField("title"),
        ...getByField("content"),
      ])
        
      // 过滤：确保包含所有必须词
      const requiredTerms = extractRequiredTerms(parsed.text)
      const filteredByText = [...candidateIds].filter((id) => {
        const slug = idDataMap[id]
        const doc = data[slug]
        const combinedText = `${doc.title ?? ""} ${doc.content ?? ""}`
        return matchesAllTerms(combinedText, requiredTerms)
      })
      candidateIds = new Set(filteredByText)
    } else {
      // 没有文本搜索，候选集为所有文档
      for (let i = 0; i < idDataMap.length; i++) {
        candidateIds.add(i)
      }
    }
      
    // 第二步：过滤YAML条件
    if (hasYaml) {
      searchType = hasText ? "basic" : "yaml"
      candidateIds = new Set([...candidateIds].filter((id) => {
        const slug = idDataMap[id]
        const doc = data[slug]
        return matchAllYamlQueries(doc, parsed.yamlQueries)
      }))
    }
      
    // 第三步：过滤标签条件
    if (hasTags) {
      candidateIds = new Set([...candidateIds].filter((id) => {
        const slug = idDataMap[id]
        const doc = data[slug]
        const docTags = (doc.tags ?? []).map((t: string) => t.toLowerCase())
        // 所有标签都必须匹配
        return parsed.tags.every(searchTag => 
          docTags.some((docTag: string) => docTag.includes(searchTag.toLowerCase()))
        )
      }))
    }
      
    // 显示结果
    const searchInfo = {
      text: hasText ? parsed.text : undefined,
      tags: hasTags ? parsed.tags : undefined,
      yamlQueries: hasYaml ? parsed.yamlQueries : undefined
    }
    allSearchResults = [...candidateIds].map((id) => formatForDisplay(searchInfo, id))
    await displayResults(allSearchResults)
  }

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => document.removeEventListener("keydown", shortcutHandler))
  searchButton.addEventListener("click", () => showSearch("basic"))
  window.addCleanup(() => searchButton.removeEventListener("click", () => showSearch("basic")))
  searchBar.addEventListener("input", onType)
  window.addCleanup(() => searchBar.removeEventListener("input", onType))

  registerEscapeHandler(container, hideSearch)
  await fillDocument(data)
}

/**
 * Fills flexsearch document with data
 * @param index index to fill
 * @param data data to fill index with
 */
let indexPopulated = false
async function fillDocument(data: ContentIndex) {
  if (indexPopulated) return
  let id = 0
  const promises: Array<Promise<unknown>> = []
  for (const [slug, fileData] of Object.entries<ContentDetails>(data)) {
    promises.push(
      index.addAsync(id++, {
        id,
        slug: slug as FullSlug,
        title: fileData.title,
        content: fileData.content,
        tags: fileData.tags,
        frontmatter: fileData.frontmatter,
      }),
    )
  }

  await Promise.all(promises)
  indexPopulated = true
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const currentSlug = e.detail.url
  const data = await fetchData
  const searchElement = document.getElementsByClassName("search")
  for (const element of searchElement) {
    await setupSearch(element, currentSlug, data)
  }
})

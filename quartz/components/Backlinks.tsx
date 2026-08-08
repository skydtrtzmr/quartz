import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/backlinks.scss"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"
import {
  SortConfig,
  applySortDefaults,
} from "../util/sort"
// @ts-ignore
import script from "./scripts/backlinks.inline"

import { AggregationConfig } from "../util/aggregation"

export interface BacklinksOptions {
  hideWhenEmpty: boolean
  threshold?: number
  aggregation?: AggregationConfig
  sort?: SortConfig
}

const defaultOptions: BacklinksOptions = {
  hideWhenEmpty: true,
  threshold: 20,
}

// ===== 运行时排序代码生成（序列化为自包含 JS 函数） =====

function generateBacklinksSortFnCode(config: SortConfig): string {
  const cfg = applySortDefaults(config)
  const multiplier = cfg.order === "asc" ? "1" : "-1"
  const { type, field = "title" } = cfg

  // 字符串值提取（运行时数据结构: { slug, title, frontmatter }）
  const getStringVal = (v: string) => {
    if (field === "title") return v + ".title"
    if (field === "slug") return v + ".slug"
    return `(((${v}.frontmatter && ${v}.frontmatter["${field}"]) !== undefined && ${v}.frontmatter["${field}"] !== null) ? String(${v}.frontmatter["${field}"]) : "")`
  }

  // 日期值提取
  const getDateVal = (v: string) => `(function(item) {
    var fm = item.frontmatter;
    var df = fm && fm["${field}"];
    if (df !== undefined && df !== null) {
      var dt = new Date(df);
      if (!isNaN(dt.getTime())) return dt;
    }
    return null;
  })(${v})`

  // 数值提取
  const getNumVal = (v: string) => `(function(item) {
    var fm = item.frontmatter;
    var raw = fm && fm["${field}"];
    if (raw !== undefined && raw !== null) {
      var n = Number(raw);
      if (!isNaN(n)) return n;
    }
    return 0;
  })(${v})`

  // tie-breaker: title natural asc
  const tieBreaker = 'a.title.localeCompare(b.title, undefined, {numeric: true, sensitivity: "base"})'

  let compareCode = ""
  switch (type) {
    case "date": {
      const da = getDateVal("a"), db = getDateVal("b")
      compareCode = `
        var da = ${da}, db = ${db};
        if (da === null && db === null) return ${tieBreaker};
        if (da === null) return 1;
        if (db === null) return -1;
        var r = (da.getTime() - db.getTime()) * ${multiplier};
        if (r !== 0) return r;
        return ${tieBreaker};`
      break
    }
    case "numeric": {
      const na = getNumVal("a"), nb = getNumVal("b")
      compareCode = `
        var na = ${na}, nb = ${nb};
        var r = (na - nb) * ${multiplier};
        if (r !== 0) return r;
        return ${tieBreaker};`
      break
    }
    case "natural":
      compareCode = `var r = ${getStringVal("a")}.localeCompare(${getStringVal("b")}, undefined, {numeric: true, sensitivity: "base"}) * ${multiplier}; if (r !== 0) return r; return ${tieBreaker};`
      break
    case "lexical":
      compareCode = `return ${getStringVal("a")}.localeCompare(${getStringVal("b")}) * ${multiplier};`
      break
  }

  return `(function(a, b) { ${compareCode} })`
}

// ===== 主组件 =====

export default ((opts?: Partial<BacklinksOptions>) => {
  const options: BacklinksOptions = { ...defaultOptions, ...opts }
  const threshold = options.threshold ?? 20
  const sortFnCode = options.sort ? generateBacklinksSortFnCode(options.sort) : ""

  const Backlinks: QuartzComponent = ({
    fileData,
    displayClass,
    cfg,
  }: QuartzComponentProps) => {
    // 从 cfg.baseUrl 获取 basePath (多域名支持，与 Graph 组件一致)
    const getBasePath = (baseUrl: string | undefined): string => {
      if (!baseUrl) return ""
      // 如果已经是完整 URL（含协议），直接解析提取 pathname
      if (baseUrl.includes("://")) {
        try {
          const url = new URL(baseUrl)
          return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "")
        } catch {
          return ""
        }
      }
      // 不含协议但含 /（如 "localhost/demo-core" 或 "127.0.0.1:8766/demo-core"），
      // 补全 https:// 后用 URL 解析提取 pathname
      if (baseUrl.includes("/")) {
        try {
          const url = new URL(`https://${baseUrl}`)
          return url.pathname === "/" ? "" : url.pathname.replace(/^\//, "")
        } catch {
          // 解析失败，fall through
        }
      }
      // 否则作为纯路径返回（去掉开头和结尾的 /）
      return baseUrl.replace(/^\//, "").replace(/\/$/, "")
    }
    const basePath = getBasePath(cfg.baseUrl)
    return (
      <div class={classNames(displayClass, "backlinks", "backlinks-loading")}>
        <h3>{i18n(cfg.locale).components.backlinks.title}</h3>
        <ul
          class="backlinks-list"
          data-current-slug={fileData.slug}
          data-threshold={threshold}
          data-aggregation={JSON.stringify(options.aggregation ?? [])}
          data-basepath={basePath}
          data-hide-empty={options.hideWhenEmpty ? "true" : "false"}
          data-sort-fn={sortFnCode}
        >
          <li class="backlinks-loading-placeholder">
            <span class="loading-text">正在加载反向链接...</span>
          </li>
        </ul>
      </div>
    )
  }

  Backlinks.css = style

  // 组合脚本：原有交互 + 运行时加载
  Backlinks.afterDOMLoaded = `
    ${script.toString()}
    ;(async function() {
      function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      }
      
      function resolveRelativeHref(current, target) {
        const currentParts = current.split('/')
        const depth = currentParts.length - 1
        return '../'.repeat(depth) + target + '.html'
      }
      
      // 按 granularity 格式化日期
      function formatDateByGranularity(value, granularity) {
        if (!granularity) return value
        let date = null
        if (typeof value === 'string' || typeof value === 'number') {
          date = new Date(value)
        }
        if (!date || isNaN(date.getTime())) return value
        const y = date.getFullYear()
        const m = date.getMonth() + 1
        switch (granularity) {
          case 'year': return y + '年'
          case 'month': return y + '年' + m + '月'
          case 'quarter': return y + '-Q' + Math.ceil(m / 3)
          default: return value
        }
      }
      
      async function initRuntimeBacklinks() {
        const list = document.querySelector('.backlinks-list[data-current-slug]')
        if (!list) return
        
        const currentSlug = list.dataset.currentSlug
        const threshold = parseInt(list.dataset.threshold || "20")
        const rules = JSON.parse(list.dataset.aggregation || "[]")
        const basePath = list.dataset.basepath || ""
        const hideWhenEmpty = list.dataset.hideEmpty !== "false"
        const sortFn = list.dataset.sortFn ? new Function('return ' + list.dataset.sortFn)() : null
        
        try {
          // 使用共享 Promise 缓存获取 local graph 数据（与 graph2.inline.ts 共用）
          //
          // 关键点：通过 window.__localGraphCache.fetch() 使用 graph2.inline.ts 中定义的
          // Promise 缓存。无论 graph2（局部图谱）还是 Backlinks（反向链接）先调用，
          // 都会共享同一个 Promise，确保 local graph JSON 只 fetch 一次。
          // 详见 graph2.inline.ts 的 "Local Graph 缓存模块" 注释。
          //
          const graphData = await window.__localGraphCache.fetch(currentSlug, basePath)
          if (!graphData) throw new Error('Failed to load local graph')
          
          // 提取反向链接
          const backlinks = []
          for (const edge of graphData.edges) {
            if (edge.target === currentSlug) {
              const node = graphData.nodes[edge.source]
              if (node) {
                backlinks.push({
                  slug: node.slug,
                  title: node.title || node.slug,
                  filePath: node.filePath || '',
                  tags: node.tags || [],
                  frontmatter: node.frontmatter || {}
                })
              }
            }
          }
          
          if (backlinks.length === 0) {
            if (hideWhenEmpty) {
              var container = list.closest('.backlinks')
              if (container) container.style.display = 'none'
            } else {
              list.innerHTML = '<li class="backlinks-empty">暂无反向链接</li>'
            }
            return
          }
          
          // 清空加载占位符
          list.innerHTML = ''
          
          // 排序（使用可配置排序或 slug 默认排序）
          if (sortFn) {
            backlinks.sort(sortFn)
          } else {
            backlinks.sort((a, b) => a.slug.localeCompare(b.slug))
          }
          
          // 构建树
          const root = buildTree(backlinks, rules, sortFn)
          renderTree(list, root, currentSlug, threshold)
          
        } catch (err) {
          console.error('[Backlinks Runtime] Error:', err)
          const placeholder = list.querySelector('.backlinks-loading-placeholder')
          if (placeholder) {
            placeholder.innerHTML = '<span class="error-text">加载反向链接失败</span>'
            placeholder.classList.remove('backlinks-loading-placeholder')
          }
        }
      }
      
      function buildTree(items, rules, sortFn) {
        const root = { key: '/', fullPath: '', items: [], children: [], isFieldGroup: false }
        
        if (!rules || rules.length === 0) {
          root.items = items
          if (sortFn) root.items.sort(sortFn)
          return root
        }
        
        applyAggregationRecursive(root, items, rules, 0, sortFn)
        return root
      }
      
      // 递归应用聚合规则
      function applyAggregationRecursive(parentNode, items, sortedRules, ruleIndex, sortFn) {
        if (ruleIndex >= sortedRules.length) {
          parentNode.items = items
          if (sortFn) parentNode.items.sort(sortFn)
          return
        }
        
        const rule = sortedRules[ruleIndex]
        
        // 检查规则是否有效（是否至少有一个 item 能提取出有效键）
        let hasValid = false
        for (const item of items) {
          const key = extractGroupKeyRuntime(item, rule)
          if (key !== null) {
            hasValid = true
            break
          }
        }
        
        // 全部无效则跳过此级，尝试下一规则
        if (!hasValid) {
          applyAggregationRecursive(parentNode, items, sortedRules, ruleIndex + 1, sortFn)
          return
        }
        
        // 执行分组
        const groups = new Map()
        for (const item of items) {
          const key = extractGroupKeyRuntime(item, rule) ?? '(无)'
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key).push(item)
        }
        
        const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
          if (a === '(无)') return 1
          if (b === '(无)') return -1
          return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
        })
        
        for (const groupKey of sortedKeys) {
          const groupItems = groups.get(groupKey)
          const isField = rule.type === 'field' || rule.type === 'date'
          const childNode = {
            key: groupKey,
            fullPath: rule.type === 'folder' ? (groupKey === '/' ? '' : groupKey) : '',
            items: [],
            children: [],
            isFieldGroup: isField,
            fieldName: isField ? (rule.field || rule.type) : undefined
          }
          applyAggregationRecursive(childNode, groupItems, sortedRules, ruleIndex + 1, sortFn)
          parentNode.children.push(childNode)
        }
      }
      
      // 运行时提取分组键（与 util/aggregation.ts 逻辑保持一致）
      function extractGroupKeyRuntime(item, rule) {
        switch (rule.type) {
          case 'folder': {
            const parts = (item.slug ?? '').split('/')
            if (parts.length <= 1) return '/'
            const depth = rule.depth ?? 1
            const folderParts = depth > 1 
              ? parts.slice(0, Math.min(depth, parts.length - 1)) 
              : [parts[0]]
            return folderParts.join('/')
          }
          case 'field': {
            const field = rule.field || ''
            const raw = item.frontmatter?.[field]
            if (raw === undefined || raw === null) return null
            if (Array.isArray(raw)) {
              const first = raw.find(v => v !== undefined && v !== null)
              return first !== undefined ? String(first) : null
            }
            return String(raw)
          }
          case 'date': {
            const field = rule.field || 'date'
            let raw = item.frontmatter?.[field]
            if ((raw === undefined || raw === null) && field !== 'date') {
              raw = item.frontmatter?.['date']
            }
            if (raw === undefined || raw === null) return null
            return formatDateByGranularity(raw, rule.granularity)
          }
          default:
            return null
        }
      }
      
      function getTotal(node) {
        return node.items.length + node.children.reduce((s, c) => s + getTotal(c), 0)
      }
      
      function renderTree(container, node, currentSlug, threshold, level = 0) {
        const paddingLeft = (0.35 + level * 0.5) + 'rem'
        
        // 渲染 items
        if (node.items.length > 0) {
          for (const item of node.items) {
            const li = document.createElement('li')
            li.className = level === 0 ? 'backlink-root-item' : 'backlink-child-item'
            li.innerHTML = '<a href="' + resolveRelativeHref(currentSlug, item.slug) + '" class="internal">' + escapeHtml(item.title) + '</a>'
            container.appendChild(li)
          }
        }
        
        // 渲染子分组
        for (const child of node.children) {
          const totalCount = getTotal(child)
          const segKey = child.isFieldGroup && child.fieldName 
            ? (child.fieldName + ': ' + child.key)
            : child.key
          
          const li = document.createElement('li')
          li.className = 'backlink-group' + (level > 0 ? ' nested' : '')
          
          li.innerHTML = 
            '<button type="button" class="group-header" style="padding-left: ' + paddingLeft + '">' +
              '<span class="group-arrow"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></span>' +
              '<span class="group-title">' + escapeHtml(segKey) + '</span>' +
              '<span class="group-count">(' + totalCount + ')</span>' +
            '</button>' +
            '<div class="group-content">' +
              '<ul class="group-list"></ul>' +
            '</div>'
          
          container.appendChild(li)
          
          // 递归渲染子节点
          const groupContent = li.querySelector('.group-list')
          renderTree(groupContent, child, currentSlug, threshold, level + 1)
        }
      }
      
      // 页面加载后初始化
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(initRuntimeBacklinks, 100))
      } else {
        setTimeout(initRuntimeBacklinks, 100)
      }
      
      // SPA 导航：监听 Quartz 的 nav 事件（与 graph2.inline.ts 一致）
      document.addEventListener('nav', (e) => {
        setTimeout(initRuntimeBacklinks, 100)
      })
    })()
  `

  return Backlinks
}) satisfies QuartzComponentConstructor

import micromorph from "micromorph"
import { FullSlug, RelativeURL, getFullSlug, normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

// ============ 首屏加载守护 ============
// 使用捕获阶段拦截，确保在所有其他事件处理之前

// 创建预置的 toast 元素（避免每次动态创建影响性能）
const initToast = document.createElement("div")
initToast.id = "init-lock-toast"
initToast.innerText = "系统初始化中，请稍候..."
initToast.style.cssText = `
  position: fixed;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: var(--secondary);
  color: var(--light);
  padding: 10px 20px;
  border-radius: 8px;
  z-index: 9999;
  font-size: 0.9em;
  font-weight: bold;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  pointer-events: none;
  transition: opacity 0.3s ease, transform 0.3s ease;
  opacity: 0;
  visibility: hidden;
`
document.body.appendChild(initToast)

// 显示/隐藏 toast（用 CSS 类切换，避免重复操作 DOM）
let toastTimeout: ReturnType<typeof setTimeout> | null = null
function showInitToast() {
  if (toastTimeout) clearTimeout(toastTimeout)
  initToast.style.visibility = "visible"
  initToast.style.opacity = "1"
  initToast.style.transform = "translateX(-50%) translateY(0)"

  // 1.5秒后自动淡出
  toastTimeout = setTimeout(() => {
    initToast.style.opacity = "0"
    initToast.style.transform = "translateX(-50%) translateY(20px)"
    setTimeout(() => {
      initToast.style.visibility = "hidden"
    }, 300)
  }, 1500)
}

// 捕获阶段拦截所有 click 事件
window.addEventListener(
  "click",
  (e: MouseEvent) => {
    // 如果首屏已加载完成，不做任何处理
    if ((window as any).__firstScreenLoaded) return

    // 检查是否是内部链接
    const target = e.target as HTMLElement
    if (target) {
      const anchor = target.closest("a")
      if (anchor && anchor.href) {
        try {
          const url = new URL(anchor.href)
          if (url.origin === window.location.origin) {
            // 这是一个内部链接，在初始化完成前禁止跳转
            e.preventDefault()
            e.stopImmediatePropagation()
            console.warn("[Guard] 导航被阻止，首屏正在加载...")
            showInitToast()
          }
        } catch {
          // URL 解析失败，忽略
        }
      }
    }
  },
  { capture: true } // 捕获阶段，在所有其他事件处理之前执行
)

// adapted from `micromorph`
// https://github.com/natemoo-re/micromorph
const NODE_TYPE_ELEMENT = 1
let announcer = document.createElement("route-announcer")
const isElement = (target: EventTarget | null): target is Element =>
  (target as Node)?.nodeType === NODE_TYPE_ELEMENT
const isLocalUrl = (href: string) => {
  try {
    const url = new URL(href)
    if (window.location.origin === url.origin) {
      return true
    }
  } catch (e) { }
  return false
}

const isSamePage = (url: URL): boolean => {
  const sameOrigin = url.origin === window.location.origin
  const samePath = url.pathname === window.location.pathname
  return sameOrigin && samePath
}

const getOpts = ({ target }: Event): { url: URL; scroll?: boolean } | undefined => {
  if (!isElement(target)) return
  if (target.attributes.getNamedItem("target")?.value === "_blank") return
  const a = target.closest("a")
  if (!a) return
  if ("routerIgnore" in a.dataset) return
  const { href } = a
  if (!isLocalUrl(href)) return
  return { url: new URL(href), scroll: "routerNoscroll" in a.dataset ? false : undefined }
}

function notifyNav(url: FullSlug) {
  const event: CustomEventMap["nav"] = new CustomEvent("nav", { detail: { url } })
  document.dispatchEvent(event)
}

const cleanupFns: Set<(...args: any[]) => void> = new Set()
window.addCleanup = (fn) => cleanupFns.add(fn)

function startLoading() {
  const loadingBar = document.createElement("div")
  loadingBar.className = "navigation-progress"
  loadingBar.style.width = "0"
  if (!document.body.contains(loadingBar)) {
    document.body.appendChild(loadingBar)
  }

  setTimeout(() => {
    loadingBar.style.width = "80%"
  }, 100)
}

let isNavigating = false
let p: DOMParser
async function _navigate(url: URL, isBack: boolean = false) {
  isNavigating = true
  startLoading()
  p = p || new DOMParser()
  const contents = await fetchCanonical(url)
    .then((res) => {
      const contentType = res.headers.get("content-type")
      if (contentType?.startsWith("text/html")) {
        return res.text()
      } else {
        window.location.assign(url)
      }
    })
    .catch(() => {
      window.location.assign(url)
    })

  if (!contents) return

  // notify about to nav
  const event: CustomEventMap["prenav"] = new CustomEvent("prenav", { detail: {} })
  document.dispatchEvent(event)

  // cleanup old
  cleanupFns.forEach((fn) => fn())
  cleanupFns.clear()

  const html = p.parseFromString(contents, "text/html")
  normalizeRelativeURLs(html, url)

  let title = html.querySelector("title")?.textContent
  if (title) {
    document.title = title
  } else {
    const h1 = document.querySelector("h1")
    title = h1?.innerText ?? h1?.textContent ?? url.pathname
  }
  if (announcer.textContent !== title) {
    announcer.textContent = title
  }
  announcer.dataset.persist = ""
  html.body.appendChild(announcer)

  // morph body
  micromorph(document.body, html.body)

  // scroll into place and add history
  if (!isBack) {
    if (url.hash) {
      const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
      el?.scrollIntoView()
    } else {
      window.scrollTo({ top: 0 })
    }
  }

  // now, patch head, re-executing scripts
  const elementsToRemove = document.head.querySelectorAll(":not([data-persist])")
  elementsToRemove.forEach((el) => el.remove())
  const elementsToAdd = html.head.querySelectorAll(":not([data-persist])")
  elementsToAdd.forEach((el) => document.head.appendChild(el))

  // delay setting the url until now
  // at this point everything is loaded so changing the url should resolve to the correct addresses
  if (!isBack) {
    history.pushState({}, "", url)
  }

  notifyNav(getFullSlug(window))
  delete announcer.dataset.persist
}

async function navigate(url: URL, isBack: boolean = false) {
  if (isNavigating) return
  isNavigating = true
  try {
    await _navigate(url, isBack)
  } catch (e) {
    console.error(e)
    window.location.assign(url)
  } finally {
    isNavigating = false
  }
}

window.spaNavigate = navigate

function createRouter() {
  if (typeof window !== "undefined") {
    window.addEventListener("click", async (event) => {
      const { url } = getOpts(event) ?? {}
      // dont hijack behaviour, just let browser act normally
      if (!url || event.ctrlKey || event.metaKey) return
      event.preventDefault()

      if (isSamePage(url) && url.hash) {
        const el = document.getElementById(decodeURIComponent(url.hash.substring(1)))
        el?.scrollIntoView()
        history.pushState({}, "", url)
        return
      }

      navigate(url, false)
    })

    window.addEventListener("popstate", (event) => {
      const { url } = getOpts(event) ?? {}
      if (window.location.hash && window.location.pathname === url?.pathname) return
      navigate(new URL(window.location.toString()), true)
      return
    })
  }

  return new (class Router {
    go(pathname: RelativeURL) {
      const url = new URL(pathname, window.location.toString())
      return navigate(url, false)
    }

    back() {
      return window.history.back()
    }

    forward() {
      return window.history.forward()
    }
  })()
}

createRouter()
notifyNav(getFullSlug(window))

if (!customElements.get("route-announcer")) {
  const attrs = {
    "aria-live": "assertive",
    "aria-atomic": "true",
    style:
      "position: absolute; left: 0; top: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap; width: 1px; height: 1px",
  }

  customElements.define(
    "route-announcer",
    class RouteAnnouncer extends HTMLElement {
      constructor() {
        super()
      }
      connectedCallback() {
        for (const [key, value] of Object.entries(attrs)) {
          this.setAttribute(key, value)
        }
      }
    },
  )
}

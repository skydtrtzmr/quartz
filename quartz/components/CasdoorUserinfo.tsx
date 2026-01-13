import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const CasdoorUserinfo: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div id="casdoor-userinfo" class={classNames(displayClass, "casdoor-userinfo")}>
      <span id="username-display">载入中...</span>
    </div>
  )
}

// 客户端脚本：负责读取 Cookie 并显示用户名
CasdoorUserinfo.afterDOMLoaded = `
(function() {
  const getCookie = (name) => {
    const value = "; " + document.cookie;
    const parts = value.split("; " + name + "=");
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(";").shift());
    return null;
  }

  const updateUsername = () => {
    // 使用 querySelectorAll 确保能抓取到所有（包括新页面中）的显示元素
    // ID 在 SPA 多次跳转中可能会因为 Morphing 逻辑出现短暂的重复或查询延迟
    const displayElements = document.querySelectorAll("#username-display");
    const user = getCookie("quartz_username");
    
    if (displayElements.length > 0) {
      displayElements.forEach(el => {
        el.innerText = user ? "👤 " + user : "未登录";
      });
    }
  };

  // 1. 立即执行一次（处理浏览器首次打开页面）
  updateUsername();

  // 2. 绑定 Quartz SPA 的导航事件
  // 关键：使用 window 标志位防止在 SPA 跳转时重复注册监听器
  if (!window.casdoorUserinfoInitialized) {
    window.casdoorUserinfoInitialized = true;
    
    // 监听 nav 事件。在 Quartz 4 中，'nav' 会在内容替换完成后触发
    // 我们使用 setTimeout(..., 0) 将其推入宏任务队列
    // 确保在 Quartz 完成所有 DOM 渲染和补丁（Patch）后再执行更新逻辑
    document.addEventListener("nav", () => {
      setTimeout(updateUsername, 0);
    });
  }
})();
`

export default (() => CasdoorUserinfo) satisfies QuartzComponentConstructor
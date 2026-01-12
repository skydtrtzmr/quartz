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
  const updateUsername = () => {
    const getCookie = (name) => {
      const value = "; " + document.cookie;
      const parts = value.split("; " + name + "=");
      if (parts.length === 2) return decodeURIComponent(parts.pop().split(";").shift());
      return null;
    }

    const display = document.getElementById("username-display");
    if (!display) return;

    const user = getCookie("quartz_username");
    // 如果还没拿到，设个定时器重试一次（处理写入延迟）
    if (!user && !window.hasRetried) {
      window.hasRetried = true;
      setTimeout(updateUsername, 300); 
      return;
    }

    display.innerText = user ? "👤 " + user : "未登录";
  };

  updateUsername();
  // 核心：监听 Quartz 的内部导航事件，确保切换页面时也会刷新用户名
  document.addEventListener("navigated", updateUsername);
})();
`

export default (() => CasdoorUserinfo) satisfies QuartzComponentConstructor
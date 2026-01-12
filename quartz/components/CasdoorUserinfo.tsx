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
const getCookie = (name) => {
  const value = "; " + document.cookie;
  const parts = value.split("; " + name + "=");
  if (parts.length === 2) return decodeURIComponent(parts.pop().split(";").shift());
  return null;
}

const username = getCookie("quartz_username");
const display = document.getElementById("username-display");
if (display) {
  display.innerText = username ? "👤 " + username : "未登录";
}
`

export default (() => CasdoorUserinfo) satisfies QuartzComponentConstructor
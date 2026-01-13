import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
// @ts-ignore
import casdooruserinfoScript from "./scripts/casdooruserinfo.inline"

const CasdoorUserinfo: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <div id="casdoor-userinfo" class={classNames(displayClass, "casdoor-userinfo")}>
      <span id="username-display">载入中...</span>
    </div>
  )
}

// 客户端脚本：负责读取 Cookie 并显示用户名
CasdoorUserinfo.afterDOMLoaded = casdooruserinfoScript

export default (() => CasdoorUserinfo) satisfies QuartzComponentConstructor
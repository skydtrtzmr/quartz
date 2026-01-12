import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const CasdoorLogout: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  return (
    <a 
      href="/logout" 
      class={classNames(displayClass, "casdoor-logout")}
      style={{
        marginLeft: "10px",
        fontSize: "0.8rem",
        color: "var(--secondary)",
        textDecoration: "none",
        border: "1px solid var(--gray)",
        padding: "2px 8px",
        borderRadius: "4px"
      }}
    >
      退出
    </a>
  )
}

export default (() => CasdoorLogout) satisfies QuartzComponentConstructor
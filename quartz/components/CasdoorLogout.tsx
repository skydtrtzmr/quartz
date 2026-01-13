import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

const CasdoorLogout: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
  // 处理退出点击事件
  const handleLogout = async (e: preact.TargetedMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    try {

      // 2. 告诉 Casdoor 服务端：销毁 SSO 会话
      // 使用 POST 方式，且必须带 credentials 以包含 8000 端口的 Cookie
      await fetch("http://127.0.0.1:8000/api/logout", {
        method: "POST",
        mode: "no-cors", // 跨域注销通常不需要读取响应，使用 no-cors 避开复杂的 CORS 检查
        credentials: "include" 
      });
      
      // 1. 告诉 Go 服务端：清理本地 Cookie
      await fetch("/logout", { method: "GET" });

      // 3. 注销完成后，重定向到首页，此时首页会拦截并跳往登录页
      window.location.href = "/";
    } catch (err) {
      console.error("Logout failed:", err);
      // 兜底方案：万一脚本报错，强制走一次传统的后端注销
      // window.location.href = "/logout";
    }
  };

  return (
    <a 
      href="/logout" 
      onClick={handleLogout}
      className={classNames(displayClass, "casdoor-logout")}
      style={{
        marginLeft: "10px",
        fontSize: "0.8rem",
        color: "var(--secondary)",
        textDecoration: "none",
        border: "1px solid var(--gray)",
        padding: "2px 8px",
        borderRadius: "4px",
        cursor: "pointer"
      }}
    >
      退出
    </a>
  )
}

export default (() => CasdoorLogout) satisfies QuartzComponentConstructor
import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { userDisplayName, userInitial } from "@/lib/user-display";
import { Brand, ShellFrame } from "./shell-frame";

export const MAIN_NAV_ITEMS = [
  { href: "/", icon: "⌁", label: "产品总览" },
  { href: "/organizations", icon: "◈", label: "我的工作区" },
  { href: "/admin/feedback", icon: "◌", label: "反馈管理" },
  { href: "/admin/pay", icon: "¥", label: "支付管理" },
  { href: "/admin/costs", icon: "≈", label: "成本观测" },
  { href: "/integrations", icon: "⌘", label: "代码仓库" },
  { href: "/mcp", icon: "⌗", label: "MCP" },
  { href: "/settings", icon: "⚙", label: "设置" },
  { href: "/pricing", icon: "◇", label: "套餐与定价" },
];

export function AppShell({ user, organizationName, activeHref = "/", children }: { user: SessionUser; organizationName?: string; activeHref?: string; children: React.ReactNode }) {
  return (
    <ShellFrame
      sidebar={
        <>
          <Brand />
          <nav className="main-nav" aria-label="主导航">
            {MAIN_NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href} className={`nav-item${activeHref === item.href ? " active" : ""}`}><span>{item.icon}</span>{item.label}</Link>
            ))}
            <a href="https://app.chandler.work" className="nav-item" target="_blank" rel="noreferrer"><span>↗</span>Chandler</a>
          </nav>
          <div className="sidebar-note">CODE → CONTEXT<br />让每一次发布都有据可查</div>
        </>
      }
      topbar={
        <>
          <span className="environment"><i />{organizationName ?? "工作区"}</span>
          <div className="user-menu">
            <span className="avatar">{userInitial(user)}</span>
            <span className="user-name">{userDisplayName(user)}</span>
            <form action="/auth/logout" method="post"><button className="text-button" type="submit">退出</button></form>
          </div>
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}

import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { userDisplayName, userInitial } from "@/lib/user-display";
import { Brand, ShellFrame } from "./shell-frame";

export function AppShell({ user, organizationName, children }: { user: SessionUser; organizationName?: string; children: React.ReactNode }) {
  return (
    <ShellFrame
      sidebar={
        <>
          <Brand />
          <nav className="main-nav" aria-label="主导航">
            <Link href="/" className="nav-item active"><span>⌁</span>产品总览</Link>
            <Link href="/organizations" className="nav-item"><span>◈</span>我的工作区</Link>
            <Link href="/admin/feedback" className="nav-item"><span>◌</span>反馈管理</Link>
            <Link href="/admin/pay" className="nav-item"><span>¥</span>支付管理</Link>
            <Link href="/integrations" className="nav-item"><span>⌘</span>代码仓库</Link>
            <Link href="/settings" className="nav-item"><span>⚙</span>设置</Link>
            <Link href="/pricing" className="nav-item"><span>◇</span>套餐与定价</Link>
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

import Link from "next/link";
import type { ReactNode } from "react";

/** AppShell 与 DemoShell 共用的页面外壳：侧栏 + 顶栏 + 主内容区。 */
export function ShellFrame({ sidebar, topbar, children }: { sidebar: ReactNode; topbar: ReactNode; children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">{sidebar}</aside>
      <div className="workspace">
        <header className="topbar">{topbar}</header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Radar 首页">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span><strong>Radar</strong><small>产品变化雷达</small></span>
    </Link>
  );
}

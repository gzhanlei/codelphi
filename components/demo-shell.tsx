import Link from "next/link";
import type { ReactNode } from "react";
import { DemoModeProvider } from "./demo-mode";

export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <DemoModeProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <Link href="/" className="brand" aria-label="Radar 首页">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>Radar</strong><small>产品变化雷达</small></span>
          </Link>
          <div className="sidebar-note">DEMO MODE<br />只读演示，编辑不可保存</div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span className="environment"><i />演示模式</span>
            <div className="user-menu">
              <a href="https://github.com/gzhanlei/radar" className="text-button" target="_blank" rel="noreferrer">GitHub</a>
              <Link href="/login" className="text-button">使用 Chandler 登录</Link>
            </div>
          </header>
          <main className="main-content">{children}</main>
        </div>
      </div>
    </DemoModeProvider>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { DemoModeProvider } from "./demo-mode";
import { Brand, ShellFrame } from "./shell-frame";

export function DemoShell({ children }: { children: ReactNode }) {
  return (
    <DemoModeProvider>
      <ShellFrame
        sidebar={
          <>
            <Brand />
            <div className="sidebar-note">DEMO MODE<br />只读演示，编辑不可保存</div>
          </>
        }
        topbar={
          <>
            <span className="environment"><i />演示模式</span>
            <div className="user-menu">
              <a href="https://github.com/gzhanlei/radar" className="text-button" target="_blank" rel="noreferrer">GitHub</a>
              <Link href="/login" className="text-button">使用 Chandler 登录</Link>
            </div>
          </>
        }
      >
        {children}
      </ShellFrame>
    </DemoModeProvider>
  );
}

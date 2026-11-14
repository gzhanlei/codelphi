import Link from "next/link";
import type { ReactNode } from "react";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { BRAND_TAGLINE } from "@/lib/ui-strings";

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

export function Brand({ locale = "zh-CN" }: { locale?: UiLocale }) {
  return (
    <Link href="/" className="brand" aria-label={locale === "en" ? "CoDelphi home" : "CoDelphi 首页"}>
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <span><strong>CoDelphi</strong><small>{pick(locale, BRAND_TAGLINE)}</small></span>
    </Link>
  );
}

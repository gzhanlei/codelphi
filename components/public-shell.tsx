import Link from "next/link";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { COMMON_LABELS, NAV_LABELS, SIDEBAR_NOTE } from "@/lib/ui-strings";
import { LanguageSwitcher } from "./language-switcher";
import { Brand, ShellFrame } from "./shell-frame";

const PUBLIC_NAV_ITEMS = [
  { href: "/", icon: "⌁", labelKey: "overview" },
  { href: "/pricing", icon: "◇", labelKey: "pricing" },
  { href: "/mcp", icon: "⌗", labelKey: "mcp" },
  { href: "/terms", icon: "§", labelKey: "terms" },
  { href: "/data-notice", icon: "◌", labelKey: "dataNotice" },
] as const;

/** 公开页外壳（未登录可见的页面复用 AppShell 布局）：侧栏品牌 + 公开导航 + 顶栏登录入口。 */
export async function PublicShell({ activeHref, children }: { activeHref?: string; children: React.ReactNode }) {
  const locale = await resolveUiLocale();
  return (
    <ShellFrame
      sidebar={
        <>
          <Brand locale={locale} />
          <nav className="main-nav" aria-label={pick(locale, COMMON_LABELS.siteNavAria)}>
            {PUBLIC_NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href} className={`nav-item${activeHref === item.href ? " active" : ""}`}><span>{item.icon}</span>{pick(locale, NAV_LABELS[item.labelKey])}</Link>
            ))}
          </nav>
          <div className="sidebar-note">CODE → CONTEXT<br />{pick(locale, SIDEBAR_NOTE).split("\n")[1]}</div>
        </>
      }
      topbar={
        <>
          <span className="environment"><i />CoDelphi</span>
          <div className="user-menu">
            <LanguageSwitcher locale={locale} />
            <Link href="/login" className="text-button">{pick(locale, COMMON_LABELS.login)}</Link>
          </div>
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}

import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { userDisplayName, userInitial } from "@/lib/user-display";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { COMMON_LABELS, NAV_LABELS, SIDEBAR_NOTE } from "@/lib/ui-strings";
import { LanguageSwitcher } from "./language-switcher";
import { Brand, ShellFrame } from "./shell-frame";

export const MAIN_NAV_ITEMS = [
  { href: "/", icon: "⌁", labelKey: "overview" },
  { href: "/organizations", icon: "◈", labelKey: "organizations" },
  { href: "/admin/feedback", icon: "◌", labelKey: "adminFeedback" },
  { href: "/admin/pay", icon: "¥", labelKey: "adminPay" },
  { href: "/admin/costs", icon: "≈", labelKey: "adminCosts" },
  { href: "/integrations", icon: "⌘", labelKey: "integrations" },
  { href: "/mcp", icon: "⌗", labelKey: "mcp" },
  { href: "/settings", icon: "⚙", labelKey: "settings" },
  { href: "/pricing", icon: "◇", labelKey: "pricing" },
] as const;

export async function AppShell({ user, organizationName, activeHref = "/", children }: { user: SessionUser; organizationName?: string; activeHref?: string; children: React.ReactNode }) {
  const locale = await resolveUiLocale();
  return (
    <ShellFrame
      sidebar={
        <>
          <Brand locale={locale} />
          <nav className="main-nav" aria-label={pick(locale, COMMON_LABELS.mainNavAria)}>
            {MAIN_NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href} className={`nav-item${activeHref === item.href ? " active" : ""}`}><span>{item.icon}</span>{pick(locale, NAV_LABELS[item.labelKey])}</Link>
            ))}
            <a href="https://app.chandler.work" className="nav-item" target="_blank" rel="noreferrer"><span>↗</span>{pick(locale, NAV_LABELS.chandler)}</a>
          </nav>
          <div className="sidebar-note">CODE → CONTEXT<br />{pick(locale, SIDEBAR_NOTE).split("\n")[1]}</div>
        </>
      }
      topbar={
        <>
          <span className="environment"><i />{organizationName ?? pick(locale, COMMON_LABELS.workspaceFallback)}</span>
          <div className="user-menu">
            <LanguageSwitcher locale={locale} />
            <span className="avatar">{userInitial(user)}</span>
            <span className="user-name">{userDisplayName(user)}</span>
            <form action="/auth/logout" method="post"><button className="text-button" type="submit">{pick(locale, COMMON_LABELS.logout)}</button></form>
          </div>
        </>
      }
    >
      {children}
    </ShellFrame>
  );
}

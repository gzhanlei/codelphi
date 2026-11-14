import Link from "next/link";
import type { ReactNode } from "react";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { COMMON_LABELS } from "@/lib/ui-strings";
import { DemoModeProvider } from "./demo-mode";
import { LanguageSwitcher } from "./language-switcher";
import { Brand, ShellFrame } from "./shell-frame";

export async function DemoShell({ children }: { children: ReactNode }) {
  const locale = await resolveUiLocale();
  return (
    <DemoModeProvider>
      <ShellFrame
        sidebar={
          <>
            <Brand locale={locale} />
            <div className="sidebar-note">DEMO MODE<br />{pick(locale, COMMON_LABELS.demoNote)}</div>
          </>
        }
        topbar={
          <>
            <span className="environment"><i />{pick(locale, COMMON_LABELS.demoBadge)}</span>
            <div className="user-menu">
              <LanguageSwitcher locale={locale} />
              <a href="https://github.com/gzhanlei/codelphi" className="text-button" target="_blank" rel="noreferrer">GitHub</a>
              <Link href="/login" className="text-button">{pick(locale, COMMON_LABELS.chandlerSignIn)}</Link>
            </div>
          </>
        }
      >
        {children}
      </ShellFrame>
    </DemoModeProvider>
  );
}

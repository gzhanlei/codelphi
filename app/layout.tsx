import type { Metadata } from "next";
import { IcpFooter } from "@/components/icp-footer";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveUiLocale();
  return {
    title: { default: "CoDelphi", template: "%s · CoDelphi" },
    description: pick(locale, {
      "zh-CN": "把 GitHub 代码变更翻译成带证据的发布说明与回归范围，采纳前经人工核实",
      en: "Translate GitHub code changes into evidence-backed release notes and regression scopes, signed off by human review",
    }),
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await resolveUiLocale();
  return (
    <html lang={locale}>
      <body>
        {children}
        <IcpFooter />
      </body>
    </html>
  );
}

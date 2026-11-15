import Link from "next/link";
import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { PublicShell } from "@/components/public-shell";
import { PricingPanel } from "@/components/pricing-panel";
import { getSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { pick } from "@/lib/ui-locale";
import { PRICING_PAGE } from "@/lib/ui-strings/workspace";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveUiLocale();
  return { title: pick(locale, PRICING_PAGE.title) };
}

/** 定价页（M4-T2）：价格由 BILLING_PLAN_PRICES 配置驱动——M2 校准前不配置即显示「定价校准中」，不对外承诺。 */
export default async function PricingPage() {
  const user = await getSessionUser();
  const locale = await resolveUiLocale();
  const L = PRICING_PAGE;
  const page = (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">PRICING</span><h1>{pick(locale, L.title)}</h1><p>{pick(locale, L.headingBody)}</p></div>
      </div>
      <PricingPanel locale={locale} />
      <p className="sidebar-note">{pick(locale, L.calibrationNote)}</p>
      <p><Link href="/terms" className="text-button">{pick(locale, L.termsLink)}</Link></p>
      {!user ? <p><Link href="/" className="text-button">{pick(locale, L.backToOverview)}</Link></p> : null}
    </>
  );
  if (!user) return <PublicShell activeHref="/pricing">{page}</PublicShell>;
  const organization = await currentOrganization(user);
  return <AppShell user={user} organizationName={organization.name} activeHref="/pricing">{page}</AppShell>;
}

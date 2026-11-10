import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PublicShell } from "@/components/public-shell";
import { PricingPanel } from "@/components/pricing-panel";
import { getSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

export const metadata = { title: "套餐与定价" };

/** 定价页（M4-T2）：价格由 BILLING_PLAN_PRICES 配置驱动——M2 校准前不配置即显示「定价校准中」，不对外承诺。 */
export default async function PricingPage() {
  const user = await getSessionUser();
  const page = (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">PRICING</span><h1>套餐与定价</h1><p>月费提供确定额度，超量按 SAU 计费；失败的分析不扣额度，消费封顶可配。</p></div>
      </div>
      <PricingPanel />
      <p className="sidebar-note">价格与配额以实测成本校准后公布（当前为占位展示，不构成价格承诺）；退款、发票条款以正式服务条款为准。</p>
      <p><Link href="/terms" className="text-button">服务条款与数据处理 →</Link></p>
      {!user ? <p><Link href="/" className="text-button">← 返回产品总览</Link></p> : null}
    </>
  );
  if (!user) return <PublicShell activeHref="/pricing">{page}</PublicShell>;
  const organization = await currentOrganization(user);
  return <AppShell user={user} organizationName={organization.name} activeHref="/pricing">{page}</AppShell>;
}

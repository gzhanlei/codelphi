import Link from "next/link";
import { PricingPanel } from "@/components/pricing-panel";

export const dynamic = "force-dynamic";

export const metadata = { title: "套餐与定价" };

/** 定价页（M4-T2）：价格由 BILLING_PLAN_PRICES 配置驱动——M2 校准前不配置即显示「定价校准中」，不对外承诺。 */
export default function PricingPage() {
  return (
    <main className="pricing-page">
      <div className="page-heading">
        <div><span className="eyebrow">PRICING</span><h1>套餐与定价</h1><p>月费提供确定额度，超量按 SAU 计费；失败的分析不扣额度，消费封顶可配。</p></div>
      </div>
      <PricingPanel />
      <p className="sidebar-note">价格与配额以实测成本校准后公布（当前为占位展示，不构成价格承诺）；退款、发票条款以正式服务条款为准。</p>
      <p><Link href="/" className="text-button">← 返回产品总览</Link></p>
    </main>
  );
}

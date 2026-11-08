import { NextResponse } from "next/server";
import { resolvePackOffer, resolvePlanOffer, overagePacksEnabled } from "@/lib/billing/pricing-plans";

export const dynamic = "force-dynamic";

/** 可售商品（M4-T2）：BILLING_PLAN_PRICES 驱动；未配置 = 空货架（定价校准中，不对外承诺）。 */
export async function GET() {
  const plans = ["creator", "pro", "team"]
    .map((planId) => resolvePlanOffer(planId))
    .filter((offer): offer is NonNullable<typeof offer> => offer !== null);
  const packs = overagePacksEnabled()
    ? ["pack_100", "pack_500"].map((sku) => resolvePackOffer(sku)).filter((offer): offer is NonNullable<typeof offer> => offer !== null)
    : [];
  return NextResponse.json({ plans, packs, overageEnabled: overagePacksEnabled() });
}

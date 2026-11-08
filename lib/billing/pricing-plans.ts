import { z } from "zod";

/**
 * 可售商品价格表（M3-T2）：走环境变量注入——配额与价格未经 M2 校准前不配置（§4/§16：
 * 不得作为公开默认值），未配置 = 商品不可售（409 提示），禁止硬编码兜底价格。
 * 超额包另有合规开关（§5.1 法务结论前不开放）。
 */

const planPricesSchema = z.record(
  z.string(),
  z.object({ amount: z.number().int().positive(), includedSau: z.number().int().positive(), durationMonths: z.number().int().positive().default(1) }),
);

export interface PlanOffer {
  planId: string;
  amount: number;
  includedSau: number;
  durationMonths: number;
}

export function resolvePlanOffer(planId: string, raw = process.env.BILLING_PLAN_PRICES): PlanOffer | null {
  if (!raw?.trim()) return null;
  const parsed = planPricesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const entry = parsed.data[planId];
  if (!entry) return null;
  return { planId, amount: entry.amount, includedSau: entry.includedSau, durationMonths: entry.durationMonths };
}

export interface PackOffer {
  sku: string;
  amount: number;
  units: number;
}

export function overagePacksEnabled(raw: string | undefined = process.env.BILLING_OVERAGE_ENABLED): boolean {
  return raw === "true";
}

export function resolvePackOffer(sku: string, raw = process.env.BILLING_PACK_PRICES): PackOffer | null {
  if (!overagePacksEnabled(raw)) return null;
  const parsed = planPricesSchema.safeParse(JSON.parse(raw ?? "{}"));
  if (!parsed.success) return null;
  const entry = parsed.data[sku];
  if (!entry) return null;
  return { sku, amount: entry.amount, units: entry.includedSau };
}

import { z } from "zod";

/**
 * LLM 单价表（契约 M0-T2）：单价走环境变量 LLM_PRICES（JSON，按 model 给每百万 token 单价）。
 * 未配置或模型未列出 → pricing_status="unpriced"、成本 NULL——「未定价」与「零成本」是两种状态，
 * 禁止把未配置单价落成 0 元成本；M2 校准报告必须区分 unpriced 占比。
 * 单价随每条回执快照（pricing_version + 三项单价 + 币种）：供应商调价后历史成本仍可复核。
 */

const priceEntrySchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache: z.number().nonnegative().default(0),
  currency: z.string().min(1).max(8).default("CNY"),
  version: z.string().min(1).max(32).default("v1"),
});

const priceTableSchema = z.record(z.string(), priceEntrySchema);

export interface PricedLlm {
  status: "priced";
  version: string;
  inputPrice: number;
  outputPrice: number;
  cachePrice: number;
  currency: string;
}

export interface UnpricedLlm {
  status: "unpriced";
}

export type LlmPricing = PricedLlm | UnpricedLlm;

export function resolveLlmPricing(model: string, raw: string | undefined = process.env.LLM_PRICES): LlmPricing {
  if (!raw?.trim()) return { status: "unpriced" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unpriced" };
  }
  const table = priceTableSchema.safeParse(parsed);
  if (!table.success) return { status: "unpriced" };
  const entry = table.data[model];
  if (!entry) return { status: "unpriced" };
  return {
    status: "priced",
    version: entry.version,
    inputPrice: entry.input,
    outputPrice: entry.output,
    cachePrice: entry.cache,
    currency: entry.currency,
  };
}

/** 百万 token 单价 × 实际用量 → 成本金额（pricing.status !== "priced" 时返回 null）。 */
export function llmCostAmount(
  pricing: LlmPricing,
  usage: { inputTokens: number | null; outputTokens: number | null; cacheHitTokens: number | null },
): number | null {
  if (pricing.status !== "priced") return null;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * pricing.inputPrice;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPrice;
  const cache = ((usage.cacheHitTokens ?? 0) / 1_000_000) * pricing.cachePrice;
  return input + output + cache;
}

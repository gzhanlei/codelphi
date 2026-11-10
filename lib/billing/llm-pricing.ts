import { z } from "zod";

/**
 * LLM 单价表（契约 M0-T2）：单价走环境变量 LLM_PRICES（JSON，按 model 给每百万 token 单价）。
 * 未配置或模型未列出 → pricing_status="unpriced"、成本 NULL——「未定价」与「零成本」是两种状态，
 * 禁止把未配置单价落成 0 元成本；M2 校准报告必须区分 unpriced 占比。
 * 单价随每条回执快照（pricing_version + 三项单价 + 币种）：供应商调价后历史成本仍可复核。
 *
 * 时段（W0-9 评审采纳）：DeepSeek 官方按高峰/错峰两档计价（高峰=UTC 周一至周五
 * 01:00-04:00 与 06:00-10:00，即北京 09:00-12:00、14:00-18:00；周末/夜间错峰，错峰为半价）。
 * 支持两种配置形态：
 *   平铺（无时段区分）：{ input, output, cache }
 *   分时段：{ peak: {input, output, cache}, offPeak: {...} }——解析时按调用时刻选择档位，
 *   并把档位写进 pricing_version（<version>:peak / <version>:offPeak）供审计。
 * 已知限制：中国法定节假日官方按错峰，但未内置节假日日历——节假日白天会按高峰档计价，
 * 成本偏高（宁高勿低），需人工核对。
 */

const rateSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache: z.number().nonnegative().default(0),
});

const priceEntrySchema = z
  .object({
    peak: rateSchema.optional(),
    offPeak: rateSchema.optional(),
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache: z.number().nonnegative().optional(),
    currency: z.string().min(1).max(8).default("CNY"),
    version: z.string().min(1).max(32).default("v1"),
  })
  .superRefine((entry, ctx) => {
    const flat = entry.input !== undefined && entry.output !== undefined;
    const phased = entry.peak !== undefined && entry.offPeak !== undefined;
    if (!flat && !phased) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "price entry needs input/output (flat) or peak+offPeak (phased)" });
    }
  });

const priceTableSchema = z.record(z.string(), priceEntrySchema);

export interface PricedLlm {
  status: "priced";
  version: string;
  /** 缓存未命中输入价（每百万 token）。 */
  inputPrice: number;
  outputPrice: number;
  /** 缓存命中输入价（每百万 token）。 */
  cachePrice: number;
  currency: string;
  period: "peak" | "offPeak" | "flat";
}

export interface UnpricedLlm {
  status: "unpriced";
}

export type LlmPricing = PricedLlm | UnpricedLlm;

/** DeepSeek 高峰时段（UTC 周一至周五 01:00-04:00 与 06:00-10:00）；周末为错峰。中国法定节假日未内置日历。 */
export function isDeepSeekPeakHours(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

function pricedFromEntry(version: string, currency: string, rate: { input: number; output: number; cache: number }, period: "peak" | "offPeak" | "flat"): PricedLlm {
  return {
    status: "priced",
    version: period === "flat" ? version : `${version}:${period}`,
    inputPrice: rate.input,
    outputPrice: rate.output,
    cachePrice: rate.cache,
    currency,
    period,
  };
}

export function resolveLlmPricing(model: string, raw: string | undefined = process.env.LLM_PRICES, now: Date = new Date()): LlmPricing {
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
  if (entry.peak !== undefined && entry.offPeak !== undefined) {
    const peak = isDeepSeekPeakHours(now);
    return pricedFromEntry(entry.version, entry.currency, peak ? entry.peak : entry.offPeak, peak ? "peak" : "offPeak");
  }
  if (entry.input !== undefined && entry.output !== undefined) {
    return pricedFromEntry(entry.version, entry.currency, { input: entry.input, output: entry.output, cache: entry.cache ?? 0 }, "flat");
  }
  return { status: "unpriced" };
}

/**
 * 百万 token 单价 × 实际用量 → 成本金额（pricing.status !== "priced" 时返回 null）。
 * DeepSeek 语义：缓存命中 token 按 cache 价计费，替代（而非叠加）input 价——
 * 未命中数 = inputTokens − cacheHitTokens。
 */
export function llmCostAmount(
  pricing: LlmPricing,
  usage: { inputTokens: number | null; outputTokens: number | null; cacheHitTokens: number | null },
): number | null {
  if (pricing.status !== "priced") return null;
  const inputTotal = usage.inputTokens ?? 0;
  const hit = Math.min(usage.cacheHitTokens ?? 0, inputTotal);
  const miss = inputTotal - hit;
  const input = (miss / 1_000_000) * pricing.inputPrice;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * pricing.outputPrice;
  const cache = (hit / 1_000_000) * pricing.cachePrice;
  return input + output + cache;
}

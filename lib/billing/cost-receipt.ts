import { z } from "zod";
import { getDb } from "../db";
import { llmCostAmount, resolveLlmPricing } from "./llm-pricing";

/**
 * LLM 调用级成本回执（契约 M0-T2）：每次 provider request 完成即时写一条（成功/失败/超时各记），
 * 不等 run 终态——worker 崩溃不丢成本事实；run 级汇总由报表按 run_id 聚合。
 * best-effort：写失败仅告警不阻断分析主链路（每日对账复核缺失，M4-T5）。
 * usage_status：known（网关返回了 usage）/ unknown（超时或失败未拿到，禁止假设零成本）。
 * pricing_status：priced（单价已配置）/ unpriced（未配置，成本 NULL——未定价 ≠ 零成本）。
 */

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    // OpenAI 风格缓存明细
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
    // DeepSeek 直连风格缓存字段
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type LlmOutcome = "success" | "failed" | "timeout";
export type ChargeComponent = "main" | "platform_shadow";

export interface LlmCallReceiptInput {
  runId: number;
  accountId: number | null;
  chargeComponent: ChargeComponent;
  model: string;
  outcome: LlmOutcome;
  /** 网关原始 usage 对象；null/undefined = usage 不可得（usage_status=unknown）。 */
  usageRaw: unknown | null;
  providerRequestId?: string | null;
}

export interface ParsedLlmUsage {
  usageStatus: "known" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  usageJson: string | null;
}

export function parseLlmUsage(usageRaw: unknown | null): ParsedLlmUsage {
  if (usageRaw === null || usageRaw === undefined) {
    return { usageStatus: "unknown", inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null, usageJson: null };
  }
  const parsed = usageSchema.safeParse(usageRaw);
  if (!parsed.success) {
    // usage 存在但字段不认识：保留原始 JSON（usage_status=known），数值留 NULL 待解析演进
    return { usageStatus: "known", inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null, usageJson: safeStringify(usageRaw) };
  }
  const usage = parsed.data;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? null;
  return {
    usageStatus: "known",
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    cacheHitTokens: cached,
    cacheMissTokens: usage.prompt_cache_miss_tokens ?? null,
    usageJson: safeStringify(usageRaw),
  };
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export async function recordLlmCallReceipt(input: LlmCallReceiptInput): Promise<void> {
  try {
    const usage = parseLlmUsage(input.usageRaw);
    const pricing = resolveLlmPricing(input.model);
    // pricing_status 只表达单价配置状态（契约 M0-T2：unpriced = usage 已知但单价未配置）；
    // usage 不可得由 usage_status 表达——此时成本必然 NULL，但单价快照照记（恢复可计）
    const priced = pricing.status === "priced";
    const cost = priced && usage.usageStatus === "known" ? llmCostAmount(pricing, usage) : null;
    const pricedLlm = pricing.status === "priced" ? pricing : null;
    await getDb().execute(
      `INSERT INTO llm_call_receipts
        (run_id, account_id, charge_component, model, provider_request_id, outcome, usage_status,
         input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, usage_json,
         pricing_version, input_price, output_price, cache_price, currency, llm_cost_amount, pricing_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.accountId,
        input.chargeComponent,
        input.model,
        input.providerRequestId ?? null,
        input.outcome,
        usage.usageStatus,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheHitTokens,
        usage.cacheMissTokens,
        usage.usageJson,
        priced ? (pricedLlm?.version ?? null) : null,
        priced ? (pricedLlm?.inputPrice ?? null) : null,
        priced ? (pricedLlm?.outputPrice ?? null) : null,
        priced ? (pricedLlm?.cachePrice ?? null) : null,
        priced ? (pricedLlm?.currency ?? "CNY") : "CNY",
        cost,
        priced ? "priced" : "unpriced",
      ],
    );
  } catch (error) {
    // 契约：回执写入失败仅告警，不阻断分析主链路（每日对账复核缺失）
    console.error("[billing] llm call receipt write failed", error);
  }
}

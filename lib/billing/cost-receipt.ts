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
/** 行为清单全量分析的调用阶段（migration 080 call_stage）：复述/判定/语义复核/产品摘要。 */
export type LlmCallStage = "describe" | "judge" | "semantic_repair" | "product_summary";

export interface LlmCallReceiptInput {
  /** 分析口径绑定 analysis_runs；独立生成（call_kind='intro_material' 等）无 run，为 null。 */
  runId: number | null;
  accountId: number | null;
  chargeComponent: ChargeComponent;
  /** 调用类别（migration 062）：'intro_material' 等；分析口径留空。 */
  callKind?: string | null;
  /** 执行任务与尝试身份（migration 080）：旧分区/W0-8 调用不传，全部写 NULL。 */
  taskKey?: string | null;
  unitKey?: string | null;
  attemptId?: string | null;
  callStage?: LlmCallStage | null;
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
         pricing_version, input_price, output_price, cache_price, currency, llm_cost_amount, pricing_status, call_kind,
         task_key, unit_key, attempt_id, call_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.callKind ?? null,
        input.taskKey ?? null,
        input.unitKey ?? null,
        input.attemptId ?? null,
        input.callStage ?? null,
      ],
    );
  } catch (error) {
    // 契约：回执写入失败仅告警，不阻断分析主链路（每日对账复核缺失）
    console.error("[billing] llm call receipt write failed", error);
  }
}

/** 单次执行任务尝试（attempt）的真实 LLM 消耗，供共享预算结算（Task 7）。
 *  缺回执或任一未知都不是零成本：usage/tokens/cost 无法确认时字段为 null、状态按未知报。 */
export interface AttemptLlmUsage {
  /** 该 attempt 的回执条数；0 = 没有任何回执。 */
  llmCalls: number;
  /** 全部回执 usage_status=known 才为 known；无回执或任一 unknown → unknown。 */
  usageStatus: "known" | "unknown";
  /** 全部回执 priced 才为 priced；无回执或任一 unpriced → unpriced。 */
  pricingStatus: "priced" | "unpriced";
  /** 真实输入/输出 token 合计；任一回执未知则为 null（未知 ≠ 0）。 */
  inputTokens: number | null;
  outputTokens: number | null;
  /** 费用合计；任一回执未定价/未知则为 null（未知 ≠ 0）。 */
  costAmount: number | null;
}

interface AttemptReceiptRow {
  usage_status: unknown;
  pricing_status: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  llm_cost_amount: unknown;
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 聚合某次执行任务尝试的全部 LLM 回执（run_id + attempt_id）。 */
export async function loadAttemptLlmUsage(runId: number, attemptId: string): Promise<AttemptLlmUsage> {
  const [rows] = (await getDb().execute(
    `SELECT usage_status, pricing_status, input_tokens, output_tokens, llm_cost_amount
       FROM llm_call_receipts
      WHERE run_id = ? AND attempt_id = ?`,
    [runId, attemptId],
  )) as [AttemptReceiptRow[], unknown];
  const usageStatus = rows.length > 0 && rows.every((row) => row.usage_status === "known") ? "known" : "unknown";
  const pricingStatus = rows.length > 0 && rows.every((row) => row.pricing_status === "priced") ? "priced" : "unpriced";
  const sumOrNull = (pick: (row: AttemptReceiptRow) => unknown): number | null => {
    if (rows.length === 0) return null;
    let total = 0;
    for (const row of rows) {
      const value = numericOrNull(pick(row));
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  return {
    llmCalls: rows.length,
    usageStatus,
    pricingStatus,
    inputTokens: sumOrNull((row) => row.input_tokens),
    outputTokens: sumOrNull((row) => row.output_tokens),
    costAmount: sumOrNull((row) => row.llm_cost_amount),
  };
}

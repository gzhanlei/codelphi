import { z } from "zod";
import { getDb } from "../db";
import { llmCostAmount, resolveLlmPricing, type PricedLlm } from "./llm-pricing";

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
  /** 实际请求身份（migration 081）：batch/repair 请求必填且全局唯一；legacy 调用留空（NULL 可多行）。 */
  requestKey?: string | null;
  requestFingerprint?: string | null;
  /** 实际耗时（Task 4 gateway 扩展起记录；历史行 NULL）。 */
  durationMs?: number | null;
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

const RECEIPT_INSERT_SQL = `INSERT INTO llm_call_receipts
  (run_id, account_id, charge_component, model, provider_request_id, outcome, usage_status,
   input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, usage_json,
   pricing_version, input_price, output_price, cache_price, currency, llm_cost_amount, pricing_status, call_kind,
   task_key, unit_key, attempt_id, call_stage, request_key, request_fingerprint, duration_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 参数序（migration 081 追加）：0-23 与既有完全一致，24-26 = request_key/request_fingerprint/duration_ms。 */
function receiptInsertParams(
  input: LlmCallReceiptInput,
  usage: ParsedLlmUsage,
  pricing: PricedLlm | null,
  cost: number | null,
): Array<string | number | null> {
  const priced = pricing !== null;
  return [
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
    priced ? (pricing?.version ?? null) : null,
    priced ? (pricing?.inputPrice ?? null) : null,
    priced ? (pricing?.outputPrice ?? null) : null,
    priced ? (pricing?.cachePrice ?? null) : null,
    priced ? (pricing?.currency ?? "CNY") : "CNY",
    cost,
    priced ? "priced" : "unpriced",
    input.callKind ?? null,
    input.taskKey ?? null,
    input.unitKey ?? null,
    input.attemptId ?? null,
    input.callStage ?? null,
    input.requestKey ?? null,
    input.requestFingerprint ?? null,
    input.durationMs ?? null,
  ];
}

function pricingSnapshot(
  input: LlmCallReceiptInput,
  usage: ParsedLlmUsage,
): { pricing: PricedLlm | null; cost: number | null } {
  const pricing = resolveLlmPricing(input.model);
  const priced = pricing.status === "priced" ? pricing : null;
  const cost = priced !== null && usage.usageStatus === "known" ? llmCostAmount(priced, usage) : null;
  return { pricing: priced, cost };
}

export async function recordLlmCallReceipt(input: LlmCallReceiptInput): Promise<void> {
  try {
    const usage = parseLlmUsage(input.usageRaw);
    const { pricing, cost } = pricingSnapshot(input, usage);
    await getDb().execute(RECEIPT_INSERT_SQL, receiptInsertParams(input, usage, pricing, cost));
  } catch (error) {
    // 契约：回执写入失败仅告警，不阻断分析主链路（每日对账复核缺失）
    console.error("[billing] llm call receipt write failed", error);
  }
}

export interface RequestScopedReceiptInput extends LlmCallReceiptInput {
  requestKey: string;
  requestFingerprint: string;
}

export type ReceiptReconcileResult = "inserted" | "reconciled" | "noop";

function isDuplicateEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

function receiptConflictError(requestKey: string, detail: string): Error {
  return new Error(`llm receipt conflict for ${requestKey}: ${detail}`);
}

interface ReceiptReconcileRow {
  request_fingerprint: unknown;
  provider_request_id: unknown;
  usage_status: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_hit_tokens: unknown;
  cache_miss_tokens: unknown;
  usage_json: unknown;
  llm_cost_amount: unknown;
  duration_ms: unknown;
}

/** 双方都未知（NULL）视为可补全；都有值且不同才是冲突（§23.3 C3.5）。 */
function tokenPairEqual(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return true;
  return Number(left) === Number(right);
}

/**
 * 请求身份回执的 insert-or-reconcile（§23.3 C3.5）：同 request_key + 同 fingerprint 的重复投递
 * 幂等 no-op；provider_request_id / usage 仅允许 unknown→known 单调补全；已知值之间出现不同值
 * 抛账务冲突（不得 last-write-wins）；request_fingerprint 永不改变；duration_ms 取第一次记录。
 * 非重复的写失败仅告警——batch_requests 行状态权威 + receipt 缺失按 C3.6 保守结算兜底。
 */
export async function recordRequestScopedReceipt(input: RequestScopedReceiptInput): Promise<ReceiptReconcileResult> {
  const usage = parseLlmUsage(input.usageRaw);
  const { pricing, cost } = pricingSnapshot(input, usage);
  try {
    await getDb().execute(RECEIPT_INSERT_SQL, receiptInsertParams(input, usage, pricing, cost));
    return "inserted";
  } catch (error) {
    if (!isDuplicateEntryError(error)) {
      console.error("[billing] request-scoped llm receipt write failed", error);
      return "noop";
    }
  }
  const [rows] = (await getDb().execute(
    `SELECT request_fingerprint, provider_request_id, usage_status, input_tokens, output_tokens,
            cache_hit_tokens, cache_miss_tokens, usage_json, llm_cost_amount, duration_ms
       FROM llm_call_receipts WHERE request_key = ?`,
    [input.requestKey],
  )) as [ReceiptReconcileRow[], unknown];
  const existing = rows[0];
  if (!existing) throw receiptConflictError(input.requestKey, "duplicate insert reported without an existing row");
  if (str(existing.request_fingerprint) !== input.requestFingerprint) {
    throw receiptConflictError(input.requestKey, "request_fingerprint mismatch");
  }
  const incomingProviderId = input.providerRequestId ?? null;
  if (existing.provider_request_id !== null && incomingProviderId !== null && str(existing.provider_request_id) !== incomingProviderId) {
    throw receiptConflictError(input.requestKey, `provider_request_id ${str(existing.provider_request_id)} != ${incomingProviderId}`);
  }
  const incomingKnown = usage.usageStatus === "known";
  const existingKnown = existing.usage_status === "known";
  if (existingKnown && incomingKnown) {
    const pairs = [
      ["input_tokens", existing.input_tokens, usage.inputTokens],
      ["output_tokens", existing.output_tokens, usage.outputTokens],
      ["cache_hit_tokens", existing.cache_hit_tokens, usage.cacheHitTokens],
      ["cache_miss_tokens", existing.cache_miss_tokens, usage.cacheMissTokens],
    ] as const;
    for (const [label, left, right] of pairs) {
      if (!tokenPairEqual(left, right)) throw receiptConflictError(input.requestKey, `${label} ${str(left)} != ${str(right)}`);
    }
    if (existing.llm_cost_amount !== null && cost !== null && Number(existing.llm_cost_amount) !== cost) {
      throw receiptConflictError(input.requestKey, `llm_cost_amount ${str(existing.llm_cost_amount)} != ${cost}`);
    }
  }
  const merged = {
    providerRequestId: incomingProviderId ?? (existing.provider_request_id === null ? null : str(existing.provider_request_id)),
    inputTokens: incomingKnown && usage.inputTokens !== null ? usage.inputTokens : numericOrNull(existing.input_tokens),
    outputTokens: incomingKnown && usage.outputTokens !== null ? usage.outputTokens : numericOrNull(existing.output_tokens),
    cacheHitTokens: incomingKnown && usage.cacheHitTokens !== null ? usage.cacheHitTokens : numericOrNull(existing.cache_hit_tokens),
    cacheMissTokens: incomingKnown && usage.cacheMissTokens !== null ? usage.cacheMissTokens : numericOrNull(existing.cache_miss_tokens),
    usageJson: usage.usageJson ?? (existing.usage_json === null ? null : str(existing.usage_json)),
    usageStatus: existingKnown || incomingKnown ? "known" : "unknown",
    costAmount: cost !== null ? cost : numericOrNull(existing.llm_cost_amount),
    // duration 是观测数据：取第一次成功记录，重复回执不覆盖（§23.3 C3.5）
    durationMs: numericOrNull(existing.duration_ms) ?? input.durationMs ?? null,
  };
  const changed =
    merged.providerRequestId !== (existing.provider_request_id === null ? null : str(existing.provider_request_id)) ||
    merged.inputTokens !== numericOrNull(existing.input_tokens) ||
    merged.outputTokens !== numericOrNull(existing.output_tokens) ||
    merged.cacheHitTokens !== numericOrNull(existing.cache_hit_tokens) ||
    merged.cacheMissTokens !== numericOrNull(existing.cache_miss_tokens) ||
    merged.usageJson !== (existing.usage_json === null ? null : str(existing.usage_json)) ||
    merged.usageStatus !== str(existing.usage_status) ||
    merged.costAmount !== numericOrNull(existing.llm_cost_amount) ||
    merged.durationMs !== numericOrNull(existing.duration_ms);
  if (!changed) return "noop";
  await getDb().execute(
    `UPDATE llm_call_receipts
        SET provider_request_id = ?, input_tokens = ?, output_tokens = ?, cache_hit_tokens = ?, cache_miss_tokens = ?,
            usage_json = ?, usage_status = ?, llm_cost_amount = ?, duration_ms = ?
      WHERE request_key = ? AND request_fingerprint = ?`,
    [
      merged.providerRequestId,
      merged.inputTokens,
      merged.outputTokens,
      merged.cacheHitTokens,
      merged.cacheMissTokens,
      merged.usageJson,
      merged.usageStatus,
      merged.costAmount,
      merged.durationMs,
      input.requestKey,
      input.requestFingerprint,
    ],
  );
  return "reconciled";
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

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
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

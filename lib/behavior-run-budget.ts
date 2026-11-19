import { loadAttemptLlmUsage } from "./billing/cost-receipt";
import { getDb } from "./db";

/** Task 7 契约（2026-11-19 行为清单全量分析，D9）：共享运行预算的原子预留、回执结算与释放。
 *
 *  analysis_run_budgets 每 run 一行聚合计数（无逐笔预留表），所有变更只发条件 UPDATE
 *  （余额谓词 / summary_reserved 谓词），绝不先 SELECT 余额再无条件写入——
 *  余额竞争由数据库在写入时判定，worker 不根据各自读到的旧余额独立派发。
 *
 *  - maxLlmCalls 严格原子预留：预留覆盖复述、判定、硬失败重试与语义复核的最大调用数。
 *  - token/费用按上界预留、按 llm_call_receipts 真实回执结算；usage/费用未知绝不按零入账——
 *    未知维度按该笔预留上界保守转入 settled；配置了对应硬上限时抛
 *    behavior_budget_usage_unknown，停止新的派发。
 *  - 任务终态（settle）把整笔预留转出、实际消耗转入 settled，未发生部分随之释放；
 *    releaseUnused 仅用于从未消耗即放弃的预留（领取租约失败），每个 reservationId
 *    只能走 settle 或 releaseUnused 之一。
 *  - 实际超过预留（并发在途/估算误差）不截断：settled 可如实超过 max，overshoot 在账本上显式可见。
 *  - 旧 attempt 预留在结算或租约回收前保持占用；重新领取必须重新预留（新 attemptId）。
 *
 *  无对应上限的表示：Task 13 建行时写入下列 sentinel（列均 NOT NULL，不用 0 表示无上限）。
 */

export type BehaviorBudgetErrorCode = "behavior_budget_exceeded" | "behavior_budget_usage_unknown";

export class BehaviorBudgetError extends Error {
  code: BehaviorBudgetErrorCode;
  constructor(code: BehaviorBudgetErrorCode, message: string) {
    super(message);
    this.name = "BehaviorBudgetError";
    this.code = code;
  }
}

/** 无上限 sentinel：max_llm_calls INT 列最大值。 */
export const UNLIMITED_MAX_LLM_CALLS = 2_147_483_647;
/** 无上限 sentinel：max_total_tokens BIGINT UNSIGNED 列最大值。 */
export const UNLIMITED_MAX_TOTAL_TOKENS = "18446744073709551615";
/** 无上限 sentinel：max_cost_amount DECIMAL(12,6) 列最大值。 */
export const UNLIMITED_MAX_COST_AMOUNT = "999999.999999";

/** 产品摘要调用的 attempt 标识（D10：摘要一次独立调用，写入回执时携带同一 attemptId）。 */
export const PRODUCT_SUMMARY_ATTEMPT_ID = "product_summary";
/** 摘要份额的预留上界常量（D9：调用、token、费用独立预留，不与单元抢占）。
 *  上界取值保守可调；预留偏保守只会提前停止派发，不会放行超支。 */
export const PRODUCT_SUMMARY_RESERVED_LLM_CALLS = 1;
export const PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS = 128_000;
export const PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS = 8_192;
export const PRODUCT_SUMMARY_RESERVED_COST_AMOUNT = 5;

const COST_MICROS = 1_000_000;
const RESERVATION_ID_PREFIX = "bb1";

export interface BudgetReservationInput {
  runId: number;
  /** 本次尝试身份（lease attempt）；过期重试必须用新 attemptId 重新预留。 */
  attemptId: string;
  /** 该任务可能发生的最大调用数（含最大重试）。 */
  maxLlmCalls: number;
  /** 输入 token 上界（按事前区间上限）。 */
  maxInputTokens: number;
  /** 输出 token 上界（按预计上限）。 */
  maxOutputTokens: number;
  /** 费用上界（账本 currency 口径）。 */
  maxCostAmount: number;
}

export interface BudgetReservation {
  /** 自描述预留句柄：编码 run/attempt 与四维预留量，供 release 独立释放（账本无逐笔预留表）。 */
  reservationId: string;
  runId: number;
  attemptId: string;
  reservedLlmCalls: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostAmount: number;
}

export interface BudgetSettlementInput {
  /** 任务终态结算的预留；实际消耗从该 attempt 的 llm_call_receipts 聚合。 */
  reservation: BudgetReservation;
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${String(value)}`);
  }
}

function costToMicros(cost: number): number {
  return Math.round(cost * COST_MICROS);
}

function microsToCost(micros: number): number {
  return micros / COST_MICROS;
}

/** DECIMAL(12,6) 参数统一走定点字符串，避免浮点进入 SQL。 */
function microsToDecimal(micros: number): string {
  return microsToCost(micros).toFixed(6);
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

interface ParsedReservationId {
  runId: number;
  attemptId: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

function parseReservationId(reservationId: string): ParsedReservationId {
  const parts = reservationId.split(":");
  if (parts.length !== 7 || parts[0] !== RESERVATION_ID_PREFIX) {
    throw new Error(`malformed behavior budget reservation id: ${reservationId}`);
  }
  const [, runIdPart, attemptPart, callsPart, inPart, outPart, costPart] = parts;
  const runId = Number(runIdPart);
  const llmCalls = Number(callsPart);
  const inputTokens = Number(inPart);
  const outputTokens = Number(outPart);
  const costMicros = Number(costPart);
  if (
    !Number.isInteger(runId) ||
    runId <= 0 ||
    !Number.isInteger(llmCalls) ||
    llmCalls < 0 ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isInteger(costMicros) ||
    costMicros < 0 ||
    attemptPart.length === 0
  ) {
    throw new Error(`malformed behavior budget reservation id: ${reservationId}`);
  }
  return { runId, attemptId: fromBase64Url(attemptPart), llmCalls, inputTokens, outputTokens, costMicros };
}

function buildReservation(
  runId: number,
  attemptId: string,
  llmCalls: number,
  inputTokens: number,
  outputTokens: number,
  costMicros: number,
): BudgetReservation {
  const reservationId = [RESERVATION_ID_PREFIX, runId, base64Url(attemptId), llmCalls, inputTokens, outputTokens, costMicros].join(
    ":",
  );
  return {
    reservationId,
    runId,
    attemptId,
    reservedLlmCalls: llmCalls,
    reservedInputTokens: inputTokens,
    reservedOutputTokens: outputTokens,
    reservedCostAmount: microsToCost(costMicros),
  };
}

interface UpdateResult {
  affectedRows: number;
}

interface BudgetConfigRow {
  max_llm_calls: unknown;
  max_total_tokens: unknown;
  max_cost_amount: unknown;
}

async function executeBudgetUpdate(statement: string, parameters: Array<string | number | null>): Promise<number> {
  const [result] = (await getDb().execute(statement, parameters)) as [UpdateResult, unknown];
  return Number(result.affectedRows ?? 0);
}

/**
 * 原子预留任务预算：单条条件 UPDATE 在数据库侧判定余额，预算不足（或行不存在）抛
 * behavior_budget_exceeded；maxLlmCalls 维度严格，token 合并口径、费用按上界判定。
 */
export async function reserveBehaviorBudget(input: BudgetReservationInput): Promise<BudgetReservation> {
  assertPositiveInt(input.runId, "runId");
  if (typeof input.attemptId !== "string" || input.attemptId.length === 0) {
    throw new Error("attemptId must be a non-empty string");
  }
  assertPositiveInt(input.maxLlmCalls, "maxLlmCalls");
  if (input.maxLlmCalls === 0) throw new Error("maxLlmCalls must be positive");
  assertPositiveInt(input.maxInputTokens, "maxInputTokens");
  assertPositiveInt(input.maxOutputTokens, "maxOutputTokens");
  if (!Number.isFinite(input.maxCostAmount) || input.maxCostAmount < 0) {
    throw new Error(`maxCostAmount must be a non-negative finite number, got ${String(input.maxCostAmount)}`);
  }
  const costMicros = costToMicros(input.maxCostAmount);
  const tokenUpperBound = input.maxInputTokens + input.maxOutputTokens;
  const affected = await executeBudgetUpdate(
    `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + ?,
            reserved_input_tokens = reserved_input_tokens + ?,
            reserved_output_tokens = reserved_output_tokens + ?,
            reserved_cost_amount = reserved_cost_amount + ?,
            version = version + 1
      WHERE run_id = ?
        AND (max_llm_calls = ? OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls)
        AND (max_total_tokens = ? OR settled_input_tokens + reserved_input_tokens + settled_output_tokens + reserved_output_tokens + ? <= max_total_tokens)
        AND (max_cost_amount = ? OR settled_cost_amount + reserved_cost_amount + ? <= max_cost_amount)`,
    [
      input.maxLlmCalls,
      input.maxInputTokens,
      input.maxOutputTokens,
      microsToDecimal(costMicros),
      input.runId,
      UNLIMITED_MAX_LLM_CALLS,
      input.maxLlmCalls,
      UNLIMITED_MAX_TOTAL_TOKENS,
      tokenUpperBound,
      UNLIMITED_MAX_COST_AMOUNT,
      microsToDecimal(costMicros),
    ],
  );
  if (affected !== 1) {
    throw new BehaviorBudgetError(
      "behavior_budget_exceeded",
      `run ${input.runId} behavior budget cannot cover reservation of ${input.maxLlmCalls} llm calls / ${tokenUpperBound} tokens / ${microsToDecimal(costMicros)} for attempt ${input.attemptId}`,
    );
  }
  return buildReservation(input.runId, input.attemptId, input.maxLlmCalls, input.maxInputTokens, input.maxOutputTokens, costMicros);
}

/**
 * 产品摘要份额独立预留（D9/D10：摘要调用、token、费用不与单元抢占，不能因单元超支静默跳过）。
 * 每 run 一次：summary_reserved 0→1 与余额判定在同一条件 UPDATE；已预留时幂等返回同一预留。
 */
export async function reserveProductSummaryBudget(runId: number): Promise<BudgetReservation> {
  assertPositiveInt(runId, "runId");
  if (runId === 0) throw new Error("runId must be positive");
  const costMicros = costToMicros(PRODUCT_SUMMARY_RESERVED_COST_AMOUNT);
  const tokenUpperBound = PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS + PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS;
  const reservation = buildReservation(
    runId,
    PRODUCT_SUMMARY_ATTEMPT_ID,
    PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
    PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
    PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
    costMicros,
  );
  const affected = await executeBudgetUpdate(
    `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + ?,
            reserved_input_tokens = reserved_input_tokens + ?,
            reserved_output_tokens = reserved_output_tokens + ?,
            reserved_cost_amount = reserved_cost_amount + ?,
            summary_reserved = 1,
            version = version + 1
      WHERE run_id = ?
        AND summary_reserved = 0
        AND (max_llm_calls = ? OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls)
        AND (max_total_tokens = ? OR settled_input_tokens + reserved_input_tokens + settled_output_tokens + reserved_output_tokens + ? <= max_total_tokens)
        AND (max_cost_amount = ? OR settled_cost_amount + reserved_cost_amount + ? <= max_cost_amount)`,
    [
      PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
      PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
      PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
      microsToDecimal(costMicros),
      runId,
      UNLIMITED_MAX_LLM_CALLS,
      PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
      UNLIMITED_MAX_TOTAL_TOKENS,
      tokenUpperBound,
      UNLIMITED_MAX_COST_AMOUNT,
      microsToDecimal(costMicros),
    ],
  );
  if (affected === 1) return reservation;
  // 失败只有两种原因：已预留（幂等成功）或预算不足；summary_reserved 单调 0→1，读后判定无竞态。
  const [rows] = (await getDb().execute("SELECT summary_reserved FROM analysis_run_budgets WHERE run_id = ?", [
    runId,
  ])) as [Array<{ summary_reserved: unknown }>, unknown];
  if (rows.length > 0 && Number(rows[0].summary_reserved) === 1) return reservation;
  throw new BehaviorBudgetError(
    "behavior_budget_exceeded",
    `run ${runId} behavior budget cannot cover the product summary reservation of ${PRODUCT_SUMMARY_RESERVED_LLM_CALLS} llm call / ${tokenUpperBound} tokens / ${microsToDecimal(costMicros)}`,
  );
}

/**
 * 任务终态结算：按 attempt 回执聚实际消耗，整笔预留转出、实际转入 settled（未发生部分随之释放）。
 * usage/费用未知绝不按零入账——未知维度按预留上界保守转入 settled；配置对应硬上限时
 * 在入账后抛 behavior_budget_usage_unknown，调用方必须停止新的派发。
 * 实际超过预留不截断（settled 可如实超过 max，overshoot 显式）；重复结算被余额谓词拒绝。
 */
export async function settleBehaviorBudget(input: BudgetSettlementInput): Promise<void> {
  const { reservation } = input;
  const usage = await loadAttemptLlmUsage(reservation.runId, reservation.attemptId);
  // 逐维度结算：已知按实际，未知按预留上界（未知 ≠ 零）。
  const settledCalls = usage.llmCalls;
  const settledInput = usage.inputTokens ?? reservation.reservedInputTokens;
  const settledOutput = usage.outputTokens ?? reservation.reservedOutputTokens;
  const settledCostMicros =
    usage.costAmount === null ? costToMicros(reservation.reservedCostAmount) : costToMicros(usage.costAmount);
  const reservedCostMicros = costToMicros(reservation.reservedCostAmount);

  const [configRows] = (await getDb().execute(
    "SELECT max_llm_calls, max_total_tokens, max_cost_amount FROM analysis_run_budgets WHERE run_id = ?",
    [reservation.runId],
  )) as [BudgetConfigRow[], unknown];
  const config = configRows[0];
  if (!config) {
    throw new BehaviorBudgetError(
      "behavior_budget_exceeded",
      `run ${reservation.runId} has no behavior budget row; cannot settle reservation ${reservation.reservationId}`,
    );
  }

  const affected = await executeBudgetUpdate(
    `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls - ?,
            reserved_input_tokens = reserved_input_tokens - ?,
            reserved_output_tokens = reserved_output_tokens - ?,
            reserved_cost_amount = reserved_cost_amount - ?,
            settled_llm_calls = settled_llm_calls + ?,
            settled_input_tokens = settled_input_tokens + ?,
            settled_output_tokens = settled_output_tokens + ?,
            settled_cost_amount = settled_cost_amount + ?,
            version = version + 1
      WHERE run_id = ?
        AND reserved_llm_calls >= ?
        AND reserved_input_tokens >= ?
        AND reserved_output_tokens >= ?
        AND reserved_cost_amount >= ?`,
    [
      reservation.reservedLlmCalls,
      reservation.reservedInputTokens,
      reservation.reservedOutputTokens,
      microsToDecimal(reservedCostMicros),
      settledCalls,
      settledInput,
      settledOutput,
      microsToDecimal(settledCostMicros),
      reservation.runId,
      reservation.reservedLlmCalls,
      reservation.reservedInputTokens,
      reservation.reservedOutputTokens,
      microsToDecimal(reservedCostMicros),
    ],
  );
  if (affected !== 1) {
    throw new BehaviorBudgetError(
      "behavior_budget_exceeded",
      `reservation ${reservation.reservationId} is not outstanding (already settled/released or budget row missing); refusing to double-settle`,
    );
  }

  const tokenCapConfigured = String(config.max_total_tokens) !== UNLIMITED_MAX_TOTAL_TOKENS;
  const costCapConfigured = String(config.max_cost_amount) !== UNLIMITED_MAX_COST_AMOUNT;
  const tokensUnknown = usage.inputTokens === null || usage.outputTokens === null;
  const costUnknown = usage.costAmount === null;
  if ((tokensUnknown && tokenCapConfigured) || (costUnknown && costCapConfigured)) {
    throw new BehaviorBudgetError(
      "behavior_budget_usage_unknown",
      `run ${reservation.runId} attempt ${reservation.attemptId} settled with unknown ` +
        `${[tokensUnknown && tokenCapConfigured ? "token usage" : null, costUnknown && costCapConfigured ? "cost" : null]
          .filter(Boolean)
          .join(" and ")} under a configured hard cap; unknown usage was accounted at the reserved upper bound, not zero — stop dispatching new tasks`,
    );
  }
}

/**
 * 释放从未消耗即放弃的预留（领取租约失败路径）。只发条件 UPDATE：预留余额不足
 * （已结算/已释放/从未存在）时为幂等 no-op。已 settle 的预留不得再走本函数。
 */
export async function releaseUnusedBehaviorBudget(reservationId: string): Promise<void> {
  const parsed = parseReservationId(reservationId);
  await executeBudgetUpdate(
    `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls - ?,
            reserved_input_tokens = reserved_input_tokens - ?,
            reserved_output_tokens = reserved_output_tokens - ?,
            reserved_cost_amount = reserved_cost_amount - ?,
            version = version + 1
      WHERE run_id = ?
        AND reserved_llm_calls >= ?
        AND reserved_input_tokens >= ?
        AND reserved_output_tokens >= ?
        AND reserved_cost_amount >= ?`,
    [
      parsed.llmCalls,
      parsed.inputTokens,
      parsed.outputTokens,
      microsToDecimal(parsed.costMicros),
      parsed.runId,
      parsed.llmCalls,
      parsed.inputTokens,
      parsed.outputTokens,
      microsToDecimal(parsed.costMicros),
    ],
  );
}

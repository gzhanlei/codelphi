import { randomUUID } from "node:crypto";
import { loadAttemptLlmUsage } from "./billing/cost-receipt";
import { getDb } from "./db";

/** Task 7 契约（2026-11-19 行为清单全量分析，D9；fix round 1 处理 C1/I1）：
 *  共享运行预算的原子预留、回执结算与释放。
 *
 *  两张表协同：
 *  - analysis_run_budgets：每 run 一行的聚合计数账本。预留余额判定只发条件 UPDATE
 *    （余额谓词 / summary_reserved 谓词），绝不先 SELECT 余额再无条件写入——
 *    余额竞争由数据库在写入时判定，worker 不根据各自读到的旧余额独立派发。
 *  - analysis_behavior_budget_reservations：逐尝试预留状态行（C1），是预留身份与金额的
 *    唯一权威。settle/release 在短事务内 SELECT ... FOR UPDATE 验证该预留自身状态并转移
 *    （reserved → settled / settled_unknown / released），同事务完成聚合账本变更后提交。
 *    重复 settle/release 是真 no-op（已 settled/released 的预留绝不再动账本），
 *    与之后是否有新预留无关——聚合计数本身不作为身份判据。
 *
 *  - maxLlmCalls 严格原子预留：预留覆盖复述、判定、硬失败重试与语义复核的最大调用数。
 *  - token/费用按上界预留、按 llm_call_receipts 真实回执结算；usage/费用未知绝不按零入账——
 *    未知维度按该笔预留上界保守转入 settled；配置对应硬上限时抛
 *    behavior_budget_usage_unknown，调用方必须停止新的派发。
 *  - I1：缺回执（0 条）时调用次数同样未知——按预留的 maxLlmCalls 入账而非 0；
 *    配置 calls 硬上限时同样抛 behavior_budget_usage_unknown。
 *  - 任务终态（settle）把整笔预留转出、实际消耗转入 settled，未发生部分随之释放；
 *    releaseUnused 仅用于从未消耗即放弃的预留（领取租约失败，或摘要首次 LLM 调用前
 *    的编排退出）。fix round 2（Task 13 review）：释放 kind=product_summary 的预留必须
 *    在同一事务内把 summary_reserved 复位为 0——否则摘要份额在门禁失败等预摘要退出后
 *    永久泄漏，该 run 无法再取得摘要预留。
 *  - 实际超过预留（并发在途/估算误差）不截断：settled 可如实超过 max，overshoot 显式可见。
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

type ReservationKind = "task" | "product_summary";
type ReservationStatus = "reserved" | "settled" | "settled_unknown" | "released";

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
  /** 服务端分配的不透明预留 ID（reservation_uuid）；金额与状态以服务端行 为权威。 */
  reservationId: string;
  runId: number;
  attemptId: string;
  kind: ReservationKind;
  reservedLlmCalls: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostAmount: number;
}

export interface BudgetSettlementInput {
  /** 任务终态结算的预留 ID；金额与 attempt 以服务端预留行为准，实际消耗按回执聚合。 */
  reservationId: string;
}

interface BudgetConnection {
  beginTransaction(): Promise<unknown>;
  execute(statement: string, parameters: Array<string | number | null>): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  release(): void;
}

type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;

async function withBudgetTransaction<T>(fn: (execute: Execute) => Promise<T>): Promise<T> {
  const connection = (await getDb().getConnection()) as unknown as BudgetConnection;
  try {
    await connection.beginTransaction();
    const result = await fn((statement, parameters) => connection.execute(statement, parameters));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${String(value)}`);
  }
}

/** DECIMAL(12,6) 参数统一走定点字符串，避免浮点进入 SQL。 */
function toDecimal(cost: number): string {
  return cost.toFixed(6);
}

interface UpdateResult {
  affectedRows: number;
}

interface ReservationRow {
  id: unknown;
  reservation_uuid: unknown;
  run_id: unknown;
  attempt_id: unknown;
  kind: unknown;
  reserved_llm_calls: unknown;
  reserved_input_tokens: unknown;
  reserved_output_tokens: unknown;
  reserved_cost_amount: unknown;
  status: unknown;
}

interface ParsedReservation {
  reservationId: string;
  runId: number;
  attemptId: string;
  kind: ReservationKind;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  status: ReservationStatus;
}

function parseReservationRow(row: ReservationRow): ParsedReservation {
  return {
    reservationId: String(row.reservation_uuid),
    runId: Number(row.run_id),
    attemptId: String(row.attempt_id),
    kind: String(row.kind) as ReservationKind,
    llmCalls: Number(row.reserved_llm_calls),
    inputTokens: Number(row.reserved_input_tokens),
    outputTokens: Number(row.reserved_output_tokens),
    costAmount: Number(row.reserved_cost_amount),
    status: String(row.status) as ReservationStatus,
  };
}

const RESERVATION_COLUMNS =
  "id, reservation_uuid, run_id, attempt_id, kind, reserved_llm_calls, reserved_input_tokens, reserved_output_tokens, reserved_cost_amount, status";

async function lockReservation(execute: Execute, reservationId: string): Promise<ParsedReservation | null> {
  const [rows] = (await execute(
    `SELECT ${RESERVATION_COLUMNS} FROM analysis_behavior_budget_reservations WHERE reservation_uuid = ? FOR UPDATE`,
    [reservationId],
  )) as [ReservationRow[], unknown];
  return rows.length > 0 ? parseReservationRow(rows[0]) : null;
}

async function applyLedgerUpdate(execute: Execute, statement: string, parameters: Array<string | number | null>): Promise<number> {
  const [result] = (await execute(statement, parameters)) as [UpdateResult, unknown];
  return Number(result.affectedRows ?? 0);
}

function toBudgetReservation(parsed: ParsedReservation): BudgetReservation {
  return {
    reservationId: parsed.reservationId,
    runId: parsed.runId,
    attemptId: parsed.attemptId,
    kind: parsed.kind,
    reservedLlmCalls: parsed.llmCalls,
    reservedInputTokens: parsed.inputTokens,
    reservedOutputTokens: parsed.outputTokens,
    reservedCostAmount: parsed.costAmount,
  };
}

function validateReservationInput(input: BudgetReservationInput): void {
  assertPositiveInt(input.runId, "runId");
  if (input.runId === 0) throw new Error("runId must be positive");
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
}

/** 聚合账本的原子预留扣减：余额谓词条件 UPDATE，sentinel 表示对应维度无上限。
 *  sentinel 判等用 SQL 内联字面量（常量模块内写死，无注入面），绝不作为绑定参数跨
 *  协议传输（2026-11-20 bench 真库复现）：mysql2 预编译（execute）下 uint64 哨兵字符
 *  串经服务器参数类型推断会走 DECIMAL 溢出（Truncated incorrect DECIMAL value）或被
 *  舍入为 2^63（Critical N 的协议面残余），判等失效会把「无上限」误判为「已配置上限」
 *  并阻断派发。文本协议（query）不触发——假 execute 的单测抓不到，只有真库触发。 */
async function applyLedgerReservation(
  execute: Execute,
  input: { runId: number; llmCalls: number; inputTokens: number; outputTokens: number; costAmount: number; summary: boolean },
): Promise<number> {
  const tokenUpperBound = input.inputTokens + input.outputTokens;
  const summarySet = input.summary ? ", summary_reserved = 1" : "";
  const summaryPredicate = input.summary ? "AND summary_reserved = 0" : "";
  return applyLedgerUpdate(
    execute,
    `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + ?,
            reserved_input_tokens = reserved_input_tokens + ?,
            reserved_output_tokens = reserved_output_tokens + ?,
            reserved_cost_amount = reserved_cost_amount + ?${summarySet},
            version = version + 1
      WHERE run_id = ?
        ${summaryPredicate}
        AND (max_llm_calls = ${UNLIMITED_MAX_LLM_CALLS} OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls)
        AND (max_total_tokens = ${UNLIMITED_MAX_TOTAL_TOKENS} OR settled_input_tokens + reserved_input_tokens + settled_output_tokens + reserved_output_tokens + ? <= max_total_tokens)
        AND (max_cost_amount = ${UNLIMITED_MAX_COST_AMOUNT} OR settled_cost_amount + reserved_cost_amount + ? <= max_cost_amount)`,
    [
      input.llmCalls,
      input.inputTokens,
      input.outputTokens,
      toDecimal(input.costAmount),
      input.runId,
      input.llmCalls,
      tokenUpperBound,
      toDecimal(input.costAmount),
    ],
  );
}

async function insertReservationRow(
  execute: Execute,
  input: { reservationId: string; runId: number; attemptId: string; kind: ReservationKind; llmCalls: number; inputTokens: number; outputTokens: number; costAmount: number },
): Promise<void> {
  await execute(
    `INSERT INTO analysis_behavior_budget_reservations
       (reservation_uuid, run_id, attempt_id, kind, reserved_llm_calls, reserved_input_tokens, reserved_output_tokens, reserved_cost_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
    [
      input.reservationId,
      input.runId,
      input.attemptId,
      input.kind,
      input.llmCalls,
      input.inputTokens,
      input.outputTokens,
      toDecimal(input.costAmount),
    ],
  );
}

/**
 * 原子预留任务预算：事务内先以条件 UPDATE 在数据库侧判定余额（maxLlmCalls 严格、
 * token 合并口径、费用按上界），再插入该预留的状态行；预算不足（或行不存在）抛
 * behavior_budget_exceeded，事务回滚不留半成品。
 */
export async function reserveBehaviorBudget(input: BudgetReservationInput): Promise<BudgetReservation> {
  validateReservationInput(input);
  const reservationId = randomUUID();
  return withBudgetTransaction(async (execute) => {
    const affected = await applyLedgerReservation(execute, {
      runId: input.runId,
      llmCalls: input.maxLlmCalls,
      inputTokens: input.maxInputTokens,
      outputTokens: input.maxOutputTokens,
      costAmount: input.maxCostAmount,
      summary: false,
    });
    if (affected !== 1) {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `run ${input.runId} behavior budget cannot cover reservation of ${input.maxLlmCalls} llm calls / ${input.maxInputTokens + input.maxOutputTokens} tokens / ${toDecimal(input.maxCostAmount)} for attempt ${input.attemptId}`,
      );
    }
    await insertReservationRow(execute, {
      reservationId,
      runId: input.runId,
      attemptId: input.attemptId,
      kind: "task",
      llmCalls: input.maxLlmCalls,
      inputTokens: input.maxInputTokens,
      outputTokens: input.maxOutputTokens,
      costAmount: input.maxCostAmount,
    });
    return {
      reservationId,
      runId: input.runId,
      attemptId: input.attemptId,
      kind: "task" as const,
      reservedLlmCalls: input.maxLlmCalls,
      reservedInputTokens: input.maxInputTokens,
      reservedOutputTokens: input.maxOutputTokens,
      reservedCostAmount: input.maxCostAmount,
    };
  });
}

/** 产品摘要预留：除预留身份与金额外携带服务端状态——恢复路径必须区分 reserved
 *  （可继续生成）与 settled/settled_unknown（摘要已结算，绝不再生成，按 D10 降级）。 */
export type ProductSummaryReservation = BudgetReservation & { status: ReservationStatus };

/**
 * 产品摘要份额独立预留（D9/D10：摘要调用、token、费用不与单元抢占，不能因单元超支静默跳过）。
 * 每 run 一次：summary_reserved 0→1 与余额判定在同一条件 UPDATE；已预留时幂等返回
 * 最新预留行的服务端状态（同一 reservationId），绝不双倍预留。最新行（id DESC）是唯一
 * 权威——旧的 released 行不得被错拿（fix round 3 / B）。
 */
export async function reserveProductSummaryBudget(runId: number): Promise<ProductSummaryReservation> {
  assertPositiveInt(runId, "runId");
  if (runId === 0) throw new Error("runId must be positive");
  const reservationId = randomUUID();
  const created = await withBudgetTransaction(async (execute) => {
    const affected = await applyLedgerReservation(execute, {
      runId,
      llmCalls: PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
      inputTokens: PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
      outputTokens: PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
      costAmount: PRODUCT_SUMMARY_RESERVED_COST_AMOUNT,
      summary: true,
    });
    if (affected !== 1) return null;
    await insertReservationRow(execute, {
      reservationId,
      runId,
      attemptId: PRODUCT_SUMMARY_ATTEMPT_ID,
      kind: "product_summary",
      llmCalls: PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
      inputTokens: PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
      outputTokens: PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
      costAmount: PRODUCT_SUMMARY_RESERVED_COST_AMOUNT,
    });
    return {
      reservationId,
      runId,
      attemptId: PRODUCT_SUMMARY_ATTEMPT_ID,
      kind: "product_summary" as const,
      reservedLlmCalls: PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
      reservedInputTokens: PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
      reservedCostAmount: PRODUCT_SUMMARY_RESERVED_COST_AMOUNT,
      status: "reserved" as const,
    };
  });
  if (created) return created;
  // 失败只有两种原因：已预留（幂等返回最新预留）或预算不足；summary_reserved 单调 0→1，读后判定无竞态。
  const [flagRows] = (await getDb().execute("SELECT summary_reserved FROM analysis_run_budgets WHERE run_id = ?", [
    runId,
  ])) as [Array<{ summary_reserved: unknown }>, unknown];
  if (flagRows.length > 0 && Number(flagRows[0].summary_reserved) === 1) {
    const [rows] = (await getDb().execute(
      `SELECT ${RESERVATION_COLUMNS} FROM analysis_behavior_budget_reservations WHERE run_id = ? AND kind = 'product_summary' ORDER BY id DESC LIMIT 1`,
      [runId],
    )) as [ReservationRow[], unknown];
    if (rows.length > 0) {
      const parsed = parseReservationRow(rows[0]);
      return { ...toBudgetReservation(parsed), status: parsed.status };
    }
  }
  throw new BehaviorBudgetError(
    "behavior_budget_exceeded",
    `run ${runId} behavior budget cannot cover the product summary reservation of ${PRODUCT_SUMMARY_RESERVED_LLM_CALLS} llm call / ${PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS + PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS} tokens / ${toDecimal(PRODUCT_SUMMARY_RESERVED_COST_AMOUNT)}`,
  );
}

interface BudgetConfig {
  callsCapConfigured: boolean;
  tokenCapConfigured: boolean;
  costCapConfigured: boolean;
}

/**
 * 读取 run 的硬上限配置。无上限 sentinel 的判等必须在数据库侧完成（Critical N）：
 * max_total_tokens 是 BIGINT UNSIGNED，其最大值 18446744073709551615 超出 JS 安全整数，
 * mysql2 默认读回为舍入值（18446744073709552000）——在 JS 侧做字符串/数值比较会把
 * "无上限"误判为"已配置上限"，导致一切 usage unknown 的结算都抛出并永久阻断派发。
 */
async function loadBudgetConfig(execute: Execute, runId: number): Promise<BudgetConfig | null> {
  // sentinel 判等用内联字面量（同 applyLedgerReservation：绑定参数跨预编译协议判等失效）
  const [rows] = (await execute(
    `SELECT (max_llm_calls = ${UNLIMITED_MAX_LLM_CALLS}) AS calls_uncapped,
            (max_total_tokens = ${UNLIMITED_MAX_TOTAL_TOKENS}) AS tokens_uncapped,
            (max_cost_amount = ${UNLIMITED_MAX_COST_AMOUNT}) AS cost_uncapped
       FROM analysis_run_budgets WHERE run_id = ?`,
    [runId],
  )) as [Array<{ calls_uncapped: unknown; tokens_uncapped: unknown; cost_uncapped: unknown }>, unknown];
  const row = rows[0];
  if (!row) return null;
  return {
    callsCapConfigured: Number(row.calls_uncapped) !== 1,
    tokenCapConfigured: Number(row.tokens_uncapped) !== 1,
    costCapConfigured: Number(row.cost_uncapped) !== 1,
  };
}

/**
 * 任务终态结算：短事务内锁定该预留自身状态行（身份与金额以服务端为准），
 * 按 attempt 回执聚实际消耗，整笔预留转出、实际转入 settled（未发生部分随之释放）。
 * 重复结算（含崩溃重试）是真 no-op——已 settled 的预留绝不再动账本，与后续新预留无关；
 * 首次结算为 settled_unknown（有维度未知）时，重试继续抛 behavior_budget_usage_unknown，
 * 停止派发信号不随重试丢失。已 released 的预留结算视为编排缺陷，抛 behavior_budget_exceeded。
 * 未知维度（含 I1：0 回执的调用次数）按预留上界保守入账，绝不按零；实际超过预留不截断。
 */
export async function settleBehaviorBudget(input: BudgetSettlementInput): Promise<void> {
  const usageUnknown = await withBudgetTransaction(async (execute) => {
    const reservation = await lockReservation(execute, input.reservationId);
    if (!reservation) {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${input.reservationId} does not exist; refusing to settle`,
      );
    }
    if (reservation.status === "settled") return null;
    if (reservation.status === "settled_unknown") return "duplicate";
    if (reservation.status === "released") {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${input.reservationId} was already released; refusing to settle a released reservation`,
      );
    }
    const usage = await loadAttemptLlmUsage(reservation.runId, reservation.attemptId);
    // 逐维度结算：已知按实际，未知按预留上界（未知 ≠ 零；I1：0 回执时调用次数同样未知）。
    const callsUnknown = usage.llmCalls === 0;
    const settledCalls = callsUnknown ? reservation.llmCalls : usage.llmCalls;
    const tokensUnknown = usage.inputTokens === null || usage.outputTokens === null;
    const settledInput = usage.inputTokens ?? reservation.inputTokens;
    const settledOutput = usage.outputTokens ?? reservation.outputTokens;
    const costUnknown = usage.costAmount === null;
    const settledCost = usage.costAmount ?? reservation.costAmount;
    const anyUnknown = callsUnknown || tokensUnknown || costUnknown;

    const transitioned = await applyLedgerUpdate(
      execute,
      `UPDATE analysis_behavior_budget_reservations
          SET status = ?, settled_at = NOW(3)
        WHERE reservation_uuid = ? AND status = 'reserved'`,
      [anyUnknown ? "settled_unknown" : "settled", reservation.reservationId],
    );
    if (transitioned !== 1) {
      // 行锁下状态已核对为 reserved，转移必然成功；失败即并发/数据异常，回滚抛错。
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${input.reservationId} transitioned concurrently; refusing to settle`,
      );
    }
    await applyLedgerUpdate(
      execute,
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
        WHERE run_id = ?`,
      [
        reservation.llmCalls,
        reservation.inputTokens,
        reservation.outputTokens,
        toDecimal(reservation.costAmount),
        settledCalls,
        settledInput,
        settledOutput,
        toDecimal(settledCost),
        reservation.runId,
      ],
    );
    const config = await loadBudgetConfig(execute, reservation.runId);
    if (!config) {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `run ${reservation.runId} has no behavior budget row; cannot settle reservation ${input.reservationId}`,
      );
    }
    const blocked = [
      callsUnknown && config.callsCapConfigured ? "llm call count" : null,
      tokensUnknown && config.tokenCapConfigured ? "token usage" : null,
      costUnknown && config.costCapConfigured ? "cost" : null,
    ].filter(Boolean);
    return blocked.length > 0
      ? `run ${reservation.runId} attempt ${reservation.attemptId} settled with unknown ${blocked.join(" and ")} under a configured hard cap; unknown usage was accounted at the reserved upper bound, not zero — stop dispatching new tasks`
      : null;
  });
  if (usageUnknown === "duplicate") {
    throw new BehaviorBudgetError(
      "behavior_budget_usage_unknown",
      `behavior budget reservation ${input.reservationId} was already settled with unknown usage under a configured hard cap; dispatch remains blocked`,
    );
  }
  if (usageUnknown !== null) {
    throw new BehaviorBudgetError("behavior_budget_usage_unknown", usageUnknown);
  }
}

/**
 * 释放从未消耗即放弃的预留（领取租约失败 / 摘要首次 LLM 调用前的编排退出路径）：短事务内
 * 验证并转移该预留自身状态，同事务把整笔预留从聚合账本转回。kind=product_summary 的释放
 * 在同一事务内复位 summary_reserved = 0（fix round 2：不复位则摘要份额永久泄漏）。
 * 重复释放（含崩溃重试）是真 no-op——绝不因后续新 attempt 取得预留而误释放他人份额。
 * 已结算的预留再走释放视为编排缺陷，抛 behavior_budget_exceeded。
 */
export async function releaseUnusedBehaviorBudget(reservationId: string): Promise<void> {
  await withBudgetTransaction(async (execute) => {
    const reservation = await lockReservation(execute, reservationId);
    if (!reservation) {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${reservationId} does not exist; refusing to release`,
      );
    }
    if (reservation.status === "released") return;
    if (reservation.status === "settled" || reservation.status === "settled_unknown") {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${reservationId} was already settled; refusing to release a settled reservation`,
      );
    }
    const transitioned = await applyLedgerUpdate(
      execute,
      `UPDATE analysis_behavior_budget_reservations
          SET status = 'released', released_at = NOW(3)
        WHERE reservation_uuid = ? AND status = 'reserved'`,
      [reservation.reservationId],
    );
    if (transitioned !== 1) {
      throw new BehaviorBudgetError(
        "behavior_budget_exceeded",
        `behavior budget reservation ${reservationId} transitioned concurrently; refusing to release`,
      );
    }
    // kind=product_summary：summary_reserved 复位必须与预留状态转移在同一事务（fix round 2）
    const summaryReset = reservation.kind === "product_summary" ? ", summary_reserved = 0" : "";
    await applyLedgerUpdate(
      execute,
      `UPDATE analysis_run_budgets
          SET reserved_llm_calls = reserved_llm_calls - ?,
              reserved_input_tokens = reserved_input_tokens - ?,
              reserved_output_tokens = reserved_output_tokens - ?,
              reserved_cost_amount = reserved_cost_amount - ?${summaryReset},
              version = version + 1
        WHERE run_id = ?`,
      [
        reservation.llmCalls,
        reservation.inputTokens,
        reservation.outputTokens,
        toDecimal(reservation.costAmount),
        reservation.runId,
      ],
    );
  });
}

export interface OrphanReservationReconcileResult {
  /** 命中的孤儿预留数（run 内 kind=task、status=reserved 且创建时间不晚于截止线）。 */
  examined: number;
  /** 有 LLM 回执、已按回执结算的孤儿数。 */
  settled: number;
  /** 零回执（进程在任何 LLM 调用落账前崩溃）、已释放的孤儿数。 */
  released: number;
  /** 有孤儿在配置硬上限下用量未知：已按预留上界结算，调用方必须停止新的派发。 */
  usageUnknownBlocked: boolean;
}

/**
 * 崩溃恢复对账（fix round 3 / E）：进程崩溃会留下 status='reserved' 的任务预留，永远不结算，
 * 聚合计数随之永久泄漏（恢复重跑后预算被影子占用耗尽）。run 恢复时按创建时间截止线
 * （orphanBeforeMs，须排除本进程在途 attempt）扫描孤儿任务预留并逐笔了断：
 *  - 有回执 → 走与正常终态相同的结算路径（usage unknown 在配置硬上限下不抛出中断对账，
 *    仅置 usageUnknownBlocked，由编排层停止派发）；
 *  - 零回执 → 从未发生 LLM 调用，整笔释放。
 * 摘要份额（kind=product_summary）不在此列——它由 summary_reserved 标志位与 D10 降级路径管理。
 * 每行孤儿的状态转移仍由 settle/release 自身的行锁与状态谓词兜底，扫描与转移之间的竞态
 * 只会退化为 no-op 或显式错误，绝不双入账。
 */
export async function reconcileOrphanedTaskReservations(input: {
  runId: number;
  orphanBeforeMs: number;
}): Promise<OrphanReservationReconcileResult> {
  assertPositiveInt(input.runId, "runId");
  if (input.runId === 0) throw new Error("runId must be positive");
  if (!Number.isFinite(input.orphanBeforeMs)) {
    throw new Error(`orphanBeforeMs must be a finite epoch-ms number, got ${String(input.orphanBeforeMs)}`);
  }
  const [rows] = (await getDb().execute(
    `SELECT ${RESERVATION_COLUMNS} FROM analysis_behavior_budget_reservations
      WHERE run_id = ? AND kind = 'task' AND status = 'reserved' AND created_at <= FROM_UNIXTIME(? / 1000)
      ORDER BY id ASC`,
    [input.runId, input.orphanBeforeMs],
  )) as [ReservationRow[], unknown];
  const result: OrphanReservationReconcileResult = { examined: rows.length, settled: 0, released: 0, usageUnknownBlocked: false };
  for (const row of rows) {
    const reservation = parseReservationRow(row);
    const usage = await loadAttemptLlmUsage(reservation.runId, reservation.attemptId);
    if (usage.llmCalls > 0) {
      try {
        await settleBehaviorBudget({ reservationId: reservation.reservationId });
      } catch (error) {
        if (error instanceof BehaviorBudgetError && error.code === "behavior_budget_usage_unknown") {
          result.usageUnknownBlocked = true;
        } else {
          throw error;
        }
      }
      result.settled += 1;
    } else {
      await releaseUnusedBehaviorBudget(reservation.reservationId);
      result.released += 1;
    }
  }
  return result;
}

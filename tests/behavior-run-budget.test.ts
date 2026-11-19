import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAttemptLlmUsage } from "../lib/billing/cost-receipt";
import { getDb } from "../lib/db";
import {
  BehaviorBudgetError,
  PRODUCT_SUMMARY_ATTEMPT_ID,
  PRODUCT_SUMMARY_RESERVED_COST_AMOUNT,
  PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS,
  PRODUCT_SUMMARY_RESERVED_LLM_CALLS,
  PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS,
  releaseUnusedBehaviorBudget,
  reserveBehaviorBudget,
  reserveProductSummaryBudget,
  settleBehaviorBudget,
  UNLIMITED_MAX_COST_AMOUNT,
  UNLIMITED_MAX_LLM_CALLS,
  UNLIMITED_MAX_TOTAL_TOKENS,
  type BudgetReservation,
} from "../lib/behavior-run-budget";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

/** Task 7 契约（2026-11-19 行为清单全量分析，D9）：analysis_run_budgets 共享预算账本。
 *  maxLlmCalls 严格原子预留；token/费用按上界预留、真实回执结算；任务终态释放未发生部分；
 *  旧 attempt 预留在结算或租约回收前保持占用；usage/费用未知不得按零放行（硬门禁）。 */

const COST_MICROS = 1_000_000;

interface FakeBudgetRow {
  run_id: number;
  max_llm_calls: number;
  max_total_tokens: string;
  max_cost_amount: string;
  currency: string;
  reserved_llm_calls: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reserved_cost_micros: number;
  settled_llm_calls: number;
  settled_input_tokens: number;
  settled_output_tokens: number;
  settled_cost_micros: number;
  summary_reserved: 0 | 1;
  version: number;
}

interface FakeReceiptRow {
  run_id: number;
  attempt_id: string | null;
  usage_status: string;
  pricing_status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  llm_cost_amount: string | null;
}

function toMicros(value: unknown): number {
  return Math.round(Number(value) * COST_MICROS);
}

function fromMicros(micros: number): number {
  return micros / COST_MICROS;
}

function budgetRow(overrides: Partial<FakeBudgetRow> = {}): FakeBudgetRow {
  return {
    run_id: 42,
    max_llm_calls: UNLIMITED_MAX_LLM_CALLS,
    max_total_tokens: UNLIMITED_MAX_TOTAL_TOKENS,
    max_cost_amount: UNLIMITED_MAX_COST_AMOUNT,
    currency: "CNY",
    reserved_llm_calls: 0,
    reserved_input_tokens: 0,
    reserved_output_tokens: 0,
    reserved_cost_micros: 0,
    settled_llm_calls: 0,
    settled_input_tokens: 0,
    settled_output_tokens: 0,
    settled_cost_micros: 0,
    summary_reserved: 0,
    version: 0,
    ...overrides,
  };
}

/** 内存假表：只接受条件 UPDATE（余额谓词或 summary_reserved 谓词），按当前行状态在写入时
 *  判定 affectedRows——模拟 MySQL 原子条件更新；无条件写或 SELECT 余额一律 unrouted 报错。 */
function budgetDb(initial: FakeBudgetRow, receipts: FakeReceiptRow[] = []) {
  const row = initial;
  const execute = vi.fn(async (statement: string, parameters: Array<string | number | null>) => {
    const sql = String(statement).replace(/\s+/g, " ").trim();
    if (
      sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?") &&
      sql.includes("summary_reserved = 1")
    ) {
      // reserveProductSummaryBudget：summary_reserved 0→1 + 余额谓词，一次性完成。
      const [rCalls, rIn, rOut, rCost, runId, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit] =
        parameters;
      if (row.run_id !== Number(runId) || row.summary_reserved !== 0) return [{ affectedRows: 0 }];
      const fits =
        (Number(row.max_llm_calls) === Number(callsSentinel) ||
          row.settled_llm_calls + row.reserved_llm_calls + Number(rCallsFit) <= row.max_llm_calls) &&
        (String(row.max_total_tokens) === String(tokensSentinel) ||
          row.settled_input_tokens +
            row.reserved_input_tokens +
            row.settled_output_tokens +
            row.reserved_output_tokens +
            Number(rInOutFit) <=
            Number(row.max_total_tokens)) &&
        (String(row.max_cost_amount) === String(costSentinel) ||
          row.settled_cost_micros + row.reserved_cost_micros + toMicros(rCostFit) <= toMicros(row.max_cost_amount));
      if (!fits) return [{ affectedRows: 0 }];
      row.reserved_llm_calls += Number(rCalls);
      row.reserved_input_tokens += Number(rIn);
      row.reserved_output_tokens += Number(rOut);
      row.reserved_cost_micros += toMicros(rCost);
      row.summary_reserved = 1;
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?")) {
      // reserveBehaviorBudget：余额谓词条件 UPDATE。
      const [rCalls, rIn, rOut, rCost, runId, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit] =
        parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      const fits =
        (Number(row.max_llm_calls) === Number(callsSentinel) ||
          row.settled_llm_calls + row.reserved_llm_calls + Number(rCallsFit) <= row.max_llm_calls) &&
        (String(row.max_total_tokens) === String(tokensSentinel) ||
          row.settled_input_tokens +
            row.reserved_input_tokens +
            row.settled_output_tokens +
            row.reserved_output_tokens +
            Number(rInOutFit) <=
            Number(row.max_total_tokens)) &&
        (String(row.max_cost_amount) === String(costSentinel) ||
          row.settled_cost_micros + row.reserved_cost_micros + toMicros(rCostFit) <= toMicros(row.max_cost_amount));
      if (!fits) return [{ affectedRows: 0 }];
      row.reserved_llm_calls += Number(rCalls);
      row.reserved_input_tokens += Number(rIn);
      row.reserved_output_tokens += Number(rOut);
      row.reserved_cost_micros += toMicros(rCost);
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (
      sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?") &&
      sql.includes("settled_llm_calls = settled_llm_calls + ?")
    ) {
      // settleBehaviorBudget：整笔预留转出 + 实际消耗转入 settled，预留余额谓词防重复结算。
      const [rCalls, rIn, rOut, rCost, sCalls, sIn, sOut, sCost, runId, gCalls, gIn, gOut, gCost] = parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      const outstanding =
        row.reserved_llm_calls >= Number(gCalls) &&
        row.reserved_input_tokens >= Number(gIn) &&
        row.reserved_output_tokens >= Number(gOut) &&
        row.reserved_cost_micros >= toMicros(gCost);
      if (!outstanding) return [{ affectedRows: 0 }];
      row.reserved_llm_calls -= Number(rCalls);
      row.reserved_input_tokens -= Number(rIn);
      row.reserved_output_tokens -= Number(rOut);
      row.reserved_cost_micros -= toMicros(rCost);
      row.settled_llm_calls += Number(sCalls);
      row.settled_input_tokens += Number(sIn);
      row.settled_output_tokens += Number(sOut);
      row.settled_cost_micros += toMicros(sCost);
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?")) {
      // releaseUnusedBehaviorBudget：仅释放整笔未消耗预留（领取失败路径），余额谓词防重复释放。
      const [rCalls, rIn, rOut, rCost, runId, gCalls, gIn, gOut, gCost] = parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      const outstanding =
        row.reserved_llm_calls >= Number(gCalls) &&
        row.reserved_input_tokens >= Number(gIn) &&
        row.reserved_output_tokens >= Number(gOut) &&
        row.reserved_cost_micros >= toMicros(gCost);
      if (!outstanding) return [{ affectedRows: 0 }];
      row.reserved_llm_calls -= Number(rCalls);
      row.reserved_input_tokens -= Number(rIn);
      row.reserved_output_tokens -= Number(rOut);
      row.reserved_cost_micros -= toMicros(rCost);
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("SELECT max_llm_calls, max_total_tokens, max_cost_amount FROM analysis_run_budgets")) {
      return [
        row.run_id === Number(parameters[0])
          ? [
              {
                max_llm_calls: row.max_llm_calls,
                max_total_tokens: row.max_total_tokens,
                max_cost_amount: row.max_cost_amount,
              },
            ]
          : [],
      ];
    }
    if (sql.startsWith("SELECT summary_reserved FROM analysis_run_budgets")) {
      return [row.run_id === Number(parameters[0]) ? [{ summary_reserved: row.summary_reserved }] : []];
    }
    if (sql.includes("FROM llm_call_receipts")) {
      const [runId, attemptId] = parameters;
      return [
        receipts
          .filter((receipt) => receipt.run_id === Number(runId) && receipt.attempt_id === String(attemptId))
          .map((receipt) => ({
            usage_status: receipt.usage_status,
            pricing_status: receipt.pricing_status,
            input_tokens: receipt.input_tokens,
            output_tokens: receipt.output_tokens,
            llm_cost_amount: receipt.llm_cost_amount,
          })),
      ];
    }
    throw new Error(`unrouted sql: ${sql}`);
  });
  const statements = () => execute.mock.calls.map(([statement]) => String(statement));
  return { execute, row, statements };
}

function receipt(overrides: Partial<FakeReceiptRow> = {}): FakeReceiptRow {
  return {
    run_id: 42,
    attempt_id: "attempt-1",
    usage_status: "known",
    pricing_status: "priced",
    input_tokens: 100,
    output_tokens: 50,
    llm_cost_amount: "0.010000",
    ...overrides,
  };
}

function reservationInput(overrides: Partial<Parameters<typeof reserveBehaviorBudget>[0]> = {}) {
  return {
    runId: 42,
    attemptId: "attempt-1",
    maxLlmCalls: 2,
    maxInputTokens: 400,
    maxOutputTokens: 200,
    maxCostAmount: 0.5,
    ...overrides,
  };
}

function expectBudgetError(error: unknown, code: "behavior_budget_exceeded" | "behavior_budget_usage_unknown") {
  expect(error).toBeInstanceOf(BehaviorBudgetError);
  expect((error as BehaviorBudgetError).code).toBe(code);
}

const execute = vi.fn();

beforeEach(() => {
  execute.mockReset();
  vi.mocked(getDb).mockReturnValue({ execute } as never);
});

function stubDb(db: { execute: unknown }) {
  vi.mocked(getDb).mockReturnValue({ execute: db.execute } as never);
}

describe("reserveBehaviorBudget", () => {
  it("lets only one of three workers reserve when 3 calls remain and each task reserves 2", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 3 }));
    stubDb(db);
    const first = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    expect(first.runId).toBe(42);
    expect(first.attemptId).toBe("attempt-1");
    expect(first.reservedLlmCalls).toBe(2);
    expect(db.row.reserved_llm_calls).toBe(2);
    const second = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" })).catch((caught) => caught);
    expectBudgetError(second, "behavior_budget_exceeded");
    const third = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-3" })).catch((caught) => caught);
    expectBudgetError(third, "behavior_budget_exceeded");
    expect(db.row.reserved_llm_calls).toBe(2);
  });

  it("never reads balances before writing: reservation is a single conditional UPDATE", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 3 }));
    stubDb(db);
    await reserveBehaviorBudget(reservationInput());
    expect(db.statements()).toHaveLength(1);
    expect(db.statements()[0]).toMatch(/^UPDATE analysis_run_budgets/);
    expect(db.statements()[0]).toContain("reserved_llm_calls + ?");
  });

  it("reserves tokens and cost by upper bound against the combined token cap", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "1000", max_cost_amount: "1.000000" }));
    stubDb(db);
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const overTokens = await reserveBehaviorBudget(
      reservationInput({ attemptId: "attempt-2", maxInputTokens: 400, maxOutputTokens: 300 }),
    ).catch((caught) => caught);
    expectBudgetError(overTokens, "behavior_budget_exceeded");
    const overCost = await reserveBehaviorBudget(
      reservationInput({ attemptId: "attempt-3", maxInputTokens: 100, maxOutputTokens: 100, maxCostAmount: 0.6 }),
    ).catch((caught) => caught);
    expectBudgetError(overCost, "behavior_budget_exceeded");
    const fits = await reserveBehaviorBudget(
      reservationInput({ attemptId: "attempt-4", maxInputTokens: 200, maxOutputTokens: 200, maxCostAmount: 0.5 }),
    );
    expect(fits.reservationId).toBeTruthy();
    expect(db.row.reserved_input_tokens).toBe(600);
    expect(db.row.reserved_output_tokens).toBe(400);
    expect(fromMicros(db.row.reserved_cost_micros)).toBeCloseTo(1.0, 6);
  });

  it("keeps an expired task's old attempt reservation occupied when the retried attempt re-reserves", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 5 }));
    stubDb(db);
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-old" }));
    // 租约过期 → 新 attempt 重新检查并重新预留；旧预留未结算，必须继续占用。
    const retry = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-new" }));
    expect(retry.attemptId).toBe("attempt-new");
    expect(db.row.reserved_llm_calls).toBe(4);
    const third = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-third" })).catch(
      (caught) => caught,
    );
    expectBudgetError(third, "behavior_budget_exceeded");
    expect(db.row.reserved_llm_calls).toBe(4);
  });

  it("rejects non-positive or non-integer reservation amounts before touching the ledger", async () => {
    const db = budgetDb(budgetRow());
    stubDb(db);
    await expect(reserveBehaviorBudget(reservationInput({ maxLlmCalls: 0 }))).rejects.toThrow(/maxLlmCalls/);
    await expect(reserveBehaviorBudget(reservationInput({ maxInputTokens: -1 }))).rejects.toThrow(/maxInputTokens/);
    await expect(reserveBehaviorBudget(reservationInput({ maxCostAmount: Number.NaN }))).rejects.toThrow(
      /maxCostAmount/,
    );
    await expect(reserveBehaviorBudget(reservationInput({ attemptId: "" }))).rejects.toThrow(/attemptId/);
    expect(db.statements()).toHaveLength(0);
  });
});

describe("settleBehaviorBudget", () => {
  it("settles actual receipt usage and frees the unused reservation so another task can dispatch", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 3 }), [
      receipt({ attempt_id: "attempt-1", input_tokens: 120, output_tokens: 40, llm_cost_amount: "0.012000" }),
    ]);
    stubDb(db);
    const first = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await settleBehaviorBudget({ reservation: first });
    // 实际 1 次调用：预留 2 全部转出，settled 记 1，未发生的 1 次随之释放。
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(120);
    expect(db.row.settled_output_tokens).toBe(40);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.012, 6);
    const next = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    expect(next.reservedLlmCalls).toBe(2);
    expect(db.row.reserved_llm_calls).toBe(2);
  });

  it("records overshoot explicitly when actual calls exceed the reservation", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 2 }), [
      receipt({ attempt_id: "attempt-1" }),
      receipt({ attempt_id: "attempt-1" }),
      receipt({ attempt_id: "attempt-1" }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await settleBehaviorBudget({ reservation });
    // 超发不截断：settled 如实记 3（> max 2），占用归零，后续派发被预算谓词拒绝。
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(3);
    expect(db.row.settled_llm_calls).toBeGreaterThan(db.row.max_llm_calls);
    const blocked = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2", maxLlmCalls: 1 })).catch(
      (caught) => caught,
    );
    expectBudgetError(blocked, "behavior_budget_exceeded");
  });

  it("throws behavior_budget_usage_unknown and settles at the reserved bound when token usage is unknown under a configured token cap", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "10000" }), [
      receipt({ attempt_id: "attempt-1", usage_status: "unknown", input_tokens: null, output_tokens: null, llm_cost_amount: null, pricing_status: "priced" }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const error = await settleBehaviorBudget({ reservation }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    // 未知 ≠ 零：token 按预留上界入账（保守），调用次数按回执实记。
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.row.settled_output_tokens).toBe(200);
    expect(db.row.settled_input_tokens + db.row.settled_output_tokens).toBeGreaterThan(0);
  });

  it("throws behavior_budget_usage_unknown for zero-receipt attempts instead of counting zero usage", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "10000", max_cost_amount: "10.000000" }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-no-receipts" }));
    const error = await settleBehaviorBudget({ reservation }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    expect(db.row.settled_llm_calls).toBe(0);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("throws behavior_budget_usage_unknown when cost is unpriced under a configured cost cap", async () => {
    const db = budgetDb(budgetRow({ max_cost_amount: "10.000000" }), [
      receipt({ attempt_id: "attempt-1", pricing_status: "unpriced", llm_cost_amount: null }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const error = await settleBehaviorBudget({ reservation }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    // tokens 如实结算；费用按预留上界保守入账，不按零放行。
    expect(db.row.settled_input_tokens).toBe(100);
    expect(db.row.settled_output_tokens).toBe(50);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("settles unknown usage conservatively without throwing when no hard cap is configured", async () => {
    const db = budgetDb(budgetRow(), [
      receipt({ attempt_id: "attempt-1", usage_status: "unknown", input_tokens: null, output_tokens: null, llm_cost_amount: null, pricing_status: "unpriced" }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await expect(settleBehaviorBudget({ reservation })).resolves.toBeUndefined();
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.row.settled_output_tokens).toBe(200);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("rejects a repeated settlement of the same reservation", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 3 }), [receipt({ attempt_id: "attempt-1" })]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await settleBehaviorBudget({ reservation });
    const error = await settleBehaviorBudget({ reservation }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_exceeded");
    expect(db.row.settled_llm_calls).toBe(1);
  });
});

describe("mixed priced/unpriced receipts (Task 6 review follow-up)", () => {
  it("aggregates mixed receipts to unpriced with null cost, never partial or zero cost", async () => {
    const db = budgetDb(budgetRow(), [
      receipt({ attempt_id: "attempt-mix", pricing_status: "priced", llm_cost_amount: "0.010000" }),
      receipt({ attempt_id: "attempt-mix", pricing_status: "unpriced", llm_cost_amount: null }),
    ]);
    stubDb(db);
    const usage = await loadAttemptLlmUsage(42, "attempt-mix");
    expect(usage.llmCalls).toBe(2);
    expect(usage.pricingStatus).toBe("unpriced");
    expect(usage.costAmount).toBeNull();
    expect(usage.inputTokens).toBe(200);
    // 结算同样不得把混合成本当部分成本：费用按未知处理（预留上界保守入账）。
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-mix" }));
    await settleBehaviorBudget({ reservation });
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });
});

describe("releaseUnusedBehaviorBudget", () => {
  it("releases a never-consumed reservation when task claim fails, freeing the budget", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 2 }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    expect(db.row.reserved_llm_calls).toBe(2);
    await releaseUnusedBehaviorBudget(reservation.reservationId);
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.reserved_input_tokens).toBe(0);
    expect(fromMicros(db.row.reserved_cost_micros)).toBeCloseTo(0, 6);
    const next = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    expect(next.reservedLlmCalls).toBe(2);
  });

  it("is a no-op when the same release is issued twice", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 2 }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await releaseUnusedBehaviorBudget(reservation.reservationId);
    await expect(releaseUnusedBehaviorBudget(reservation.reservationId)).resolves.toBeUndefined();
    expect(db.row.reserved_llm_calls).toBe(0);
  });

  it("rejects malformed reservation ids without touching the ledger", async () => {
    const db = budgetDb(budgetRow());
    stubDb(db);
    await expect(releaseUnusedBehaviorBudget("not-a-reservation")).rejects.toThrow(/reservation/);
    expect(db.statements()).toHaveLength(0);
  });
});

describe("reserveProductSummaryBudget", () => {
  it("reserves the product summary share independently so unit reservations cannot consume it", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }));
    stubDb(db);
    const summary = await reserveProductSummaryBudget(42);
    expect(summary.attemptId).toBe(PRODUCT_SUMMARY_ATTEMPT_ID);
    expect(summary.reservedLlmCalls).toBe(PRODUCT_SUMMARY_RESERVED_LLM_CALLS);
    expect(summary.reservedInputTokens).toBe(PRODUCT_SUMMARY_RESERVED_INPUT_TOKENS);
    expect(summary.reservedOutputTokens).toBe(PRODUCT_SUMMARY_RESERVED_OUTPUT_TOKENS);
    expect(summary.reservedCostAmount).toBe(PRODUCT_SUMMARY_RESERVED_COST_AMOUNT);
    expect(db.row.summary_reserved).toBe(1);
    // 剩余 3 次归单元：单元要 4 次被拒，要 3 次可预留——摘要份额不被抢占。
    const tooMuch = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1", maxLlmCalls: 4 })).catch(
      (caught) => caught,
    );
    expectBudgetError(tooMuch, "behavior_budget_exceeded");
    const fits = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1", maxLlmCalls: 3 }));
    expect(fits.reservedLlmCalls).toBe(3);
  });

  it("is idempotent per run: a repeated summary reservation does not double-reserve", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }));
    stubDb(db);
    const first = await reserveProductSummaryBudget(42);
    const second = await reserveProductSummaryBudget(42);
    expect(second.reservationId).toBe(first.reservationId);
    expect(db.row.reserved_llm_calls).toBe(PRODUCT_SUMMARY_RESERVED_LLM_CALLS);
    expect(db.row.version).toBe(1);
  });

  it("fails with behavior_budget_exceeded when the budget cannot cover the summary share", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 1, settled_llm_calls: 1 }));
    stubDb(db);
    const error = await reserveProductSummaryBudget(42).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_exceeded");
    expect(db.row.summary_reserved).toBe(0);
  });

  it("settles the summary reservation through the same receipt-based path", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }), [
      receipt({ attempt_id: PRODUCT_SUMMARY_ATTEMPT_ID, input_tokens: 5000, output_tokens: 800, llm_cost_amount: "0.200000" }),
    ]);
    stubDb(db);
    const summary = await reserveProductSummaryBudget(42);
    await settleBehaviorBudget({ reservation: summary });
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(5000);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.2, 6);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
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
  reconcileOrphanedTaskReservations,
  releaseUnusedBehaviorBudget,
  reserveBehaviorBudget,
  reserveProductSummaryBudget,
  settleBehaviorBudget,
  UNLIMITED_MAX_COST_AMOUNT,
  UNLIMITED_MAX_LLM_CALLS,
  UNLIMITED_MAX_TOTAL_TOKENS,
} from "../lib/behavior-run-budget";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

/** Task 7 契约（2026-11-19 行为清单全量分析，D9）：analysis_run_budgets 共享预算账本 +
 *  analysis_behavior_budget_reservations 逐尝试预留状态（fix round 1，C1/I1）。
 *  预留状态行是身份与金额的唯一权威；settle/release 在短事务内验证并转移该预留自身状态，
 *  重复 settle/release 是真 no-op，不受后续新预留影响；0 回执的调用次数按预留上界入账，
 *  配置 calls 硬上限时抛 behavior_budget_usage_unknown，绝不按零释放。 */

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

interface FakeReservationRow {
  id: number;
  reservation_uuid: string;
  run_id: number;
  attempt_id: string;
  kind: string;
  reserved_llm_calls: number;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reserved_cost_micros: number;
  status: string;
  /** 简化模型：epoch 毫秒（真实表为 DATETIME(3)，对账按创建时间划定孤儿截止线）。 */
  created_at_ms: number;
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

/** 内存假表：账本只接受条件 UPDATE（reserve）或事务内与预留状态转移配套的 ledger UPDATE
 *  （settle/release）；预留状态行模拟 InnoDB 行锁语义——SELECT ... FOR UPDATE 读取当前状态，
 *  状态转移 UPDATE 带 status='reserved' 谓词，重复转移 affectedRows=0。 */
function budgetDb(initial: FakeBudgetRow, receipts: FakeReceiptRow[] = []) {
  const row = initial;
  const reservations: FakeReservationRow[] = [];
  let nextReservationId = 1;

  const router = async (statement: string, parameters: Array<string | number | null>) => {
    const sql = String(statement).replace(/\s+/g, " ").trim();
    if (
      sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?") &&
      sql.includes("summary_reserved = 1")
    ) {
      const [rCalls, rIn, rOut, rCost, runId, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit] =
        parameters;
      if (row.run_id !== Number(runId) || row.summary_reserved !== 0) return [{ affectedRows: 0 }];
      if (!fits(row, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit)) {
        return [{ affectedRows: 0 }];
      }
      row.reserved_llm_calls += Number(rCalls);
      row.reserved_input_tokens += Number(rIn);
      row.reserved_output_tokens += Number(rOut);
      row.reserved_cost_micros += toMicros(rCost);
      row.summary_reserved = 1;
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?")) {
      const [rCalls, rIn, rOut, rCost, runId, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit] =
        parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      if (!fits(row, callsSentinel, rCallsFit, tokensSentinel, rInOutFit, costSentinel, rCostFit)) {
        return [{ affectedRows: 0 }];
      }
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
      const [rCalls, rIn, rOut, rCost, sCalls, sIn, sOut, sCost, runId] = parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
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
    if (
      sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?") &&
      sql.includes("summary_reserved = 0")
    ) {
      const [rCalls, rIn, rOut, rCost, runId] = parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      row.reserved_llm_calls -= Number(rCalls);
      row.reserved_input_tokens -= Number(rIn);
      row.reserved_output_tokens -= Number(rOut);
      row.reserved_cost_micros -= toMicros(rCost);
      row.summary_reserved = 0;
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?")) {
      const [rCalls, rIn, rOut, rCost, runId] = parameters;
      if (row.run_id !== Number(runId)) return [{ affectedRows: 0 }];
      row.reserved_llm_calls -= Number(rCalls);
      row.reserved_input_tokens -= Number(rIn);
      row.reserved_output_tokens -= Number(rOut);
      row.reserved_cost_micros -= toMicros(rCost);
      row.version += 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("INSERT INTO analysis_behavior_budget_reservations")) {
      const [uuid, runId, attemptId, kind, rCalls, rIn, rOut, rCost] = parameters;
      if (reservations.some((reservation) => reservation.reservation_uuid === String(uuid))) {
        const error = new Error(`Duplicate entry '${String(uuid)}'`) as Error & { code?: string };
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      reservations.push({
        id: nextReservationId++,
        reservation_uuid: String(uuid),
        run_id: Number(runId),
        attempt_id: String(attemptId),
        kind: String(kind),
        reserved_llm_calls: Number(rCalls),
        reserved_input_tokens: Number(rIn),
        reserved_output_tokens: Number(rOut),
        reserved_cost_micros: toMicros(rCost),
        status: "reserved",
        created_at_ms: Date.now(),
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("FROM analysis_behavior_budget_reservations WHERE reservation_uuid = ? FOR UPDATE")) {
      const found = reservations.find((reservation) => reservation.reservation_uuid === String(parameters[0]));
      return [found ? [serializeReservation(found)] : []];
    }
    if (
      sql.startsWith("UPDATE analysis_behavior_budget_reservations SET status = ?") &&
      sql.includes("settled_at")
    ) {
      const [status, uuid] = parameters;
      const found = reservations.find((reservation) => reservation.reservation_uuid === String(uuid));
      if (!found || found.status !== "reserved") return [{ affectedRows: 0 }];
      found.status = String(status);
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE analysis_behavior_budget_reservations SET status = 'released'")) {
      const [uuid] = parameters;
      const found = reservations.find((reservation) => reservation.reservation_uuid === String(uuid));
      if (!found || found.status !== "reserved") return [{ affectedRows: 0 }];
      found.status = "released";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("FROM analysis_behavior_budget_reservations WHERE run_id = ? AND kind = 'product_summary'")) {
      const matched = reservations
        .filter((reservation) => reservation.run_id === Number(parameters[0]) && reservation.kind === "product_summary")
        .map(serializeReservation);
      // ORDER BY id DESC LIMIT 1：idempotent 读取只认最新一行（旧的 released 行不得被错拿）。
      if (sql.includes("ORDER BY id DESC")) {
        matched.sort((left, right) => Number(right.id) - Number(left.id));
        return [matched.slice(0, 1)];
      }
      return [matched];
    }
    if (
      sql.includes("FROM analysis_behavior_budget_reservations WHERE run_id = ? AND kind = 'task' AND status = 'reserved'")
    ) {
      const cutoffMs = Number(parameters[1]);
      return [
        reservations
          .filter(
            (reservation) =>
              reservation.run_id === Number(parameters[0]) &&
              reservation.kind === "task" &&
              reservation.status === "reserved" &&
              reservation.created_at_ms <= cutoffMs,
          )
          .map(serializeReservation),
      ];
    }
    if (sql.startsWith("SELECT (max_llm_calls = ?)")) {
      // 数据库侧精确比较无上限 sentinel（修复 Critical N：sentinel 判等绝不经 JS 读回值）。
      const [callsSentinel, tokensSentinel, costSentinel, runId] = parameters;
      if (row.run_id !== Number(runId)) return [[]];
      return [
        [
          {
            calls_uncapped: Number(row.max_llm_calls) === Number(callsSentinel) ? 1 : 0,
            tokens_uncapped: String(row.max_total_tokens) === String(tokensSentinel) ? 1 : 0,
            cost_uncapped: String(row.max_cost_amount) === String(costSentinel) ? 1 : 0,
          },
        ],
      ];
    }
    if (sql.startsWith("SELECT max_llm_calls, max_total_tokens, max_cost_amount FROM analysis_run_budgets")) {
      // 模拟 mysql2 默认读回行为：BIGINT UNSIGNED 最大值超出安全整数后被舍入
      // （Number("18446744073709551615") === 18446744073709552000）。修复后代码不得再发这条 SELECT。
      return [
        row.run_id === Number(parameters[0])
          ? [{ max_llm_calls: row.max_llm_calls, max_total_tokens: Number(row.max_total_tokens), max_cost_amount: row.max_cost_amount }]
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
  };

  const statements: string[] = [];
  const execute = vi.fn(async (statement: string, parameters: Array<string | number | null>) => {
    statements.push(String(statement).replace(/\s+/g, " ").trim());
    return router(statement, parameters);
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
  };
  return {
    connection,
    row,
    reservations: () => reservations,
    statements: () => statements,
  };
}

function fits(
  row: FakeBudgetRow,
  callsSentinel: unknown,
  rCallsFit: unknown,
  tokensSentinel: unknown,
  rInOutFit: unknown,
  costSentinel: unknown,
  rCostFit: unknown,
): boolean {
  return (
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
      row.settled_cost_micros + row.reserved_cost_micros + toMicros(rCostFit) <= toMicros(row.max_cost_amount))
  );
}

function serializeReservation(found: FakeReservationRow) {
  return {
    id: found.id,
    reservation_uuid: found.reservation_uuid,
    run_id: found.run_id,
    attempt_id: found.attempt_id,
    kind: found.kind,
    reserved_llm_calls: found.reserved_llm_calls,
    reserved_input_tokens: found.reserved_input_tokens,
    reserved_output_tokens: found.reserved_output_tokens,
    reserved_cost_amount: fromMicros(found.reserved_cost_micros).toFixed(6),
    status: found.status,
  };
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

beforeEach(() => {
  vi.clearAllMocks();
});

function stubDb(db: { connection: unknown }) {
  vi.mocked(getDb).mockReturnValue({
    getConnection: async () => db.connection,
    execute: (db.connection as { execute: unknown }).execute,
  } as never);
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
    expect(db.reservations()).toHaveLength(1);
    expect(db.reservations()[0]).toMatchObject({ run_id: 42, attempt_id: "attempt-1", kind: "task", status: "reserved" });
    const second = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" })).catch((caught) => caught);
    expectBudgetError(second, "behavior_budget_exceeded");
    const third = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-3" })).catch((caught) => caught);
    expectBudgetError(third, "behavior_budget_exceeded");
    expect(db.row.reserved_llm_calls).toBe(2);
    expect(db.reservations()).toHaveLength(1);
    expect(db.connection.rollback).toHaveBeenCalled();
  });

  it("keeps the atomic balance check inside the reserve conditional UPDATE (no balance SELECT)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 3 }));
    stubDb(db);
    await reserveBehaviorBudget(reservationInput());
    const balanceSelects = db
      .statements()
      .filter((statement) => /^SELECT/.test(statement) && /reserved_llm_calls|settled_llm_calls/.test(statement));
    expect(balanceSelects).toHaveLength(0);
    const reserveUpdate = db
      .statements()
      .find((statement) => statement.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?"));
    expect(reserveUpdate).toBeDefined();
    expect(reserveUpdate).toContain("OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls");
    expect(db.connection.beginTransaction).toHaveBeenCalled();
    expect(db.connection.commit).toHaveBeenCalled();
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
    const fitsReservation = await reserveBehaviorBudget(
      reservationInput({ attemptId: "attempt-4", maxInputTokens: 200, maxOutputTokens: 200, maxCostAmount: 0.5 }),
    );
    expect(fitsReservation.reservationId).toBeTruthy();
    expect(db.row.reserved_input_tokens).toBe(600);
    expect(db.row.reserved_output_tokens).toBe(400);
    expect(fromMicros(db.row.reserved_cost_micros)).toBeCloseTo(1.0, 6);
  });

  it("keeps an expired task's old attempt reservation occupied when the retried attempt re-reserves", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 5 }));
    stubDb(db);
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-old" }));
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
    await settleBehaviorBudget({ reservationId: first.reservationId });
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(120);
    expect(db.row.settled_output_tokens).toBe(40);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.012, 6);
    expect(db.reservations()[0].status).toBe("settled");
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
    await settleBehaviorBudget({ reservationId: reservation.reservationId });
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
      receipt({
        attempt_id: "attempt-1",
        usage_status: "unknown",
        input_tokens: null,
        output_tokens: null,
        llm_cost_amount: null,
        pricing_status: "priced",
      }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const error = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.row.settled_output_tokens).toBe(200);
    expect(db.reservations()[0].status).toBe("settled_unknown");
  });

  it("books reserved calls and cost at the bound for zero-receipt attempts instead of counting zero usage", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "10000", max_cost_amount: "10.000000" }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-no-receipts" }));
    const error = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    // I1：缺回执 ≠ 零——调用次数按预留上界入账，不按 0 释放。
    expect(db.row.settled_llm_calls).toBe(2);
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
    expect(db.reservations()[0].status).toBe("settled_unknown");
  });

  it("books reserved calls and blocks dispatch for a calls-only cap when receipts are missing (I1)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 2 }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const error = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    expect(db.row.settled_llm_calls).toBe(2);
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.reservations()[0].status).toBe("settled_unknown");
    const blocked = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2", maxLlmCalls: 1 })).catch(
      (caught) => caught,
    );
    expectBudgetError(blocked, "behavior_budget_exceeded");
  });

  it("books zero-receipt calls at the bound without throwing when no hard cap is configured (I1)", async () => {
    const db = budgetDb(budgetRow());
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await expect(settleBehaviorBudget({ reservationId: reservation.reservationId })).resolves.toBeUndefined();
    expect(db.row.settled_llm_calls).toBe(2);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("throws behavior_budget_usage_unknown when cost is unpriced under a configured cost cap", async () => {
    const db = budgetDb(budgetRow({ max_cost_amount: "10.000000" }), [
      receipt({ attempt_id: "attempt-1", pricing_status: "unpriced", llm_cost_amount: null }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const error = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_usage_unknown");
    expect(db.row.settled_input_tokens).toBe(100);
    expect(db.row.settled_output_tokens).toBe(50);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("settles unknown usage conservatively without throwing when no hard cap is configured", async () => {
    const db = budgetDb(budgetRow(), [
      receipt({
        attempt_id: "attempt-1",
        usage_status: "unknown",
        input_tokens: null,
        output_tokens: null,
        llm_cost_amount: null,
        pricing_status: "unpriced",
      }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await expect(settleBehaviorBudget({ reservationId: reservation.reservationId })).resolves.toBeUndefined();
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.row.settled_output_tokens).toBe(200);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.5, 6);
  });

  it("treats a crash-retry duplicate settle as a true no-op that never drains a newer reservation (C1)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 5 }), [
      receipt({ attempt_id: "attempt-1" }),
      receipt({ attempt_id: "attempt-2", input_tokens: 300, output_tokens: 90, llm_cost_amount: "0.030000" }),
    ]);
    stubDb(db);
    const first = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await settleBehaviorBudget({ reservationId: first.reservationId });
    expect(db.row.settled_llm_calls).toBe(1);
    // crash：调用方未记录结算完成；期间第二个任务取得新预留。
    const second = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    expect(db.row.reserved_llm_calls).toBe(2);
    // retry：R1 已 settled → 真 no-op，不得二次入账、不得动 R2 的预留。
    await expect(settleBehaviorBudget({ reservationId: first.reservationId })).resolves.toBeUndefined();
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.reserved_llm_calls).toBe(2);
    expect(db.reservations().find((reservation) => reservation.reservation_uuid === second.reservationId)?.status).toBe(
      "reserved",
    );
    // R2 仍可正常结算。
    await settleBehaviorBudget({ reservationId: second.reservationId });
    expect(db.row.settled_llm_calls).toBe(2);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.row.reserved_llm_calls).toBe(0);
  });

  it("re-throws behavior_budget_usage_unknown on a retried settle of an unknown-usage settlement", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "10000" }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    const first = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(first, "behavior_budget_usage_unknown");
    const retry = await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch((caught) => caught);
    expectBudgetError(retry, "behavior_budget_usage_unknown");
    expect(db.row.settled_llm_calls).toBe(2);
  });

  it("rejects settlement of an unknown reservation id", async () => {
    const db = budgetDb(budgetRow());
    stubDb(db);
    const error = await settleBehaviorBudget({ reservationId: "00000000-0000-0000-0000-000000000000" }).catch(
      (caught) => caught,
    );
    expectBudgetError(error, "behavior_budget_exceeded");
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
    const reservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-mix" }));
    await settleBehaviorBudget({ reservationId: reservation.reservationId });
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
    expect(db.reservations()[0].status).toBe("released");
    const next = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    expect(next.reservedLlmCalls).toBe(2);
  });

  it("keeps a newer attempt's reservation intact when a duplicate release arrives late (C1)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }));
    stubDb(db);
    const first = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await releaseUnusedBehaviorBudget(first.reservationId);
    expect(db.row.reserved_llm_calls).toBe(0);
    // crash：调用方未记录释放完成；期间新 attempt 取得新预留。
    const second = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    expect(db.row.reserved_llm_calls).toBe(2);
    // retry：重复释放是真 no-op，不得释放 R2 的预留（否则 maxLlmCalls 可被超发）。
    await expect(releaseUnusedBehaviorBudget(first.reservationId)).resolves.toBeUndefined();
    expect(db.row.reserved_llm_calls).toBe(2);
    expect(db.reservations().find((reservation) => reservation.reservation_uuid === second.reservationId)?.status).toBe(
      "reserved",
    );
  });

  it("rejects release of an unknown reservation id", async () => {
    const db = budgetDb(budgetRow());
    stubDb(db);
    const error = await releaseUnusedBehaviorBudget("00000000-0000-0000-0000-000000000000").catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_exceeded");
    expect(db.statements().filter((statement) => statement.startsWith("UPDATE analysis_run_budgets"))).toHaveLength(0);
  });

  it("resets summary_reserved in the same transaction when releasing a product_summary reservation", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }));
    stubDb(db);
    const summary = await reserveProductSummaryBudget(42);
    expect(db.row.summary_reserved).toBe(1);
    const commitsBefore = db.connection.commit.mock.calls.length;
    await releaseUnusedBehaviorBudget(summary.reservationId);
    expect(db.row.summary_reserved).toBe(0);
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(fromMicros(db.row.reserved_cost_micros)).toBeCloseTo(0, 6);
    expect(db.reservations()[0].status).toBe("released");
    // 复位与预留状态转移在同一个短事务内提交（release 自身只多一次 commit）
    expect(db.connection.commit.mock.calls.length).toBe(commitsBefore + 1);
    const ledgerUpdate = db
      .statements()
      .find(
        (statement) =>
          statement.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?") &&
          statement.includes("summary_reserved = 0"),
      );
    expect(ledgerUpdate).toBeDefined();
    // 复位后允许重新预留：下一次激活尝试不被泄漏的摘要份额阻断
    const again = await reserveProductSummaryBudget(42);
    expect(again.reservationId).not.toBe(summary.reservationId);
    expect(db.row.summary_reserved).toBe(1);
  });

  it("does not touch summary_reserved when releasing a task reservation", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 6 }));
    stubDb(db);
    await reserveProductSummaryBudget(42);
    const task = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await releaseUnusedBehaviorBudget(task.reservationId);
    expect(db.row.summary_reserved).toBe(1);
    expect(db.row.reserved_llm_calls).toBe(PRODUCT_SUMMARY_RESERVED_LLM_CALLS);
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
    expect(db.reservations()[0]).toMatchObject({ kind: "product_summary", attempt_id: PRODUCT_SUMMARY_ATTEMPT_ID });
    const tooMuch = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1", maxLlmCalls: 4 })).catch(
      (caught) => caught,
    );
    expectBudgetError(tooMuch, "behavior_budget_exceeded");
    const fitsReservation = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1", maxLlmCalls: 3 }));
    expect(fitsReservation.reservedLlmCalls).toBe(3);
  });

  it("is idempotent per run: a repeated summary reservation returns the same reservation without double-reserving", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }));
    stubDb(db);
    const first = await reserveProductSummaryBudget(42);
    const second = await reserveProductSummaryBudget(42);
    expect(second.reservationId).toBe(first.reservationId);
    expect(db.row.reserved_llm_calls).toBe(PRODUCT_SUMMARY_RESERVED_LLM_CALLS);
    expect(db.row.version).toBe(1);
    expect(db.reservations()).toHaveLength(1);
  });

  it("fails with behavior_budget_exceeded when the budget cannot cover the summary share", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 1, settled_llm_calls: 1 }));
    stubDb(db);
    const error = await reserveProductSummaryBudget(42).catch((caught) => caught);
    expectBudgetError(error, "behavior_budget_exceeded");
    expect(db.row.summary_reserved).toBe(0);
    expect(db.reservations()).toHaveLength(0);
  });

  it("settles the summary reservation through the same receipt-based path", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }), [
      receipt({ attempt_id: PRODUCT_SUMMARY_ATTEMPT_ID, input_tokens: 5000, output_tokens: 800, llm_cost_amount: "0.200000" }),
    ]);
    stubDb(db);
    const summary = await reserveProductSummaryBudget(42);
    await settleBehaviorBudget({ reservationId: summary.reservationId });
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(5000);
    expect(fromMicros(db.row.settled_cost_micros)).toBeCloseTo(0.2, 6);
  });

  it("exposes the settled status on an idempotent re-reserve so recovery never regenerates a settled summary (B)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 4 }), [receipt({ attempt_id: PRODUCT_SUMMARY_ATTEMPT_ID })]);
    stubDb(db);
    const first = await reserveProductSummaryBudget(42);
    expect(first.status).toBe("reserved");
    await settleBehaviorBudget({ reservationId: first.reservationId });
    const again = await reserveProductSummaryBudget(42);
    expect(again.reservationId).toBe(first.reservationId);
    expect(again.status).toBe("settled");
    expect(db.reservations()).toHaveLength(1);
  });

  it("returns the latest live reservation, not an older released row, on an idempotent re-reserve (B)", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 8 }));
    stubDb(db);
    const first = await reserveProductSummaryBudget(42);
    await releaseUnusedBehaviorBudget(first.reservationId);
    const second = await reserveProductSummaryBudget(42);
    expect(second.reservationId).not.toBe(first.reservationId);
    const again = await reserveProductSummaryBudget(42);
    expect(again.reservationId).toBe(second.reservationId);
    expect(again.status).toBe("reserved");
  });
});

describe("unlimited sentinel precision (Critical N)", () => {
  it("pins the driver rounding fact: mysql2 cannot read the BIGINT UNSIGNED sentinel back exactly", () => {
    expect(String(Number(UNLIMITED_MAX_TOTAL_TOKENS))).not.toBe(UNLIMITED_MAX_TOTAL_TOKENS);
  });

  it("compares the unlimited sentinels on the database side instead of in JavaScript", async () => {
    const db = budgetDb(budgetRow({ max_total_tokens: "10000" }));
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput());
    await settleBehaviorBudget({ reservationId: reservation.reservationId }).catch(() => undefined);
    const legacyProbe = db
      .statements()
      .find((statement) => statement.startsWith("SELECT max_llm_calls, max_total_tokens, max_cost_amount"));
    expect(legacyProbe).toBeUndefined();
    const probe = db.statements().find((statement) => statement.startsWith("SELECT (max_llm_calls = ?)"));
    expect(probe).toBeDefined();
    expect(probe).toContain("max_total_tokens = CONVERT(?, UNSIGNED)");
    expect(probe).toContain("max_cost_amount = CONVERT(?, DECIMAL(12,6))");
  });

  it("settles unknown usage without throwing when every cap is the unlimited sentinel as the driver reads it", async () => {
    // 修复前：驱动舍入使"无上限"被误判为"已配置上限" → 任何 usage unknown 的结算都抛
    // behavior_budget_usage_unknown → 激活门禁永久 fail closed。假驱动的旧 SELECT 路由返回舍入值。
    const db = budgetDb(budgetRow(), [
      receipt({
        attempt_id: "attempt-1",
        usage_status: "unknown",
        input_tokens: null,
        output_tokens: null,
        llm_cost_amount: null,
        pricing_status: "unpriced",
      }),
    ]);
    stubDb(db);
    const reservation = await reserveBehaviorBudget(reservationInput());
    await expect(settleBehaviorBudget({ reservationId: reservation.reservationId })).resolves.toBeUndefined();
    expect(db.row.settled_llm_calls).toBe(1);
    expect(db.row.settled_input_tokens).toBe(400);
    expect(db.reservations()[0].status).toBe("settled_unknown");
  });
});

describe("reconcileOrphanedTaskReservations (E)", () => {
  it("settles orphaned task reservations that have receipts and releases those that never called", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 10 }), [receipt({ attempt_id: "attempt-1" })]);
    stubDb(db);
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-1" }));
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-2" }));
    const result = await reconcileOrphanedTaskReservations({ runId: 42, orphanBeforeMs: Date.now() + 60_000 });
    expect(result).toEqual({ examined: 2, settled: 1, released: 1, usageUnknownBlocked: false });
    expect(db.reservations().find((entry) => entry.attempt_id === "attempt-1")?.status).toBe("settled");
    expect(db.reservations().find((entry) => entry.attempt_id === "attempt-2")?.status).toBe("released");
    expect(db.row.reserved_llm_calls).toBe(0);
    expect(db.row.settled_llm_calls).toBe(1);
  });

  it("leaves in-flight reservations newer than the cutoff and the summary share untouched", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 10 }));
    stubDb(db);
    const summary = await reserveProductSummaryBudget(42);
    const orphan = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-orphan" }));
    const inFlight = await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-live" }));
    const cutoff = Date.now();
    db.reservations().find((entry) => entry.attempt_id === "attempt-orphan")!.created_at_ms = cutoff - 1_000;
    db.reservations().find((entry) => entry.attempt_id === "attempt-live")!.created_at_ms = cutoff + 60_000;
    const result = await reconcileOrphanedTaskReservations({ runId: 42, orphanBeforeMs: cutoff });
    expect(result).toEqual({ examined: 1, settled: 0, released: 1, usageUnknownBlocked: false });
    expect(db.reservations().find((entry) => entry.attempt_id === "attempt-live")?.status).toBe("reserved");
    expect(db.reservations().find((entry) => entry.reservation_uuid === summary.reservationId)?.status).toBe("reserved");
    expect(db.row.summary_reserved).toBe(1);
    expect(inFlight.reservationId).toBeTruthy();
  });

  it("flags usageUnknownBlocked without aborting the sweep when orphan usage is unknown under a configured cap", async () => {
    const db = budgetDb(budgetRow({ max_llm_calls: 10, max_total_tokens: "10000" }), [
      receipt({
        attempt_id: "attempt-unknown",
        usage_status: "unknown",
        input_tokens: null,
        output_tokens: null,
        llm_cost_amount: null,
        pricing_status: "unpriced",
      }),
    ]);
    stubDb(db);
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-unknown" }));
    await reserveBehaviorBudget(reservationInput({ attemptId: "attempt-clean" }));
    const result = await reconcileOrphanedTaskReservations({ runId: 42, orphanBeforeMs: Date.now() + 60_000 });
    expect(result.usageUnknownBlocked).toBe(true);
    expect(result.settled).toBe(1);
    expect(result.released).toBe(1);
    expect(db.reservations().find((entry) => entry.attempt_id === "attempt-unknown")?.status).toBe("settled_unknown");
    expect(db.reservations().find((entry) => entry.attempt_id === "attempt-clean")?.status).toBe("released");
  });
});

describe("migration 080 budget reservation state", () => {
  const sql = readFileSync(path.join(__dirname, "..", "migrations", "080_behavior_inventory.sql"), "utf8");

  it("declares the per-attempt reservation state table with an opaque unique reservation id", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analysis_behavior_budget_reservations");
    expect(sql).toMatch(/reservation_uuid CHAR\(36\) NOT NULL/);
    expect(sql).toMatch(/UNIQUE KEY analysis_behavior_budget_reservations_uuid_unique \(reservation_uuid\)/);
    expect(sql).toMatch(/attempt_id VARCHAR\(64\) NOT NULL/);
    expect(sql).toMatch(/kind VARCHAR\(24\) NOT NULL/);
    expect(sql).toMatch(/status VARCHAR\(24\) NOT NULL DEFAULT 'reserved'/);
  });
});

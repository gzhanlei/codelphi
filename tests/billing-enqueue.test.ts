import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueRunWithReservation, BillingError } from "../lib/billing/core";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

interface Route {
  match: (sql: string) => boolean;
  handle: (params: unknown[]) => unknown;
}

function harness() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const routes: Route[] = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> }> = [];
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          for (const route of routes) if (route.match(sql)) return [route.handle(params), []];
          return [[], []];
        }),
        beginTransaction: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        release: vi.fn(),
      };
      conns.push(conn);
      return conn;
    }),
  };
  return {
    calls,
    conns,
    db,
    on(match: string, handle: (params: unknown[]) => unknown, opts: { first?: boolean } = {}) {
      const route = { match: (sql: string) => sql.includes(match), handle };
      if (opts.first) routes.unshift(route);
      else routes.push(route);
    },
    sqls() {
      return calls.map((c) => c.sql);
    },
    paramsOf(fragment: string) {
      return calls.filter((c) => c.sql.includes(fragment)).map((c) => c.params);
    },
    committed() {
      return conns.filter((c) => c.commit.mock.calls.length > 0).length;
    },
    rolledBack() {
      return conns.filter((c) => c.rollback.mock.calls.length > 0).length;
    },
  };
}

const input = { repositoryId: 3, beforeSha: null, afterSha: "sha-after", trigger: "manual" as const, requestId: "EQ-1" };

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

function routeBasics(h: ReturnType<typeof harness>, overrides: { organizationId?: number; activeRun?: number; reserveRequest?: unknown } = {}) {
  h.on("FROM repositories repo JOIN products p", () => [{ organizationId: overrides.organizationId ?? 7 }]);
  h.on("FROM billing_accounts WHERE account_id", () => [{ account_id: 7, plan_id: "trial", plan_status: "trialing", reconciliation_hold: 0, current_period_start: null, current_period_end: null }]);
  h.on("SELECT id FROM analysis_runs WHERE repository_id", () => (overrides.activeRun === undefined ? [] : [{ id: overrides.activeRun }]));
  // reserve 内部锁 run 行：入队 INSERT 后 run 已存在（insertId 55）
  h.on("FROM analysis_runs WHERE id = ? FOR UPDATE", () => [{ id: 55, account_id: 7, billing_reservation_attempt: 0 }]);
  h.on("FROM billing_reserve_requests WHERE request_id", () => (overrides.reserveRequest === undefined ? [] : [overrides.reserveRequest]));
  h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
}

describe("enqueueRunWithReservation", () => {
  it("creates the run and reserves in one transaction (contract §9)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h);
    h.on("INSERT INTO analysis_runs", () => ({ insertId: 55 }));
    const result = await enqueueRunWithReservation(input);
    expect(result).toMatchObject({ runId: 55, attempt: 1, reused: false, allocations: [{ walletId: 11, units: 1 }] });
    expect(h.paramsOf("INSERT INTO analysis_runs")[0]).toEqual([3, "manual", null, "sha-after", 7]);
    expect(h.committed()).toBe(1);
  });

  it("reuses an active same-sha run without reserving again (020 semantics)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h, { activeRun: 12 });
    const result = await enqueueRunWithReservation(input);
    expect(result).toEqual({ runId: 12, attempt: null, allocations: [], reused: true });
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO analysis_runs"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reservations"))).toBe(false);
  });

  it("converges a run-table unique clash to the winning active run (020)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h, { activeRun: 77 });
    h.on("INSERT INTO analysis_runs", () => {
      throw Object.assign(new Error("Duplicate entry for key 'analysis_runs_active_unique'"), { code: "ER_DUP_ENTRY" });
    });
    const result = await enqueueRunWithReservation(input);
    expect(result).toEqual({ runId: 77, attempt: null, allocations: [], reused: true });
  });

  it("converges a reserve-request unique clash by fingerprint re-read (D19)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h);
    h.on("INSERT INTO analysis_runs", () => ({ insertId: 55 }));
    let requestInserts = 0;
    h.on("INSERT INTO billing_reserve_requests", () => {
      requestInserts += 1;
      if (requestInserts === 1) throw Object.assign(new Error("Duplicate entry 'EQ-1'"), { code: "ER_DUP_ENTRY" });
      return [{}];
    });
    // 收敛轮次：竞争事务已提交请求行（同账户同参数指纹）
    h.on("FROM billing_reserve_requests WHERE request_id", (params) => {
      if (params[0] === "EQ-1" && requestInserts >= 1) {
        return [{ request_id: "EQ-1", run_id: 56, account_id: 7, requested_units: 1, reservation_attempt: 1, allocation_snapshot: "[]", status: "reserved" }];
      }
      return [];
    }, { first: true });
    const result = await enqueueRunWithReservation(input);
    expect(result).toEqual({ runId: 56, attempt: 1, allocations: [], reused: true });
  });

  it("rolls back cleanly when the gate refuses (quota_exceeded)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h);
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 0, reserved_sau: 0 }], { first: true });
    await expect(enqueueRunWithReservation(input)).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(h.rolledBack()).toBe(1);
    expect(h.committed()).toBe(0);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO analysis_runs"))).toBe(true); // 事务内写入，随回滚撤销
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reserve_requests"))).toBe(false);
  });

  it("propagates BillingError as-is so routes can map 402/409", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeBasics(h, { organizationId: 0 });
    await expect(enqueueRunWithReservation(input)).rejects.toBeInstanceOf(BillingError);
  });
});

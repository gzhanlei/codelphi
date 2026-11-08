import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingError, capture, heartbeat, release, reserveForNewRun } from "../lib/billing/core";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

interface Route {
  match: (sql: string) => boolean;
  handle: (params: unknown[]) => unknown;
}

/** 可编程 SQL 路由 harness：按注册顺序匹配关键字，记录全部语句与事务轮次（项目 mock-getDb 模式）。 */
function harness() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const routes: Route[] = [];
  const conns: Array<{
    execute: ReturnType<typeof vi.fn>;
    beginTransaction: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }> = [];
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          // mysql2 execute 返回 [rows, fields]：handle 产出 rows 数组；未路由的查询返回空行集
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
    on(match: string | RegExp, handle: (params: unknown[]) => unknown, opts: { first?: boolean } = {}) {
      const route = { match: typeof match === "string" ? (sql: string) => sql.includes(match) : (sql: string) => (match as RegExp).test(sql), handle };
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

const ACCOUNT = { account_id: 7, plan_id: "trial", plan_status: "trialing", current_period_start: null, current_period_end: null, reconciliation_hold: 0 };
const RUN = { id: 8, account_id: 7, billing_reservation_attempt: 0 };

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

function routeCommonBasics(h: ReturnType<typeof harness>, overrides: { account?: Partial<typeof ACCOUNT>; run?: Partial<typeof RUN>; reserveRequest?: unknown; activeAttemptRows?: unknown[]; attemptReservations?: unknown[] } = {}) {
  const account = { ...ACCOUNT, ...overrides.account };
  const run = { ...RUN, ...overrides.run };
  h.on("FROM billing_accounts WHERE account_id", () => [account]);
  h.on("FROM analysis_runs WHERE id = ? FOR UPDATE", () => [run]);
  h.on("SELECT account_id FROM analysis_runs", () => [{ account_id: run.account_id }]);
  h.on("FROM billing_reserve_requests WHERE request_id", () => (overrides.reserveRequest === undefined ? [] : [overrides.reserveRequest]));
  h.on("AND status = 'active' LIMIT 1 FOR UPDATE", () => (overrides.activeAttemptRows ?? []));
  if (overrides.attemptReservations) h.on("JOIN billing_quota_wallets w", () => overrides.attemptReservations);
}

describe("reserveForNewRun", () => {
  it("returns the original result for a matching persistent request without re-allocating (D13)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, {
      run: { billing_reservation_attempt: 2 },
      reserveRequest: {
        request_id: "R1", run_id: 8, account_id: 7, requested_units: 1, reservation_attempt: 1,
        allocation_snapshot: JSON.stringify([{ walletId: 11, units: 1 }]), status: "released",
      },
    });
    const result = await reserveForNewRun(8, 7, 1, "R1");
    expect(result).toEqual({ attempt: 1, allocations: [{ walletId: 11, units: 1 }], reused: true, requestStatus: "released" });
    expect(h.sqls().some((sql) => sql.includes("UPDATE analysis_runs SET billing_reservation_attempt"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reservations"))).toBe(false);
  });

  it("raises idempotency_conflict when the fingerprint differs and writes nothing (D18)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, {
      reserveRequest: { request_id: "R1", run_id: 8, account_id: 7, requested_units: 5, reservation_attempt: 1, allocation_snapshot: "[]", status: "reserved" },
    });
    await expect(reserveForNewRun(8, 7, 1, "R1")).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(h.committed()).toBe(0);
    expect(h.rolledBack()).toBe(1);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reserve_requests"))).toBe(false);
  });

  it("converges a concurrent request_id unique-key clash by rolling back and re-reading in a new transaction (D19)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    // 重读路由置前：优先于 routeCommonBasics 的默认空路由（竞争事务提交后请求行可见）
    h.on(
      "FROM billing_reserve_requests WHERE request_id",
      (params) => {
        if (params[0] === "R1" && inserts >= 1) {
          return [{ request_id: "R1", run_id: 8, account_id: 7, requested_units: 1, reservation_attempt: 1, allocation_snapshot: "[]", status: "reserved" }];
        }
        return [];
      },
      { first: true },
    );
    routeCommonBasics(h, { run: { billing_reservation_attempt: 2 } });
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    let inserts = 0;
    h.on("INSERT INTO billing_reserve_requests", () => {
      inserts += 1;
      if (inserts === 1) {
        throw Object.assign(new Error("Duplicate entry 'R1' for key 'PRIMARY'"), { code: "ER_DUP_ENTRY" });
      }
      return [{}];
    });
    const result = await reserveForNewRun(8, 7, 1, "R1");
    expect(result.reused).toBe(true);
    expect(result.attempt).toBe(1);
    expect(h.committed()).toBe(1);
    expect(h.rolledBack()).toBe(1);
    expect(h.conns.length).toBe(2);
  });

  it("rejects non-eligible account states and reconciliation holds via the single eligibility implementation", async () => {
    for (const [account, expected] of [
      [{ ...ACCOUNT, plan_status: "grace" }, "billing_state_conflict"],
      [{ ...ACCOUNT, plan_status: "expired" }, "billing_state_conflict"],
      [{ ...ACCOUNT, reconciliation_hold: 1 }, "reconciliation_hold"],
    ] as const) {
      const h = harness();
      vi.mocked(getDb).mockReturnValue(h.db as never);
      routeCommonBasics(h, { account });
      await expect(reserveForNewRun(8, 7, 1, "R1")).rejects.toMatchObject({ code: expected });
      expect(h.committed()).toBe(0);
    }
  });

  it("refuses a new attempt while the current attempt still has active reservations (D12)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, activeAttemptRows: [{ reservation_id: 1 }] });
    await expect(reserveForNewRun(8, 7, 1, "R2")).rejects.toMatchObject({ code: "billing_state_conflict" });
    expect(h.sqls().some((sql) => sql.includes("UPDATE analysis_runs SET billing_reservation_attempt"))).toBe(false);
  });

  it("allocates across wallets in contract order and persists the request identity row", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h);
    h.on("FROM billing_quota_wallets", () => [
      { wallet_id: 11, quota_type: "trial", remaining_sau: 2, reserved_sau: 0 },
      { wallet_id: 12, quota_type: "plan", remaining_sau: 3, reserved_sau: 0 },
    ]);
    const gate = vi.fn(async () => undefined);
    const result = await reserveForNewRun(8, 7, 4, "R1", { gate });
    expect(result).toEqual({ attempt: 1, allocations: [{ walletId: 11, units: 2 }, { walletId: 12, units: 2 }], reused: false });
    expect(gate).toHaveBeenCalledOnce();
    expect(h.paramsOf("INSERT INTO billing_reservations")[0]).toEqual([8, 1, 7, 11, 2, 30]);
    expect(h.paramsOf("INSERT INTO billing_ledger")).toEqual([
      [7, 11, 8, "rsv:8:1:11", 1, "reserved", "trial", 2, null, 2, 2],
      [7, 12, 8, "rsv:8:1:12", 1, "reserved", "plan", 2, null, 3, 2],
    ]);
    // 钱包绝对值写入：trial reserved 0→2；plan reserved 0→2
    const walletUpdates = h.paramsOf("UPDATE billing_quota_wallets\n     SET reserved_sau");
    expect(walletUpdates).toEqual([[2, 2, 2, 11], [2, 3, 2, 12]]);
    const requestInsert = h.paramsOf("INSERT INTO billing_reserve_requests")[0];
    expect(requestInsert).toEqual(["R1", 8, 7, 4, 1, JSON.stringify([{ walletId: 11, units: 2 }, { walletId: 12, units: 2 }])]);
    expect(h.paramsOf("UPDATE analysis_runs SET billing_reservation_attempt")[0]).toEqual([1, 8]);
  });

  it("throws quota_exceeded and leaves zero residue when available SAU is insufficient", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h);
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 2, reserved_sau: 1 }]);
    await expect(reserveForNewRun(8, 7, 4, "R1")).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(h.rolledBack()).toBe(1);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reservations"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_reserve_requests"))).toBe(false);
  });

  it("restricts trialing accounts to trial wallets (§7.0)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { account: { ...ACCOUNT, plan_status: "trialing" } });
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    await reserveForNewRun(8, 7, 1, "R1");
    expect(h.sqls().some((sql) => sql.includes("AND quota_type = 'trial'"))).toBe(true);
  });
});

describe("capture", () => {
  const settledRow = {
    request_id: "SR1", requested_actual_units: 1, captured_units_total: 1, released_units_total: 0,
    unfunded_units: 0, run_settlement_status: "fully_settled",
  };

  it("returns the run-level settlement as-is for a same-parameter retry and writes nothing (D8)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 } });
    h.on("FROM billing_settlement_requests WHERE run_id", () => [settledRow]);
    const result = await capture(8, 1);
    expect(result.reused).toBe(true);
    expect(result.runSettlementStatus).toBe("fully_settled");
    expect(h.committed()).toBe(1);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_settlements"))).toBe(false);
  });

  it("raises idempotency_conflict when a retry passes different actual units (D8)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 2 } });
    h.on("FROM billing_settlement_requests WHERE run_id", () => [settledRow]);
    await expect(capture(8, 3)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(h.committed()).toBe(0);
  });

  it("settles an equal capture and mirrors the request row to captured", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 1, status: "active", quota_type: "trial", wallet_remaining: 4, wallet_reserved: 1 }] });
    const result = await capture(8, 1);
    expect(result).toMatchObject({ requestedActualUnits: 1, capturedUnitsTotal: 1, unfundedUnits: 0, runSettlementStatus: "fully_settled", reused: false });
    expect(h.paramsOf("INSERT INTO billing_ledger")).toEqual([
      [7, 11, 8, "cap:8:1:11", 1, "captured", "trial", 1, null, 3, 0],
    ]);
    expect(h.paramsOf("UPDATE billing_quota_wallets\n     SET remaining_sau")[0]).toEqual([3, 0, 3, 0, 11]);
    expect(h.paramsOf("INSERT INTO billing_settlements")[0]).toEqual([8, 1, 7, 1, 1, 0, "normal"]);
    expect(h.paramsOf("INSERT INTO billing_settlement_requests")[0]?.slice(1, 8)).toEqual([8, 7, 1, 1, 0, 0, "fully_settled"]);
    expect(h.paramsOf("UPDATE billing_reserve_requests SET status")[0]).toEqual(["captured", 8, 1]);
  });

  it("captures partially and releases the remainder on the boundary wallet (D5)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 3, status: "active", quota_type: "trial", wallet_remaining: 5, wallet_reserved: 3 }] });
    const result = await capture(8, 2);
    expect(result).toMatchObject({ capturedUnitsTotal: 2, releasedUnitsTotal: 1, runSettlementStatus: "fully_settled" });
    expect(h.paramsOf("INSERT INTO billing_ledger")).toEqual([
      [7, 11, 8, "cap:8:1:11", 1, "captured", "trial", 2, null, 3, 0],
      [7, 11, 8, "rel:8:1:11:settlement_difference", 1, "released", "trial", 1, "settlement_difference", 3, 0],
    ]);
    expect(h.paramsOf("UPDATE billing_quota_wallets\n     SET remaining_sau")[0]).toEqual([3, 0, 3, 0, 11]);
  });

  it("settles an overage capture in one transaction: original attempt cleared then top-up attempt (D7/D16)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 } });
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    let attemptReads = 0;
    h.on("JOIN billing_quota_wallets w", (params) => {
      attemptReads += 1;
      return attemptReads === 1
        ? [{ reservation_id: 1, wallet_id: 11, units: 3, status: "active", quota_type: "trial", wallet_remaining: 5, wallet_reserved: 3 }]
        : [{ reservation_id: 2, wallet_id: 11, units: 2, status: "active", quota_type: "trial", wallet_remaining: 2, wallet_reserved: 2 }];
    });
    const result = await capture(8, 5);
    expect(result).toMatchObject({
      requestedActualUnits: 5,
      capturedUnitsTotal: 5,
      runSettlementStatus: "fully_settled",
      attemptSettlements: [
        { attempt: 1, captured: 3, released: 0, via: "normal" },
        { attempt: 2, captured: 2, released: 0, via: "overage_topup" },
      ],
    });
    expect(h.paramsOf("UPDATE analysis_runs SET billing_reservation_attempt")).toEqual([[2, 8]]);
    expect(h.paramsOf("INSERT INTO billing_settlements").length).toBe(2);
    expect(h.paramsOf("INSERT INTO billing_settlement_requests")[0]?.slice(1, 8)).toEqual([8, 7, 5, 5, 0, 0, "fully_settled"]);
  });

  it("commits the original attempt capture and records an unfunded exception when top-up is insufficient (D16/D17)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 } });
    // top-up 预检：钱包耗尽（available = 0）→ quota_exceeded
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 0, reserved_sau: 0 }]);
    let attemptReads = 0;
    h.on("JOIN billing_quota_wallets w", (params) => {
      attemptReads += 1;
      if (attemptReads === 1) return [{ reservation_id: 1, wallet_id: 11, units: 3, status: "active", quota_type: "trial", wallet_remaining: 3, wallet_reserved: 3 }];
      return [{ reservation_id: 0, wallet_id: 11, units: 0, status: "active", quota_type: "trial", wallet_remaining: 0, wallet_reserved: 0 }];
    });
    const notify = vi.fn(async () => undefined);
    const result = await capture(8, 5, { notify });
    expect(result).toMatchObject({
      capturedUnitsTotal: 3,
      unfundedUnits: 2,
      runSettlementStatus: "partially_settled",
      attemptSettlements: [{ attempt: 1, captured: 3, released: 0, via: "normal" }],
    });
    expect(notify).toHaveBeenCalledWith({ type: "partially_settled", runId: 8, unfundedUnits: 2 });
    // 无空 attempt：attempt 计数只递增一次（原 attempt），top-up 失败不产生 attempt 2
    expect(h.paramsOf("UPDATE analysis_runs SET billing_reservation_attempt")).toEqual([]);
    expect(h.paramsOf("INSERT IGNORE INTO billing_settlement_exceptions")[0]).toEqual([8, 1, 7, "unfunded_usage", 5, 3, 2, "exc:8:1:unfunded_usage"]);
    expect(h.paramsOf("INSERT INTO billing_settlement_requests")[0]?.slice(1, 8)).toEqual([8, 7, 5, 3, 0, 2, "partially_settled"]);
  });

  it("kills an expired attempt via re-reservation when wallets have capacity (D16)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 } });
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    let attemptReads = 0;
    h.on("JOIN billing_quota_wallets w", () => {
      attemptReads += 1;
      return attemptReads === 1
        ? [{ reservation_id: 1, wallet_id: 11, units: 1, status: "expired", quota_type: "trial", wallet_remaining: 5, wallet_reserved: 0 }]
        : [{ reservation_id: 2, wallet_id: 11, units: 1, status: "active", quota_type: "trial", wallet_remaining: 5, wallet_reserved: 1 }];
    });
    const result = await capture(8, 1);
    expect(result).toMatchObject({ runSettlementStatus: "fully_settled", attemptSettlements: [{ attempt: 2, captured: 1, released: 0, via: "expired_rekill" }] });
    expect(h.paramsOf("UPDATE analysis_runs SET billing_reservation_attempt")[0]).toEqual([2, 8]);
    expect(h.paramsOf("INSERT INTO billing_settlement_requests")[0]?.slice(1, 8)).toEqual([8, 7, 1, 1, 0, 0, "fully_settled"]);
  });

  it("maps a fully expired, zero-capture settlement to unfunded — not partially_settled (D20)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 } });
    // 过期路径 top-up 不足：钱包耗尽（available = 0）→ 捕获 0 → unfunded（D20）
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 0, reserved_sau: 0 }]);
    let attemptReads = 0;
    h.on("JOIN billing_quota_wallets w", () => {
      attemptReads += 1;
      return attemptReads === 1
        ? [{ reservation_id: 1, wallet_id: 11, units: 1, status: "expired", quota_type: "trial", wallet_remaining: 0, wallet_reserved: 0 }]
        : [{ reservation_id: 0, wallet_id: 11, units: 0, status: "active", quota_type: "trial", wallet_remaining: 0, wallet_reserved: 0 }];
    });
    const result = await capture(8, 1);
    expect(result).toMatchObject({ capturedUnitsTotal: 0, unfundedUnits: 1, runSettlementStatus: "unfunded" });
    expect(h.paramsOf("INSERT INTO billing_settlement_requests")[0]?.slice(1, 8)).toEqual([8, 7, 1, 0, 0, 1, "unfunded"]);
    // exception 归属已过期的 attempt 1（真实存在），而非未创建的 attempt 2
    expect(h.paramsOf("INSERT IGNORE INTO billing_settlement_exceptions")[0]).toEqual([8, 1, 7, "unfunded_usage", 1, 0, 1, "exc:8:1:unfunded_usage"]);
  });

  it("routes fully-released attempts to a state conflict without writing (re-analysis goes through re-dispatch)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 1, status: "released", quota_type: "trial", wallet_remaining: 4, wallet_reserved: 0 }] });
    await expect(capture(8, 1)).rejects.toMatchObject({ code: "billing_state_conflict" });
    expect(h.committed()).toBe(0);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_settlement_requests"))).toBe(false);
  });

  it("flags mixed reservation statuses as a reconciliation exception instead of guessing (D10)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, {
      run: { billing_reservation_attempt: 1 },
      attemptReservations: [
        { reservation_id: 1, wallet_id: 11, units: 1, status: "active", quota_type: "trial", wallet_remaining: 4, wallet_reserved: 1 },
        { reservation_id: 2, wallet_id: 12, units: 1, status: "released", quota_type: "plan", wallet_remaining: 4, wallet_reserved: 0 },
      ],
    });
    await expect(capture(8, 2)).rejects.toMatchObject({ code: "billing_state_conflict" });
    expect(h.paramsOf("INSERT IGNORE INTO billing_settlement_exceptions")[0]).toEqual([8, 1, 7, "inconsistent_reservation", 2, 0, 2, "exc:8:1:inconsistent_reservation"]);
    expect(h.committed()).toBe(0);
  });

  it("flags a captured attempt without a settlement record as an inconsistency (D8)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, {
      run: { billing_reservation_attempt: 1 },
      attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 1, status: "captured", quota_type: "trial", wallet_remaining: 3, wallet_reserved: 0 }],
    });
    await expect(capture(8, 1)).rejects.toMatchObject({ code: "billing_state_conflict" });
    expect(h.paramsOf("INSERT IGNORE INTO billing_settlement_exceptions")[0]).toEqual([8, 1, 7, "inconsistent_reservation", 1, 0, 1, "exc:8:1:inconsistent_reservation"]);
  });
});

describe("release", () => {
  it("releases all active reservations and mirrors the request row (§6.6)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 2, status: "active", quota_type: "trial", wallet_remaining: 4, wallet_reserved: 2 }] });
    const result = await release(8, "analysis_failed");
    expect(result).toEqual({ released: true });
    expect(h.paramsOf("INSERT INTO billing_ledger")[0]).toEqual([7, 11, 8, "rel:8:1:11:analysis_failed", 1, "released", "trial", 2, "analysis_failed", 4, 0]);
    expect(h.paramsOf("UPDATE billing_quota_wallets\n         SET reserved_sau")[0]).toEqual([0, 4, 0, 11]);
    expect(h.paramsOf("UPDATE billing_reserve_requests SET status")[0]).toEqual(["released", 8, 1]);
  });

  it("is a no-op when nothing is active (converges with the sweep)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h, { run: { billing_reservation_attempt: 1 }, attemptReservations: [{ reservation_id: 1, wallet_id: 11, units: 2, status: "expired", quota_type: "trial", wallet_remaining: 4, wallet_reserved: 0 }] });
    expect(await release(8, "analysis_failed")).toEqual({ released: false });
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_ledger"))).toBe(false);
  });
});

describe("heartbeat", () => {
  it("extends active reservations and stamps last_heartbeat_at in one transaction", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h);
    let affected = 1;
    h.on("UPDATE billing_reservations SET expires_at", () => {
      return { affectedRows: affected };
    });
    expect(await heartbeat(8)).toEqual({ renewed: true });
    expect(h.paramsOf("UPDATE analysis_runs SET last_heartbeat_at")[0]).toEqual([8]);
    expect(h.paramsOf("UPDATE billing_reservations SET expires_at")[0]).toEqual([30, 8]);
  });

  it("never resurrects cleared reservations — zero affected rows only warns (§6.3)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    routeCommonBasics(h);
    h.on("UPDATE billing_reservations SET expires_at", () => [{ affectedRows: 0 }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await heartbeat(8)).toEqual({ renewed: false });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("deadlock retry", () => {
  it("retries the whole transaction after a lock deadlock and succeeds (§6)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on(
      "FROM billing_accounts WHERE account_id",
      () => {
        accountLocks += 1;
        if (accountLocks === 1) throw Object.assign(new Error("Lock wait timeout exceeded"), { code: "ER_LOCK_WAIT_TIMEOUT" });
        return [ACCOUNT];
      },
      { first: true },
    );
    routeCommonBasics(h);
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    let accountLocks = 0;
    const result = await reserveForNewRun(8, 7, 1, "R1");
    expect(result.reused).toBe(false);
    expect(h.rolledBack()).toBe(1);
    expect(h.committed()).toBe(1);
    expect(h.conns.length).toBe(2);
  });

  it("gives up with deadlock_retry_exhausted after the configured retries", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on(
      "FROM billing_accounts WHERE account_id",
      () => {
        throw Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK" });
      },
      { first: true },
    );
    routeCommonBasics(h);
    await expect(reserveForNewRun(8, 7, 1, "R1")).rejects.toMatchObject({ code: "deadlock_retry_exhausted" });
    expect(h.rolledBack()).toBe(3);
  });
});

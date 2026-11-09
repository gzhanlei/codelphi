import { beforeEach, describe, expect, it, vi } from "vitest";
import { expireStaleReservationsOnce } from "../lib/billing/core";
import { runQueuedRunRecoveryOnce, runRateLimitCleanupOnce, runReservationSweepOnce } from "../lib/billing/sweep";
import { dispatchStuckQueuedRuns } from "../lib/analysis-recovery";
import { runAnalysis } from "../lib/analysis";

vi.mock("../lib/analysis-recovery", () => ({ dispatchStuckQueuedRuns: vi.fn(async () => ({ superseded: 1, dispatched: 2 })) }));
vi.mock("../lib/analysis", () => ({ runAnalysis: vi.fn(async () => undefined) }));
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const ACCOUNT = { account_id: 7, plan_id: "trial", plan_status: "trialing", current_period_start: null, current_period_end: null, reconciliation_hold: 0 };

function harness() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const routes: Array<{ match: (sql: string) => boolean; handle: (params: unknown[]) => unknown }> = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
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
  };
}

const CANDIDATE = { reservation_id: 1, run_id: 8, reservation_attempt: 1, account_id: 7, wallet_id: 11, units: 2 };

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

describe("expireStaleReservationsOnce (five-row disposition table, contract §6.5)", () => {
  function base(h: ReturnType<typeof harness>, overrides: { runStatus?: string; heartbeatFresh?: number; reservationStatus?: string } = {}) {
    h.on("WHERE r.status = 'active' AND r.expires_at <= NOW(3)", () => [CANDIDATE]);
    h.on("heartbeatFresh", () => [{ id: 8, status: overrides.runStatus ?? "running", heartbeatFresh: overrides.heartbeatFresh ?? 0 }], { first: true });
    h.on("FROM billing_reservations WHERE reservation_id = ? FOR UPDATE", () => [{ reservation_id: 1, wallet_id: 11, units: 2, status: overrides.reservationStatus ?? "active" }]);
    h.on("FROM billing_quota_wallets WHERE wallet_id = ? FOR UPDATE", () => [{ remainingSau: 5, reservedSau: 2, quota_type: "trial" }]);
    h.on("FROM billing_settlement_requests WHERE run_id", () => []);
    h.on("SELECT GET_LOCK", () => [{ acquired: 1 }]);
    h.on("SELECT RELEASE_LOCK", () => [{ result: 1 }]);
  }

  async function connection(h: ReturnType<typeof harness>) {
    return (await h.db.getConnection()) as { execute: unknown };
  }

  it("renews a fresh-heartbeat running reservation without any ledger write (no-resurrection companion rule)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    base(h, { runStatus: "running", heartbeatFresh: 1 });
    const result = await expireStaleReservationsOnce((await connection(h)) as never, { freshWindowMinutes: 5, ttlMinutes: 30 });
    console.log("DEBUG-RENEW-LEFTOVER:", JSON.stringify(result), h.calls.map((c) => c.sql.replace(/\s+/g, " ").slice(0, 70)));
    expect(result).toEqual({ renewed: 1, expired: 0, released: 0, errored: 0, recoveryRunIds: [] });
    expect(h.paramsOf("UPDATE billing_reservations SET expires_at")[0]).toEqual([30, 1]);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_ledger"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("UPDATE billing_quota_wallets"))).toBe(false);
  });

  it("expires a stale-heartbeat running reservation with ledger + wallet release + request mirror", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    base(h, { runStatus: "running", heartbeatFresh: 0 });
    const result = await expireStaleReservationsOnce((await connection(h)) as never, { freshWindowMinutes: 5, ttlMinutes: 30 });
    expect(result.expired).toBe(1);
    expect(h.paramsOf("INSERT INTO billing_ledger")[0]).toEqual([7, 11, 8, "rel:8:1:11:ttl_expired", 1, "released", "trial", 2, "ttl_expired", 5, 0]);
    expect(h.paramsOf("UPDATE billing_quota_wallets SET reserved_sau")[0]).toEqual([0, 5, 0, 11]);
    expect(h.paramsOf("UPDATE billing_reserve_requests SET status")[0]).toEqual(["expired", 8, 1]);
  });

  it("collects succeeded runs for settlement recovery instead of releasing them (D15)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    base(h, { runStatus: "succeeded" });
    const result = await expireStaleReservationsOnce((await connection(h)) as never, { freshWindowMinutes: 5, ttlMinutes: 30 });
    expect(result).toEqual({ renewed: 0, expired: 0, released: 0, errored: 0, recoveryRunIds: [8] });
    expect(h.sqls().some((sql) => sql.includes("UPDATE billing_reservations SET status = 'expired'"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_ledger"))).toBe(false);
  });

  it("releases stale reservations of failed runs and mirrors the request row as released", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    base(h, { runStatus: "failed" });
    const result = await expireStaleReservationsOnce((await connection(h)) as never, { freshWindowMinutes: 5, ttlMinutes: 30 });
    expect(result.released).toBe(1);
    expect(h.paramsOf("UPDATE billing_reserve_requests SET status")[0]).toEqual(["released", 8, 1]);
    expect(h.paramsOf("INSERT INTO billing_ledger")[0]?.[8]).toBe("analysis_failed");
  });

  it("skips reservations already settled by a concurrent release (idempotent convergence)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    base(h, { reservationStatus: "released" });
    const result = await expireStaleReservationsOnce((await connection(h)) as never, { freshWindowMinutes: 5, ttlMinutes: 30 });
    expect(result).toEqual({ renewed: 0, expired: 0, released: 0, errored: 0, recoveryRunIds: [] });
    expect(h.sqls().some((sql) => sql.includes("UPDATE billing_quota_wallets"))).toBe(false);
  });
});

describe("runReservationSweepOnce", () => {
  it("executes under the advisory lock, commits, records sweep state and recovers settlement (scan two)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("SELECT GET_LOCK", () => [{ acquired: 1 }]);
    h.on("WHERE r.status = 'active' AND r.expires_at <= NOW(3)", () => []);
    // 扫描二：succeeded + 无 requests + 有 reservations → capture 恢复
    h.on("WHERE a.status = 'succeeded'", () => [{ id: 90 }]);
    h.on("FROM analysis_runs WHERE id = ? FOR UPDATE", () => [{ id: 90, account_id: 7, billing_reservation_attempt: 1 }]);
    h.on("SELECT account_id FROM analysis_runs", () => [{ account_id: 7 }]);
    h.on("FROM billing_accounts WHERE account_id", () => [ACCOUNT]);
    h.on("FROM billing_settlement_requests WHERE run_id", () => []);
    h.on("JOIN billing_quota_wallets w", () => [{ reservation_id: 5, wallet_id: 11, units: 1, status: "active", quota_type: "trial", wallet_remaining: 5, wallet_reserved: 1 }]);
    h.on("FROM billing_quota_wallets", () => [{ wallet_id: 11, quota_type: "trial", remaining_sau: 5, reserved_sau: 0 }]);
    const result = await runReservationSweepOnce();
    console.log("[DEBUG-RESULT]", JSON.stringify(result), "| detail:", JSON.stringify(result.detail));
    expect(result.executed).toBe(true);
    expect(result.detail).toMatchObject({ renewed: 0, expired: 0, released: 0, errored: 0, recoveryRunIds: [], settlementRecovered: 1 });
    // GET_LOCK 与作业语句共用同一连接（B6），作业后 UNLOCK
    const lockConn = h.conns[0];
    expect(lockConn.release).toHaveBeenCalled();
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_sweep_state"))).toBe(true);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_settlement_requests"))).toBe(true);
  });

  it("skips the round when the advisory lock is busy (overlap protection, P1-2)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("SELECT GET_LOCK", () => [{ acquired: 0 }]);
    const result = await runReservationSweepOnce();
    expect(result).toEqual({ executed: false, detail: { reason: "lock_busy" } });
    expect(h.conns[0].commit).not.toHaveBeenCalled();
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_sweep_state"))).toBe(false);
  });
});

describe("runRateLimitCleanupOnce", () => {
  it("deletes expired windows and reports the affected rows", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("SELECT GET_LOCK", () => [{ acquired: 1 }]);
    h.on("DELETE FROM rate_limit_hits", () => ({ affectedRows: 7 }));
    const result = await runRateLimitCleanupOnce(3600);
    expect(result.executed).toBe(true);
    expect(result.detail).toEqual({ deleted: 7 });
    expect(h.paramsOf("DELETE FROM rate_limit_hits")[0]).toEqual([7200]);
  });
});

describe("runQueuedRunRecoveryOnce", () => {
  it("delegates to the stuck-queued dispatcher under the job lock and records success", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("SELECT GET_LOCK", () => [{ acquired: 1 }]);
    const result = await runQueuedRunRecoveryOnce();
    expect(result).toEqual({ executed: true, detail: { superseded: 1, dispatched: 2 } });
    expect(vi.mocked(dispatchStuckQueuedRuns)).toHaveBeenCalledWith(runAnalysis);
    expect(h.sqls().some((sql) => sql.includes("billing_sweep_state"))).toBe(true);
  });
});

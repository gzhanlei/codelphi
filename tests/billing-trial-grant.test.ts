import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantTrialQuota } from "../lib/billing/core";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

function harness() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> }> = [];
  const routes: Array<{ match: (sql: string) => boolean; handle: (params: unknown[]) => unknown }> = [];
  let grantsInserts = 0;
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          for (const route of routes) if (route.match(sql)) return [route.handle(params), []];
          if (sql.includes("INSERT INTO trial_grants")) {
            grantsInserts += 1;
            if (grantsInserts > 1) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("INSERT INTO billing_quota_wallets")) return [{ insertId: 31 }];
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
    sqls: () => calls.map((c) => c.sql),
    on(match: string, handle: (params: unknown[]) => unknown, opts: { first?: boolean } = {}) {
      const route = { match: (sql: string) => sql.includes(match), handle };
      if (opts.first) routes.unshift(route);
      else routes.push(route);
    },
  };
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

describe("grantTrialQuota", () => {
  it("writes the grant ledger entry, the wallet and the identity row in one transaction (D9/M1-T4)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await grantTrialQuota({ userId: 5, accountId: 7, source: "workspace_creation" });
    expect(result).toEqual({ granted: true });
    expect(h.calls.filter((c) => c.sql.includes("INSERT INTO trial_grants"))[0].params).toEqual([5, 7, 5, "workspace_creation"]);
    expect(h.calls.filter((c) => c.sql.includes("INSERT INTO billing_quota_wallets"))[0].params).toEqual([7, 5, "trial:5", 5]);
    // granted 流水：idempotency_key = 稳定业务键（grt:trial:{userId}:trial），与随机 wallet_id 无关
    expect(h.calls.filter((c) => c.sql.includes("INSERT INTO billing_ledger"))[0].params).toEqual([7, 31, null, "grt:trial:5:trial", null, "granted", "trial", 5, null, 5, 0]);
    expect(h.conns[0].commit).toHaveBeenCalledOnce();
  });

  it("is idempotent under concurrent duplicate grants — no wallet or ledger writes (P0-4)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    // 模拟库中已存在该 user 的授权行：INSERT 撞 user_id 主键
    h.on("INSERT INTO trial_grants", () => {
      throw Object.assign(new Error("Duplicate entry '5' for key 'PRIMARY'"), { code: "ER_DUP_ENTRY" });
    }, { first: true });
    const result = await grantTrialQuota({ userId: 5, accountId: 8, source: "backfill" });
    expect(result).toEqual({ granted: false });
    expect(h.conns[0].rollback).toHaveBeenCalledOnce();
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_quota_wallets"))).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_ledger"))).toBe(false);
  });
});

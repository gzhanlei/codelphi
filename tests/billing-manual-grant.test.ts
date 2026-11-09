import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantQuotaByEmail } from "../lib/billing/manual-grant";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const EMAIL = "user@example.com";
const SUB = "sub-user-1";

/** 可编程 SQL 路由 harness（对齐项目 mock 模式）；内存态模拟 users/orgs/wallets/ledger。 */
function harness(state: { userRow?: Record<string, unknown> | null; orgRow?: Record<string, unknown>; walletRow?: Record<string, unknown>; ledgerKeys?: string[] } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }> = [];
  const ledgerKeys = state.ledgerKeys ?? [];
  const routes: Array<{ match: (sql: string) => boolean; handle: (params: unknown[]) => unknown }> = [];
  let walletRemaining = 0;
  let walletCreated = false;
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          for (const route of routes) if (route.match(sql)) return [route.handle(params), []];
          if (sql.includes("FROM users WHERE email")) {
            const userRow = "userRow" in state ? state.userRow : { id: 5, chandler_sub: SUB };
            return [userRow ? [userRow] : [], []];
          }
          if (sql.includes("FROM organizations WHERE slug")) return [[state.orgRow ?? { id: 7 }], []];
          if (sql.includes("FROM billing_accounts WHERE account_id = ? FOR UPDATE")) return [[{ id: 7 }], []];
          if (sql.includes("t FOR UPDATE")) {
            return [state.walletRow ? [{ walletId: 31, remaining: Number(state.walletRow.remaining_sau ?? 0), reserved: 0 }] : [], []];
          }
          if (sql.includes("INSERT INTO billing_quota_wallets")) {
            walletCreated = true;
            return [{ insertId: 31 }];
          }
          if (sql.includes("SELECT id FROM billing_ledger WHERE idempotency_key")) {
            return [ledgerKeys.includes(String(params[0])) ? [{ id: 1 }] : [], []];
          }
          if (sql.includes("INSERT INTO billing_ledger")) {
            ledgerKeys.push(String(params[2]));
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("UPDATE billing_quota_wallets SET remaining_sau")) {
            walletRemaining = Number(params[0]);
            return [{ affectedRows: 1 }];
          }
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
    walletRemaining,
    walletCreated,
    committed: () => conns.filter((c) => c.commit.mock.calls.length > 0).length,
    rolledBack: () => conns.filter((c) => c.rollback.mock.calls.length > 0).length,
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

describe("grantQuotaByEmail", () => {
  it("grants to an existing trial wallet and writes the ledger entry (transaction commits)", async () => {
    const h = harness({ walletRow: { remaining_sau: 5 } });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await grantQuotaByEmail({ email: EMAIL, units: 200, reason: "manual-topup-2026-11-09" });
    expect(result).toEqual({ granted: true, walletId: 31, newRemaining: 205, accountId: 7, userId: 5 });
    expect(h.committed()).toBe(1);
    const ledgerCall = h.calls.find((c) => c.sql.includes("INSERT INTO billing_ledger"));
    expect(ledgerCall, "ledger insert should happen").toBeDefined();
    const ledgerParams = ledgerCall?.params ?? [];
    expect(ledgerParams[4]).toBe("manual grant: manual-topup-2026-11-09");
    expect(ledgerParams[5]).toBe(205);
  });

  it("creates the trial wallet automatically for legacy users without one", async () => {
    const h = harness({});
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await grantQuotaByEmail({ email: EMAIL, units: 100, reason: "topup-a" }).catch(e => ({ error: String(e) }));
    expect(result).toMatchObject({ granted: true, walletId: 31, newRemaining: 100 });
  });

  it("treats the same reason replay as a no-op (granted:false, zero writes)", async () => {
    const h = harness({ ledgerKeys: ["grt:manual:topup-a:31"] });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await grantQuotaByEmail({ email: EMAIL, units: 100, reason: "topup-a" });
    expect(result.granted).toBe(false);
    expect(h.sqls().some((sql) => sql.includes("UPDATE billing_quota_wallets SET remaining_sau"))).toBe(false);
  });

  it("throws a locating error for unknown emails (route maps to 404)", async () => {
    const h = harness({ userRow: null });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    await expect(grantQuotaByEmail({ email: "ghost@example.com", units: 100, reason: "r" })).rejects.toThrow("no user with email");
    expect(h.rolledBack()).toBe(1);
  });
});

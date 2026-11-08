import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillPaidOrder, computeNextPeriod } from "../lib/billing/fulfillment";
import { verifyChandlerWebhookSignature, parseChandlerWebhookPayload } from "../lib/chandler-pay";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const ORDER_NO = "cdlp_7_1700000000_ab12cd34";
const PLATFORM_NO = "PO123";

const ACCOUNT_ACTIVE = { plan_status: "active", current_period_end: new Date("2026-12-01T00:00:00Z") };

function harness(order: Record<string, unknown> | null, account: Record<string, unknown> | null = ACCOUNT_ACTIVE) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const routes: Array<{ match: (sql: string) => boolean; handle: (params: unknown[]) => unknown }> = [];
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
  };
}

const PAID_SUBSCRIPTION = {
  order_no: ORDER_NO,
  platform_order_no: PLATFORM_NO,
  account_id: 7,
  kind: "subscription",
  plan_id: "pro",
  duration_months: 3,
  units: null,
  status: "paid",
};

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("computeNextPeriod", () => {
  it("extends from the current period end for active accounts", () => {
    const period = computeNextPeriod({ plan_status: "active", current_period_end: "2026-12-01T00:00:00Z" }, 3);
    expect(period.periodStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(period.resumedFromNow).toBe(false);
  });

  it("restarts from now for expired accounts", () => {
    const period = computeNextPeriod({ plan_status: "expired", current_period_end: "2026-01-01T00:00:00Z" }, 1, Date.parse("2026-11-08T00:00:00Z"));
    expect(period.periodStart.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(period.resumedFromNow).toBe(true);
  });
});

describe("fulfillPaidOrder", () => {
  it("grants a plan wallet, expires old plan wallets and advances the account period atomically", async () => {
    const h = harness(PAID_SUBSCRIPTION);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("BILLING_PLAN_PRICES", JSON.stringify({ pro: { amount: 14900, includedSau: 300, durationMonths: 1 } }));
    h.on("FROM payment_orders WHERE order_no = ? FOR UPDATE", () => [PAID_SUBSCRIPTION]);
    h.on("FROM billing_accounts WHERE account_id = ? FOR UPDATE", () => [[ACCOUNT_ACTIVE]]);
    const result = await fulfillPaidOrder(PAID_SUBSCRIPTION);
    expect(result).toEqual({ fulfilled: true });
    // 旧周期 plan 钱包失效 + 新 plan 钱包（source_key = fulfillment:{platform_no}）granted
    expect(h.paramsOf("UPDATE billing_quota_wallets SET status = 'expired'")[0]).toEqual([7]);
    const walletInsert = h.paramsOf("INSERT INTO billing_quota_wallets")[0];
    expect(walletInsert).toMatchObject({ 1: "plan", 2: 300, 4: `sub:${PLATFORM_NO}`, 5: `fulfillment:${PLATFORM_NO}`, 6: 300 });
    // 账户周期推进（3 个月 = 90 天）
    expect(h.sqls().some((sql) => sql.includes("SET plan_id = ?, plan_status = 'active'"))).toBe(true);
    // 订单 fulfilled
    expect(h.paramsOf("UPDATE payment_orders SET status = 'fulfilled'")[0]).toEqual([ORDER_NO]);
    expect(h.conns[0].commit).toHaveBeenCalledOnce();
  });

  it("leaves the order paid without fulfilling when the plan is not configured", async () => {
    const h = harness(PAID_SUBSCRIPTION);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    delete process.env.BILLING_PLAN_PRICES;
    h.on("FROM payment_orders WHERE order_no = ? FOR UPDATE", () => [PAID_SUBSCRIPTION]);
    const result = await fulfillPaidOrder(PAID_SUBSCRIPTION);
    expect(result).toEqual({ fulfilled: false });
    expect(h.conns[0].rollback).toHaveBeenCalledOnce();
    expect(h.sqls().some((sql) => sql.includes("UPDATE payment_orders SET status = 'fulfilled'"))).toBe(false);
  });

  it("is a no-op for orders that are not in paid state (idempotent, three-way concurrency)", async () => {
    const h = harness({ ...PAID_SUBSCRIPTION, status: "fulfilled" });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("FROM payment_orders WHERE order_no = ? FOR UPDATE", () => [{ ...PAID_SUBSCRIPTION, status: "fulfilled" }]);
    const result = await fulfillPaidOrder(PAID_SUBSCRIPTION);
    expect(result).toEqual({ fulfilled: false });
    expect(h.conns[0].commit).toHaveBeenCalledOnce();
    expect(h.sqls().some((sql) => sql.includes("INSERT INTO billing_quota_wallets"))).toBe(false);
  });

  it("grants a 12-month pack wallet for overage orders", async () => {
    const h = harness({ ...PAID_SUBSCRIPTION, kind: "overage_pack", plan_id: null, duration_months: null, units: 200 });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.on("FROM payment_orders WHERE order_no = ? FOR UPDATE", () => [{ ...PAID_SUBSCRIPTION, kind: "overage_pack", plan_id: null, duration_months: null, units: 200 }]);
    const result = await fulfillPaidOrder({ ...PAID_SUBSCRIPTION, kind: "overage_pack", units: 200 } as never);
    expect(result).toEqual({ fulfilled: true });
    const walletInsert = h.paramsOf("INSERT INTO billing_quota_wallets")[0];
    expect(walletInsert).toHaveLength(7);
    expect(walletInsert[1]).toBe("pack");
    expect(walletInsert[2]).toBe(200);
    expect(walletInsert[5]).toBe(`pack:${PLATFORM_NO}`);
    expect(walletInsert[6]).toBe(200);
  });
});

describe("chandler webhook signature and payload", () => {
  it("verifies HMAC with the derived key (sha256_hex of client secret)", () => {
    vi.stubEnv("CHANDLER_CLIENT_SECRET", "secret-1");
    delete process.env.CHANDLER_WEBHOOK_API_KEY;
    const body = '{"platform_order_no":"PO123","status":"paid"}';
    const { createHash, createHmac } = require("node:crypto");
    const key = createHash("sha256").update("secret-1").digest("hex");
    const signature = createHmac("sha256", key).update(body, "utf8").digest("hex");
    expect(verifyChandlerWebhookSignature(body, signature)).toBe(true);
    expect(verifyChandlerWebhookSignature(body, "deadbeef")).toBe(false);
    expect(verifyChandlerWebhookSignature(body, null)).toBe(false);
  });

  it("parses the payload and rejects incomplete ones", () => {
    expect(parseChandlerWebhookPayload('{"platform_order_no":"PO1","status":"paid"}')).toEqual({ platformOrderNo: "PO1", status: "paid" });
    expect(parseChandlerWebhookPayload('{"status":"paid"}')).toBeNull();
    expect(parseChandlerWebhookPayload("not json")).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewRefund } from "../lib/pay-refunds";
import { getDb } from "../lib/db";
import { BillingError } from "../lib/billing/core";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const ORDER = {
  order_no: "NO-1",
  platform_order_no: "CH-1",
  account_id: 7,
  kind: "subscription",
  duration_months: 3,
  units: null,
  amount: 9000,
  status: "paid",
  refund_status: "none",
  paid_at: new Date(Date.now() - 10 * 86_400_000),
  plan_id: "creator",
};

function harness(orderRow: Record<string, unknown> | null, extra: { walletRows?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM payment_orders WHERE order_no")) {
        if (!orderRow) return [[], []];
        // 模拟 DB 侧 GREATEST(0, FLOOR(TIMESTAMPDIFF(SECOND, paid_at, NOW(3))/86400))：两侧同为墙钟
        const served = Math.max(0, Math.floor((Date.now() - new Date(orderRow.paid_at as unknown as string).getTime()) / 86_400_000));
        return [[{ ...orderRow, servedDays: served }], []];
      }
      if (sql.includes("FROM billing_quota_wallets WHERE source_key")) return [extra.walletRows ?? [], []];
      return [[], []];
    }),
  };
  return { db, calls, sqls: () => calls.map((c) => c.sql) };
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

describe("previewRefund（订阅折算）", () => {
  it("computes servedDays in SQL against the DB wall clock (timezone:'Z' parsing runs 8h ahead)", async () => {
    // paid_at 是 DB 墙钟 CURRENT_TIMESTAMP：JS 侧 Date.now() 相减在前 8 小时为负、
    // 长期少算一天——服务天数必须在 SQL 侧与 NOW(3) 比较
    const h = harness({ ...ORDER });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const preview = await previewRefund("NO-1");
    const loadSql = h.calls.find((c) => c.sql.includes("FROM payment_orders WHERE order_no"))!.sql;
    expect(loadSql).toContain("TIMESTAMPDIFF");
    expect(loadSql).toContain("NOW(3)");
    expect(preview.servedDays).toBe(10);
    expect(preview.remainingDays).toBe(80);
    expect(preview.totalDays).toBe(90);
    expect(preview.suggestedAmount).toBe(8000);
  });

  it("clamps negative served days to zero and suggests a full refund inside the first day", async () => {
    const h = harness({ ...ORDER, paid_at: new Date() });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const preview = await previewRefund("NO-1");
    expect(preview.servedDays).toBe(0);
    expect(preview.suggestedAmount).toBe(9000);
  });

  it("prorates overage packs by remaining SAU and returns full amount for non-refundable orders", async () => {
    const h = harness({ ...ORDER, kind: "overage_pack", duration_months: null, units: 100 }, { walletRows: [{ remaining_sau: 25 }] });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const pack = await previewRefund("NO-1");
    expect(pack.suggestedAmount).toBe(2250);
    const gone = harness(null);
    vi.mocked(getDb).mockReturnValue(gone.db as never);
    await expect(previewRefund("NO-404")).rejects.toMatchObject({ code: "billing_state_conflict" });
  });
});

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processChandlerWebhook } from "../lib/pay-webhook";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));
vi.mock("../lib/pay-orders", () => ({ markPaidAndFulfill: vi.fn(async () => undefined) }));
vi.mock("../lib/pay-refunds", () => ({ confirmRefundFromRemote: vi.fn(async () => undefined) }));

process.env.CHANDLER_WEBHOOK_API_KEY = "hook-secret-test";

const rawBody = JSON.stringify({ platform_order_no: "CH-100", status: "paid" });
const signature = createHmac("sha256", "hook-secret-test").update(rawBody).digest("hex");

interface ConnState {
  insertAffected: number;
  orderRow: Record<string, unknown> | null;
  executeError: Error | null;
}

/** SQL 路由 harness：模拟「事件先落库 → 订单定位 → raw_notify」两段事务。 */
function harness(state: ConnState) {
  const conns: Array<{ rollback: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> }> = [];
  const db = {
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string) => {
          if (state.executeError) throw state.executeError;
          if (sql.includes("INSERT IGNORE INTO chandler_webhook_events")) return [{ affectedRows: state.insertAffected }];
          if (sql.includes("FROM payment_orders WHERE platform_order_no")) return state.orderRow ? [[state.orderRow]] : [[]];
          return [{}];
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
  return { db, conns, rollbacks: () => conns.filter((c) => c.rollback.mock.calls.length > 0).length, releases: () => conns.filter((c) => c.release.mock.calls.length > 0).length };
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
  vi.clearAllMocks();
});

describe("processChandlerWebhook 重试契约", () => {
  it("returns 404 for an unknown order and rolls back the event row so platform retries can be processed", async () => {
    const h = harness({ insertAffected: 1, orderRow: null, executeError: null });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await processChandlerWebhook(rawBody, signature);
    expect(result.status).toBe(404);
    // 事件行必须回收：否则平台重试撞唯一键被 200 duplicate ACK 吞掉，订单永远等不到 webhook
    expect(h.db.getConnection.mock.calls.length).toBeGreaterThanOrEqual(2);
    const cleanup = h.conns.at(-1)!;
    expect(cleanup.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM chandler_webhook_events"), ["CH-100", "paid", expect.any(String)]);
  });

  it("rolls back the event row when fulfillment processing fails so the platform retry re-enters", async () => {
    const h = harness({ insertAffected: 1, orderRow: { order_no: "NO-1", status: "pending", refund_status: "none" }, executeError: null });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const { markPaidAndFulfill } = await import("../lib/pay-orders");
    vi.mocked(markPaidAndFulfill).mockRejectedValueOnce(new Error("wallet grant failed"));
    const result = await processChandlerWebhook(rawBody, signature);
    expect(result.status).toBe(500);
    const cleanup = h.conns.at(-1)!;
    expect(cleanup.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM chandler_webhook_events"), ["CH-100", "paid", expect.any(String)]);
  });

  it("acks a replayed event as duplicate (200) without re-processing", async () => {
    const h = harness({ insertAffected: 0, orderRow: { order_no: "NO-1", status: "pending", refund_status: "none" }, executeError: null });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const result = await processChandlerWebhook(rawBody, signature);
    expect(result.body).toMatchObject({ ok: true, duplicate: true });
    expect(result.status).toBe(200);
  });
});

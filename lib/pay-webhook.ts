import { createHash } from "node:crypto";
import { getDb } from "./db";
import { markPaidAndFulfill } from "./pay-orders";
import { verifyChandlerWebhookSignature, parseChandlerWebhookPayload } from "./chandler-pay";
import { confirmRefundFromRemote } from "./pay-refunds";

/**
 * Chandler webhook 处理（契约 M3-T0 §3，P5/P6）：验签 → 事件先落库（唯一键防重）→ 订单状态机推进。
 * 未知单回 404（平台重试；我方建单回填可能晚于首次回调）；重复事件 ACK 跳过；异常 500（平台重试）。
 */

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function processChandlerWebhook(rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  if (!verifyChandlerWebhookSignature(rawBody, signature)) {
    console.error("[billing] chandler webhook signature verification failed");
    return { status: 401, body: { error: "invalid_signature" } };
  }
  const payload = parseChandlerWebhookPayload(rawBody);
  if (!payload) return { status: 400, body: { error: "invalid_payload" } };
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");

  // 窄化后的局部量（闭包内 TS 不继承 const 形参窄化时的别名推断）
  const platformOrderNo: string = payload.platformOrderNo;
  const status: string = payload.status;
  const db = getDb();
  // 事务 C：事件先落库（P5）——撞唯一键 = 重复事件，直接 ACK
  const eventConn = await db.getConnection();
  try {
    await eventConn.beginTransaction();
    const [result] = await eventConn.execute(
      `INSERT IGNORE INTO chandler_webhook_events (platform_order_no, status, body_hash) VALUES (?, ?, ?)`,
      [payload.platformOrderNo, payload.status, bodyHash],
    );
    const inserted = Number((result as { affectedRows?: number }).affectedRows ?? 0);
    await eventConn.commit();
    eventConn.release();
    if (inserted === 0) return { status: 200, body: { ok: true, duplicate: true } };
  } catch (error) {
    await eventConn.rollback();
    eventConn.release();
    console.error("[billing] webhook event persist failed", error);
    return { status: 500, body: { error: "event_persist_failed" } };
  }

  /** 回收事件行：本次投递未推进订单（未知单/处理失败）时删除，让平台的同报文重试能重新进入处理——
   *  否则重试撞唯一键被 200 duplicate ACK 吞掉，订单永远等不到 webhook。 */
  async function forgetWebhookEvent(): Promise<void> {
    const cleanup = await db.getConnection();
    try {
      await cleanup.execute(
        `DELETE FROM chandler_webhook_events WHERE platform_order_no = ? AND status = ? AND body_hash = ?`,
        [platformOrderNo, status, bodyHash],
      );
    } catch (cleanupError) {
      console.warn("[billing] webhook event cleanup failed; platform retry may be swallowed once", cleanupError);
    } finally {
      cleanup.release();
    }
  }

  // 事务 D：订单定位 + raw_notify 落库（未知单 404 让平台重试；我方建单回填可能晚于首次回调）
  const conn = await db.getConnection();
  let orderNo: string | null = null;
  try {
    await conn.beginTransaction();
    const [orderRows] = await conn.execute(
      `SELECT order_no, status, refund_status FROM payment_orders WHERE platform_order_no = ? FOR UPDATE`,
      [payload.platformOrderNo],
    );
    const order = (orderRows as Array<{ order_no: string; status: string; refund_status: string }>)[0];
    if (!order) {
      await conn.rollback();
      console.error("[billing] chandler webhook for unknown platform order", { platformOrderNo: payload.platformOrderNo });
    } else {
      await conn.execute(`UPDATE payment_orders SET raw_notify = ? WHERE order_no = ?`, [rawBody.slice(0, 4000), order.order_no]);
      await conn.commit();
      orderNo = order.order_no;
    }
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // 事务可能尚未建立
    }
    conn.release();
    console.error("[billing] chandler webhook order lookup failed", error);
    await forgetWebhookEvent();
    return { status: 500, body: { error: "processing_failed" } };
  }
  conn.release();

  if (orderNo === null) {
    await forgetWebhookEvent();
    return { status: 404, body: { error: "unknown_order" } };
  }

  // 状态机推进在事务外（markPaidAndFulfill/confirmRefund 自持事务）；失败回收事件行让平台重试
  try {
    if (payload.status === "paid") {
      await markPaidAndFulfill(orderNo);
    } else if (payload.status === "refunded") {
      await confirmRefundFromRemote(orderNo);
    } else {
      // closed/其他平台态：原样记录（订单状态机不推进，raw_notify 已落）
      console.log("[billing] chandler webhook status recorded", { orderNo, status: payload.status });
    }
    return { status: 200, body: { ok: true } };
  } catch (error) {
    console.error("[billing] chandler webhook processing failed", error);
    await forgetWebhookEvent();
    return { status: 500, body: { error: "processing_failed" } };
  }
}

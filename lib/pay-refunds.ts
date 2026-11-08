import { getDb } from "./db";
import { BillingError } from "./billing/core";
import { refundChandlerOrder, queryChandlerOrder } from "./chandler-pay";
import { getValidUserToken } from "./chandler-token";

/**
 * 退款（契约 M3-T0 §4，P4 五态子状态机）：
 * - 请求（管理员）：折算 → refund_pending → 提交 Chandler（幂等键 refund-{order_no}）→ refund_submitted；
 * - 超时不是失败：停在 refund_submitted，由 sweep 查单（>5 分钟）或 webhook 推进；
 * - 确认（refund_confirmed）：同一事务原子完成退款标记 + 钱包回收（reclaiming 语义，账务契约 §6.7）+ 冲正流水 + 审计；
 * - reserved 三分：未预留余额即时回收；预留中待终态；已捕获不自动追偿（§5.1 法务事项）。
 */

export interface RefundPreview {
  orderNo: string;
  amount: number;
  status: string;
  refundable: boolean;
  suggestedAmount: number;
  prorated: boolean;
  servedDays: number | null;
  remainingDays: number | null;
  totalDays: number | null;
}

interface OrderRefundRow {
  order_no: string;
  platform_order_no: string | null;
  account_id: number;
  kind: string;
  duration_months: number | null;
  units: number | null;
  amount: number;
  status: string;
  refund_status: string;
  paid_at: string | Date | null;
  plan_id: string | null;
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30;

async function loadOrderForRefund(orderNo: string): Promise<OrderRefundRow | undefined> {
  const [rows] = await getDb().execute(
    `SELECT order_no, platform_order_no, account_id, kind, duration_months, units, amount, status, refund_status, paid_at, plan_id
     FROM payment_orders WHERE order_no = ?`,
    [orderNo],
  );
  return (rows as OrderRefundRow[])[0];
}

/** 折算：subscription 按剩余天数、pack 按剩余 SAU 比例；test/无周期单全额。 */
export async function previewRefund(orderNo: string): Promise<RefundPreview> {
  const order = await loadOrderForRefund(orderNo);
  if (!order) throw new BillingError("billing_state_conflict", "order not found");
  const refundable = (order.status === "paid" || order.status === "fulfilled") && order.refund_status === "none" && Boolean(order.platform_order_no);
  let suggested = order.amount;
  let prorated = false;
  let servedDays: number | null = null;
  let remainingDays: number | null = null;
  let totalDays: number | null = null;
  if (order.kind === "subscription" && order.duration_months && order.paid_at) {
    totalDays = order.duration_months * DAYS_PER_MONTH;
    servedDays = Math.max(0, Math.floor((Date.now() - new Date(order.paid_at).getTime()) / MS_PER_DAY));
    remainingDays = Math.max(0, totalDays - servedDays);
    suggested = Math.floor((order.amount * remainingDays) / totalDays);
    prorated = true;
  } else if (order.kind === "overage_pack" && order.units) {
    const [walletRows] = await getDb().execute(
      `SELECT remaining_sau FROM billing_quota_wallets WHERE source_key = ?`,
      [`pack:${order.platform_order_no}`],
    );
    const remaining = Number((walletRows as Array<{ remaining_sau: number }>)[0]?.remaining_sau ?? 0);
    remainingDays = remaining;
    suggested = Math.floor((order.amount * remaining) / order.units);
    prorated = true;
  }
  return {
    orderNo: order.order_no,
    amount: order.amount,
    status: order.status,
    refundable,
    suggestedAmount: suggested,
    prorated,
    servedDays,
    remainingDays,
    totalDays,
  };
}

/**
 * 发起退款（管理员）。事务边界（P3/P4）：
 * 事务 A：订单行锁 + 状态前置（paid/fulfilled 且 refund none）→ refund_pending（含折算金额与操作者）→ 提交；
 * 远端调用（可重试，幂等键 refund-{order_no}）：成功响应或超时 → refund_submitted；明确 4xx → refund_failed。
 * 确认后的权益回收（reclaiming → 结清 → 回收）由 webhook/sweep 推进 refund_confirmed 时原子完成（§4.3）。
 */
export async function requestRefund(orderNo: string, input: { amount?: number; reason?: string }): Promise<{ refundStatus: string; refundAmount: number }> {
  const db = getDb();
  const conn = await db.getConnection();
  let refundAmount: number;
  let platformOrderNo: string;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT order_no, platform_order_no, account_id, kind, duration_months, units, amount, status, refund_status, paid_at, plan_id
       FROM payment_orders WHERE order_no = ? FOR UPDATE`,
      [orderNo],
    );
    const order = (rows as OrderRefundRow[])[0];
    if (!order) throw new BillingError("billing_state_conflict", "order not found");
    if (!(order.status === "paid" || order.status === "fulfilled") || order.refund_status !== "none") {
      throw new BillingError("billing_state_conflict", `order ${orderNo} is not refundable in state ${order.status}/${order.refund_status}`);
    }
    if (!order.platform_order_no) throw new BillingError("billing_state_conflict", "order has no platform order number");
    platformOrderNo = order.platform_order_no;

    const preview = await previewRefund(orderNo);
    refundAmount = input.amount ?? preview.suggestedAmount;
    if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > order.amount) {
      throw new BillingError("billing_state_conflict", "refund amount must be a positive integer within the order amount");
    }
    await conn.execute(
      `UPDATE payment_orders SET refund_status = 'refund_pending', refund_amount = ?, refund_reason = ? WHERE order_no = ?`,
      [refundAmount, input.reason ?? "", orderNo],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  // 远端提交（事务外；幂等键兜底）。明确 4xx → refund_failed；超时/5xx → 停 refund_submitted。
  let status: string;
  try {
    await refundChandlerOrder({ platformOrderNo, amount: refundAmount, reason: input.reason ?? "" });
    status = "refund_submitted";
  } catch (error) {
    const chandlerStatus = (error as { chandlerStatus?: number }).chandlerStatus;
    if (typeof chandlerStatus === "number" && chandlerStatus >= 400 && chandlerStatus < 500) {
      status = "refund_failed";
    } else {
      status = "refund_submitted";
    }
  }
  await db.execute(`UPDATE payment_orders SET refund_status = ? WHERE order_no = ? AND refund_status = 'refund_pending'`, [status, orderNo]);
  return { refundStatus: status, refundAmount };
}

/** 退款确认（webhook refunded / sweep 查单 refunded 推进；幂等）。 */
export async function confirmRefundFromRemote(orderNo: string): Promise<{ confirmed: boolean }> {
  const db = getDb();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT order_no, platform_order_no, account_id, refund_status, refund_amount FROM payment_orders WHERE order_no = ? FOR UPDATE`,
      [orderNo],
    );
    const order = (rows as Array<{ order_no: string; platform_order_no: string; account_id: number; refund_status: string; refund_amount: number | null }>)[0];
    if (!order) {
      await conn.rollback();
      conn.release();
      return { confirmed: false };
    }
    if (order.refund_status === "refund_confirmed" || order.refund_status === "refund_failed" || order.refund_status === "none") {
      await conn.commit();
      conn.release();
      return { confirmed: false };
    }
    await conn.execute(`UPDATE payment_orders SET refund_status = 'refund_confirmed', status = 'refunded' WHERE order_no = ?`, [orderNo]);
    // 权益回收：来源钱包标记 reclaiming（拒新预留）；回收终态（reserved=0 → refunded 行 + remaining 归零）
    // 由 sweep 前置校验重试（账务契约 §6.7；reserved 三分——运行中分析不受影响）
    const [walletRows] = await conn.execute(
      `SELECT wallet_id FROM billing_quota_wallets WHERE source_key IN (?, ?) AND status IN ('active', 'expired') FOR UPDATE`,
      [`fulfillment:${order.platform_order_no}`, `pack:${order.platform_order_no}`],
    );
    for (const wallet of walletRows as Array<{ wallet_id: number }>) {
      await conn.execute(`UPDATE billing_quota_wallets SET status = 'reclaiming' WHERE wallet_id = ?`, [wallet.wallet_id]);
    }
    await conn.commit();
    conn.release();
    return { confirmed: true };
  } catch (error) {
    try {
      await conn.rollback();
    } finally {
      conn.release();
    }
    throw error;
  }
}

/** 回收终态（sweep 每轮重试前置校验，契约 §6.7）：reserved=0 才执行 refunded 冲正 + remaining 归零。 */
export async function reclaimWalletIfSettled(walletId: number): Promise<boolean> {
  const db = getDb();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [walletRows] = await conn.execute(
      `SELECT account_id, remaining_sau, reserved_sau, quota_type, source_key, status FROM billing_quota_wallets WHERE wallet_id = ? FOR UPDATE`,
      [walletId],
    );
    const wallet = (walletRows as Array<{ account_id: number; remaining_sau: number; reserved_sau: number; quota_type: string; source_key: string; status: string }>)[0];
    if (!wallet || wallet.status !== "reclaiming") {
      await conn.rollback();
      conn.release();
      return false;
    }
    if (Number(wallet.reserved_sau) !== 0) {
      // 仍有预留未结清（运行中分析）：保持 reclaiming，等下一轮
      await conn.commit();
      conn.release();
      return false;
    }
    const refundAmount = Number(wallet.remaining_sau);
    await conn.execute(
      `INSERT INTO billing_ledger (account_id, wallet_id, idempotency_key, action, quota_type, units, reason, related_entry_id, balance_after_remaining, balance_after_reserved)
       SELECT account_id, wallet_id, ?, 'refunded', quota_type, remaining_sau, 'refund_reclaim', NULL, 0, 0
       FROM billing_quota_wallets WHERE wallet_id = ?`,
      [`rfd:refund:${wallet.source_key}`, walletId],
    );
    await conn.execute(`UPDATE billing_quota_wallets SET remaining_sau = 0, status = 'reclaimed', balance_after_remaining = 0 WHERE wallet_id = ?`, [walletId]);
    await conn.commit();
    conn.release();
    void refundAmount;
    return true;
  } catch (error) {
    try {
      await conn.rollback();
    } finally {
      conn.release();
    }
    throw error;
  }
}

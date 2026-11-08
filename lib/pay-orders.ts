import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { BillingError } from "./billing/core";
import { getValidUserToken } from "./chandler-token";
import { createChandlerOrder, prepayChandlerOrder, queryChandlerOrder } from "./chandler-pay";
import { fulfillPaidOrder } from "./billing/fulfillment";
import { resolvePackOffer, resolvePlanOffer } from "./billing/pricing-plans";

/**
 * 支付订单服务（契约 M3-T0 §2/§3）：建单四段边界 + 查单对账 + webhook 履约。
 * 断链恢复矩阵见契约 §2.1——任何中间状态都有对账收敛路径。
 */

export interface CreatePaymentOrderInput {
  accountId: number;
  userId: number;
  kind: "subscription" | "overage_pack" | "test";
  planId?: string;
  packSku?: string;
  channel: "wechat" | "alipay";
}

export interface PaymentOrderResult {
  orderNo: string;
  status: string;
  amount: number;
  reused: boolean;
  prepay: { codeUrl?: string | null; payUrl?: string | null; h5Url?: string | null };
}

function newOrderNo(accountId: number) {
  return `cdlp_${accountId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

/** 建单四段边界（契约 §2.1）：本地 pending（复用 30 分钟内同参数单）→ 远端建单 → 回写 → prepay 回写。 */
export async function createPaymentOrder(input: CreatePaymentOrderInput): Promise<PaymentOrderResult> {
  let amount = 0;
  let subject = "";
  let planId: string | null = null;
  let packSku: string | null = null;
  let durationMonths: number | null = null;
  let units: number | null = null;

  if (input.kind === "test") {
    amount = 1;
    subject = "CoDelphi 测试支付";
  } else if (input.kind === "subscription") {
    if (!input.planId) throw new BillingError("billing_state_conflict", "subscription order requires planId");
    const offer = resolvePlanOffer(input.planId);
    if (!offer) throw new BillingError("billing_state_conflict", `plan ${input.planId} is not available for sale`);
    planId = input.planId;
    durationMonths = offer.durationMonths;
    amount = offer.amount * offer.durationMonths;
    subject = `CoDelphi ${input.planId} 订阅（${offer.durationMonths} 个月）`;
  } else {
    if (!input.packSku) throw new BillingError("billing_state_conflict", "overage order requires packSku");
    const offer = resolvePackOffer(input.packSku);
    if (!offer) throw new BillingError("billing_state_conflict", `pack ${input.packSku} is not available for sale`);
    packSku = input.packSku;
    units = offer.units;
    amount = offer.amount;
    subject = `CoDelphi 超额包（${offer.units} SAU）`;
  }

  const db = getDb();
  const conn = await db.getConnection();
  let orderNo: string;
  try {
    await conn.beginTransaction();
    // 30 分钟内同账户同参数 pending 单复用（契约 §7.0；防重复点单产生多张待付单）
    const [reuseRows] = await conn.execute(
      `SELECT order_no FROM payment_orders
       WHERE account_id = ? AND user_id = ? AND kind = ? AND plan_id <=> ? AND pack_sku <=> ?
         AND amount = ? AND status = 'pending' AND platform_order_no IS NOT NULL
         AND created_at >= DATE_SUB(NOW(3), INTERVAL 30 MINUTE)
       ORDER BY created_at DESC LIMIT 1`,
      [input.accountId, input.userId, input.kind, planId, packSku, amount],
    );
    const reuse = (reuseRows as Array<{ order_no: string }>)[0];
    if (reuse) {
      orderNo = reuse.order_no;
      await conn.execute(`UPDATE payment_orders SET channel = ? WHERE order_no = ?`, [input.channel, orderNo]);
    } else {
      orderNo = newOrderNo(input.accountId);
      await conn.execute(
        `INSERT INTO payment_orders (order_no, account_id, user_id, kind, plan_id, pack_sku, duration_months, units, channel, amount, subject)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderNo, input.accountId, input.userId, input.kind, planId, packSku, durationMonths, units, input.channel, amount, subject],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  // 远端建单（幂等键 = order_no）；prepay 失败不影响订单存在（查单/对账可恢复）
  const userToken = await getValidUserToken(input.userId);
  const { platformOrderNo } = await createChandlerOrder(
    { orderNo, channel: input.channel, amount, currency: "CNY", subject, source: "codelphi" },
    userToken,
  );
  const conn2 = await db.getConnection();
  try {
    await conn2.execute(`UPDATE payment_orders SET platform_order_no = ? WHERE order_no = ? AND platform_order_no IS NULL`, [platformOrderNo, orderNo]);
  } finally {
    conn2.release();
  }
  const prepay = await prepayChandlerOrder(platformOrderNo, userToken);
  const conn3 = await db.getConnection();
  try {
    await conn3.execute(
      `UPDATE payment_orders SET prepay_code_url = ?, prepay_pay_url = ?, prepay_h5_url = ? WHERE order_no = ?`,
      [prepay.codeUrl ?? null, prepay.payUrl ?? null, prepay.h5Url ?? null, orderNo],
    );
  } finally {
    conn3.release();
  }
  return { orderNo, status: "pending", amount, reused: false, prepay };
}

export interface OrderView {
  orderNo: string;
  platformOrderNo: string | null;
  kind: string;
  status: string;
  refundStatus: string;
  amount: number;
  createdAt: string | Date;
  prepay: { codeUrl?: string | null; payUrl?: string | null; h5Url?: string | null };
}

interface OrderDbRow {
  orderNo: string;
  platformOrderNo: string | null;
  user_id: number;
  kind: string;
  status: string;
  refundStatus: string;
  amount: number;
  createdAt: string | Date;
  prepayCodeUrl: string | null;
  prepayPayUrl: string | null;
  prepayH5Url: string | null;
}

/** 查单（契约 §2.2）：本人订单；pending 超 20 秒未收 webhook 时向 Chandler 对账一次（与 webhook 共用履约函数）。 */
export async function getOrderWithReconcile(orderNo: string, userId: number): Promise<OrderView | null> {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT order_no AS orderNo, platform_order_no AS platformOrderNo, user_id AS userId, kind, status,
            refund_status AS refundStatus, amount, created_at AS createdAt,
            prepay_code_url AS prepayCodeUrl, prepay_pay_url AS prepayPayUrl, prepay_h5_url AS prepayH5Url
     FROM payment_orders WHERE order_no = ?`,
    [orderNo],
  );
  const row = (rows as unknown as OrderDbRow[])[0];
  if (!row || Number(row.user_id) !== Number(userId)) return null;

  if (row.status === "pending" && row.platformOrderNo && Date.now() - new Date(row.createdAt).getTime() > 20_000) {
    try {
      const userToken = await getValidUserToken(Number(row.user_id));
      const remote = await queryChandlerOrder(row.platformOrderNo, userToken);
      if (remote.status === "paid") {
        await markPaidAndFulfill(orderNo);
      } else if (remote.status !== "paid" && remote.status !== "unknown") {
        await db.execute(`UPDATE payment_orders SET status = ? WHERE order_no = ? AND status = 'pending'`, [remote.status, orderNo]);
      }
    } catch (error) {
      // 对账失败（网络/4xx）不阻塞，返回本地状态（AIRecord 口径）
      console.warn("[billing] order reconcile failed", { orderNo, error });
    }
  }

  const [fresh] = await db.execute(
    `SELECT order_no AS orderNo, platform_order_no AS platformOrderNo, kind, status,
            refund_status AS refundStatus, amount, created_at AS createdAt,
            prepay_code_url AS prepayCodeUrl, prepay_pay_url AS prepayPayUrl, prepay_h5_url AS prepayH5Url
     FROM payment_orders WHERE order_no = ?`,
    [orderNo],
  );
  const finalRow = (fresh as unknown as OrderDbRow[])[0];
  if (!finalRow) return null;
  return {
    orderNo: finalRow.orderNo,
    platformOrderNo: finalRow.platformOrderNo,
    kind: finalRow.kind,
    status: finalRow.status,
    refundStatus: finalRow.refundStatus,
    amount: finalRow.amount,
    createdAt: finalRow.createdAt,
    prepay: { codeUrl: finalRow.prepayCodeUrl, payUrl: finalRow.prepayPayUrl, h5Url: finalRow.prepayH5Url },
  };
}

/** 平台 paid 落账 + 履约（webhook/查单/sweep 三方共用；幂等由状态前置 + 履约行锁保证）。 */
export async function markPaidAndFulfill(orderNo: string): Promise<void> {
  const db = getDb();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT order_no, platform_order_no, account_id, kind, plan_id, duration_months, units, status
       FROM payment_orders WHERE order_no = ? FOR UPDATE`,
      [orderNo],
    );
    const order = (rows as import("./billing/fulfillment").PaidOrderRow[])[0];
    if (!order) {
      await conn.commit();
      conn.release();
      return;
    }
    if (order.status === "pending" || order.status === "closed") {
      // closed → paid 复活：真实支付优先（契约 §1 不变式 4）
      await conn.execute(
        `UPDATE payment_orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP(3) WHERE order_no = ? AND status IN ('pending', 'closed')`,
        [orderNo],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  await fulfillPaidOrder({ ...(await loadPaidOrder(orderNo)), status: "paid" } as import("./billing/fulfillment").PaidOrderRow);
}

async function loadPaidOrder(orderNo: string): Promise<import("./billing/fulfillment").PaidOrderRow | undefined> {
  const [rows] = await getDb().execute(
    `SELECT order_no, platform_order_no, account_id, kind, plan_id, duration_months, units, status FROM payment_orders WHERE order_no = ?`,
    [orderNo],
  );
  return (rows as import("./billing/fulfillment").PaidOrderRow[])[0];
}

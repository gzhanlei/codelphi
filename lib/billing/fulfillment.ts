import type { PoolConnection } from "mysql2/promise";
import { getDb } from "../db";

/**
 * 支付履约（契约 M3-T0 §2.3，P2）：三方（webhook / 查单对账 / sweep）共用唯一实现。
 * 幂等键 = platform_order_no，行锁下执行；履约、ledger 入账与订单状态推进同一事务；
 * 履约失败订单停留 paid，由 sweep 恢复（不静默回退）。
 */

export interface PaidOrderRow {
  order_no: string;
  platform_order_no: string;
  account_id: number;
  kind: string;
  plan_id: string | null;
  duration_months: number | null;
  units: number | null;
  status: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const DAYS_PER_MONTH = 30;

/** 周期顺延/重新起算（契约 §7.0）：active 内顺延（从当前周期末 + N×30 天）；grace/expired 内重新起算（从当前时刻）。 */
export function computeNextPeriod(
  account: { plan_status: string; current_period_end: Date | string | null },
  durationMonths: number,
  now = Date.now(),
): { periodStart: Date; periodEnd: Date; resumedFromNow: boolean } {
  const span = durationMonths * DAYS_PER_MONTH * MS_PER_DAY;
  const currentEnd = account.current_period_end ? new Date(account.current_period_end).getTime() : null;
  if (account.plan_status === "active" && currentEnd !== null && currentEnd > now) {
    return { periodStart: new Date(currentEnd), periodEnd: new Date(currentEnd + span), resumedFromNow: false };
  }
  return { periodStart: new Date(now), periodEnd: new Date(now + span), resumedFromNow: true };
}

/** 旧周期 plan 钱包失效（与新周期发放同一事务，契约 §3.1）。 */
async function expireOldPlanWallets(conn: PoolConnection, accountId: number) {
  await conn.execute(
    `UPDATE billing_quota_wallets SET status = 'expired' WHERE account_id = ? AND quota_type = 'plan' AND status = 'active'`,
    [accountId],
  );
}

async function insertGrantedWallet(
  conn: PoolConnection,
  input: { accountId: number; quotaType: string; units: number; sourceKey: string; expiresAt: Date | null; periodId: string | null },
): Promise<number> {
  const [result] = await conn.execute(
    `INSERT INTO billing_quota_wallets (account_id, quota_type, remaining_sau, reserved_sau, expires_at, period_id, source_key, status, balance_after_remaining, balance_after_reserved)
     VALUES (?, ?, ?, 0, ?, ?, ?, 'active', ?, 0)`,
    [input.accountId, input.quotaType, input.units, input.expiresAt, input.periodId, input.sourceKey, input.units],
  );
  const walletId = Number((result as { insertId: number }).insertId);
  await conn.execute(
    `INSERT INTO billing_ledger (account_id, wallet_id, idempotency_key, action, quota_type, units, balance_after_remaining, balance_after_reserved)
     VALUES (?, ?, ?, 'granted', ?, ?, ?, 0)`,
    [input.accountId, walletId, `grt:${input.sourceKey}`, input.quotaType, input.units, input.units],
  );
  return walletId;
}

/**
 * 履约已支付订单。幂等：订单行锁 + status='paid' 前置——重复调用/三方并发只有一次生效。
 * subscription：周期顺延或重新起算 + 旧周期钱包失效 + 新 plan 钱包发放；
 * overage_pack：12 个月 pack 钱包。
 */
export async function fulfillPaidOrder(order: PaidOrderRow): Promise<{ fulfilled: boolean }> {
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();
    const [orderRows] = await conn.execute(
      `SELECT order_no, platform_order_no, account_id, kind, plan_id, duration_months, units, status
       FROM payment_orders WHERE order_no = ? FOR UPDATE`,
      [order.order_no],
    );
    const row = (orderRows as PaidOrderRow[])[0];
    if (!row) {
      await conn.rollback();
      conn.release();
      return { fulfilled: false };
    }
    if (row.status !== "paid") {
      // fulfilled/other：幂等跳过（三方并发只有一次生效）
      await conn.commit();
      conn.release();
      return { fulfilled: false };
    }
    if (row.kind === "subscription" && row.plan_id && row.duration_months) {
      const { resolvePlanOffer } = await import("./pricing-plans");
      const offer = resolvePlanOffer(row.plan_id);
      if (!offer) {
        // 履约前置：套餐未配置定价 = 配置错误，不履约（订单停留 paid，sweep 告警恢复）
        console.error(`[billing] plan ${row.plan_id} has no configured pricing at fulfillment; order stays paid`);
        await conn.rollback();
        conn.release();
        return { fulfilled: false };
      }
      const [accountRows] = await conn.execute(
        `SELECT plan_status, current_period_end FROM billing_accounts WHERE account_id = ? FOR UPDATE`,
        [row.account_id],
      );
      const account = (accountRows as Array<{ plan_status: string; current_period_end: Date | string | null }>)[0];
      const period = computeNextPeriod(account ?? { plan_status: "active", current_period_end: null }, row.duration_months);
      await expireOldPlanWallets(conn, row.account_id);
      await insertGrantedWallet(conn, {
        accountId: row.account_id,
        quotaType: "plan",
        units: offer.includedSau,
        sourceKey: `fulfillment:${row.platform_order_no}`,
        expiresAt: null,
        periodId: `sub:${row.platform_order_no}`,
      });
      await conn.execute(
        `UPDATE billing_accounts
         SET plan_id = ?, plan_status = 'active', current_period_start = ?, current_period_end = ?, grace_until = NULL, version = version + 1
         WHERE account_id = ?`,
        [row.plan_id, period.periodStart, period.periodEnd, row.account_id],
      );
    } else if (row.kind === "overage_pack" && row.units) {
      const expiresAt = new Date(Date.now() + 365 * MS_PER_DAY);
      await insertGrantedWallet(conn, {
        accountId: row.account_id,
        quotaType: "pack",
        units: row.units,
        sourceKey: `pack:${row.platform_order_no}`,
        expiresAt,
        periodId: null,
      });
    }
    await conn.execute(`UPDATE payment_orders SET status = 'fulfilled', fulfilled_at = CURRENT_TIMESTAMP(3) WHERE order_no = ?`, [row.order_no]);
    await conn.commit();
    conn.release();
    return { fulfilled: true };
  } catch (error) {
    try {
      await conn.rollback();
    } finally {
      conn.release();
    }
    throw error;
  }
}

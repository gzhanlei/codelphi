import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getDb } from "../lib/db";
import { fulfillPaidOrder } from "../lib/billing/fulfillment";
import { resolvePlanOffer } from "../lib/billing/pricing-plans";

/**
 * 运营手工开套餐：给指定邮箱用户的个人工作区账户开通订阅。
 * 走正规履约链路——造一条标记 paid 的订阅单（platform_order_no=manual-plan-<reason>，
 * 唯一键防重），再调 fulfillPaidOrder 完成原子激活（旧周期钱包失效 + plan 钱包发放 +
 * 账户周期顺延 + fulfilled 审计单据），不绕过任何账务语义。
 *
 * 用法:
 *   npx tsx scripts/billing-grant-plan.ts <email> [planId] [months] [reason]
 * 例:
 *   npx tsx scripts/billing-grant-plan.ts hanlei@gmail.com creator 1 manual-plan-2026-11-09
 */
async function main() {
  const [email, planIdArg, monthsArg, reasonArg] = process.argv.slice(2);
  if (!email) {
    console.error("usage: tsx scripts/billing-grant-plan.ts <email> [planId=creator] [months=1] [reason]");
    process.exit(1);
  }
  const planId = planIdArg ?? "creator";
  const durationMonths = Number(monthsArg ?? 1);
  const reason = reasonArg ?? `manual-plan-${new Date().toISOString().slice(0, 10)}`;
  if (!Number.isInteger(durationMonths) || durationMonths <= 0) throw new Error(`months must be a positive integer: ${monthsArg}`);

  const offer = resolvePlanOffer(planId);
  if (!offer) throw new Error(`plan ${planId} is not configured in BILLING_PLAN_PRICES; refusing to activate unpriced plan`);

  const conn = await getDb().getConnection();
  let accountId: number;
  let userId: number;
  try {
    const [userRows] = await conn.execute(`SELECT id, chandler_sub FROM users WHERE email = ? LIMIT 1`, [email]);
    const user = (userRows as Array<{ id: number; chandler_sub: string }>)[0];
    if (!user) throw new Error(`no user with email ${email}`);
    userId = Number(user.id);
    const [orgRows] = await conn.execute(`SELECT id FROM organizations WHERE slug = ? LIMIT 1`, [`u-${user.chandler_sub}`]);
    const orgRow = (orgRows as Array<{ id: number }>)[0];
    if (!orgRow) throw new Error(`user ${userId} has no personal workspace`);
    accountId = Number(orgRow.id);
  } finally {
    conn.release();
  }

  const orderNo = randomUUID();
  const platformOrderNo = `manual-plan-${reason}`;
  const inserted = await conn
    .execute(
      `INSERT INTO payment_orders
         (order_no, platform_order_no, account_id, user_id, kind, plan_id, duration_months, channel, amount, subject, status, paid_at)
       VALUES (?, ?, ?, ?, 'subscription', ?, ?, 'manual', ?, ?, 'paid', CURRENT_TIMESTAMP(3))`,
      [orderNo, platformOrderNo, accountId, userId, planId, durationMonths, offer.amount, `${planId} 套餐（运营手工开通：${reason}）`],
    )
    .then(() => true)
    .catch((error: { code?: string }) => {
      if (error.code === "ER_DUP_ENTRY") return false; // 同 reason 已开通过：直接查询现状返回
      throw error;
    });

  if (!inserted) {
    console.log(JSON.stringify({ activated: false, detail: `order with platform_order_no ${platformOrderNo} already exists` }, null, 2));
  } else {
    // fulfillPaidOrder 行锁重读订单，入参仅用于定位；补齐 PaidOrderRow 形状以满足类型
    const result = await fulfillPaidOrder({
      order_no: orderNo,
      platform_order_no: platformOrderNo,
      account_id: accountId,
      kind: "subscription",
      plan_id: planId,
      duration_months: durationMonths,
      units: null,
      status: "paid",
    });
    console.log(JSON.stringify({ activated: result.fulfilled, orderNo, planId, includedSau: offer.includedSau, amountFen: offer.amount, accountId, userId }, null, 2));
  }

  const [accountRows] = await conn.execute(
    `SELECT plan_id, plan_status, current_period_start, current_period_end FROM billing_accounts WHERE account_id = ?`,
    [accountId],
  );
  const [walletRows] = await conn.execute(
    `SELECT wallet_id, quota_type, remaining_sau, reserved_sau, status FROM billing_quota_wallets WHERE account_id = ? AND status = 'active' ORDER BY wallet_id`,
    [accountId],
  );
  console.log("ACCOUNT:", JSON.stringify((accountRows as unknown[])[0]));
  console.log("WALLETS:", JSON.stringify(walletRows));
  conn.release();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

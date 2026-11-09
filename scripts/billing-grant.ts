import "dotenv/config";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

/**
 * 运营充值：给指定邮箱的用户（其个人工作区账户）的 Trial 钱包发放额度。
 * 账务语义与 core.grantTrialQuota 一致：granted 流水 + 钱包 remaining += units + 快照；
 * 幂等键 grt:manual:{reason}:{wallet_id}——重复执行撞唯一键自动跳过（不重复发放）。
 *
 * 用法:
 *   npx tsx scripts/billing-grant.ts <email> <units> <reason>
 * 例:
 *   npx tsx scripts/billing-grant.ts hanlei@gmail.com 200 manual-topup-2026-11-09
 */
async function main() {
  const [email, unitsArg, reasonArg] = process.argv.slice(2);
  if (!email || !unitsArg || !reasonArg) {
    console.error("usage: tsx scripts/billing-grant.ts <email> <units> <reason>");
    process.exit(1);
  }
  const units = Number(unitsArg);
  if (!Number.isInteger(units) || units <= 0) throw new Error(`units must be a positive integer: ${unitsArg}`);

  const db = mysql.createPool(databaseConfig(true));
  const conn = await db.getConnection();
  const [userRows] = await conn.execute(`SELECT id, chandler_sub FROM users WHERE email = ? LIMIT 1`, [email]);
  const user = (userRows as Array<{ id: number; chandler_sub: string }>)[0];
  if (!user) throw new Error(`no user with email ${email}`);
  const [orgRows] = await conn.execute(`SELECT id, slug FROM organizations WHERE slug = ? LIMIT 1`, [`u-${user.chandler_sub}`]);
  const org = (orgRows as Array<{ id: number; slug: string }>)[0];
  if (!org) throw new Error(`user ${user.id} has no personal workspace (u-${user.chandler_sub})`);

  const [walletRows] = await conn.execute(
    `SELECT wallet_id, remaining_sau, reserved_sau FROM billing_quota_wallets
     WHERE account_id = ? AND quota_type = 'trial' AND status = 'active' ORDER BY wallet_id DESC LIMIT 1`,
    [org.id],
  );
  const wallet = (walletRows as Array<{ wallet_id: number; remaining_sau: number; reserved_sau: number }>)[0];
  if (!wallet) throw new Error(`user ${user.id} (account ${org.id}) has no active trial wallet`);

  const idempotencyKey = `grt:manual:${reasonArg}:${wallet.wallet_id}`;
  const newRemaining = wallet.remaining_sau + units;
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO billing_ledger (account_id, wallet_id, idempotency_key, action, quota_type, units, reason, balance_after_remaining, balance_after_reserved)
       VALUES (?, ?, ?, 'granted', 'trial', ?, ?, ?, ?)`,
      [org.id, wallet.wallet_id, idempotencyKey, units, `manual top-up: ${reasonArg}`, newRemaining, wallet.reserved_sau],
    );
    await conn.execute(
      `UPDATE billing_quota_wallets SET remaining_sau = ?, balance_after_remaining = ?, balance_after_reserved = ? WHERE wallet_id = ?`,
      [newRemaining, newRemaining, wallet.reserved_sau, wallet.wallet_id],
    );
    await conn.commit();
    console.log(JSON.stringify({ granted: true, email, userId: user.id, accountId: org.id, walletId: wallet.wallet_id, units, newRemaining }, null, 2));
  } catch (error) {
    await conn.rollback();
    const code = (error as { code?: string }).code;
    if (code === "ER_DUP_ENTRY") {
      console.log(JSON.stringify({ granted: false, reason: "idempotency key already granted", idempotencyKey }));
    } else {
      throw error;
    }
  } finally {
    conn.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

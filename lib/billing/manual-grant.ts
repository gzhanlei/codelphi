import { getDb } from "../db";

/**
 * 运营手工充值（超管后台/CLI 共用实现，M4）：给用户个人工作区的 Trial 钱包发放额度。
 * 账务语义与 core.grantTrialQuota 一致（granted 流水 + 钱包快照同事务）；幂等键
 * grt:manual:{reason}:{wallet_id}——同一 reason 重放零副作用（不重复发放）。
 */

export interface ManualGrantInput {
  email: string;
  units: number;
  /** 充值原因（进 ledger reason 与幂等键；同一 reason 只发放一次，再次充值请换 reason，如带日期）。 */
  reason: string;
  /** 操作者（审计追溯，拼进 ledger reason）。 */
  operator?: string;
}

export interface ManualGrantResult {
  granted: boolean;
  walletId: number;
  newRemaining: number;
  accountId: number;
  userId: number;
}

/** 给 email 定位的用户充值 SAU（发放到其个人工作区的 Trial 钱包；无钱包自动创建）。 */
export async function grantQuotaByEmail(input: ManualGrantInput): Promise<ManualGrantResult> {
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();

    // 定位用户与个人工作区账户（无锁读；email 唯一、slug 固定）
    const [userRows] = await conn.execute(
      `SELECT id, chandler_sub FROM users WHERE email = ? LIMIT 1`,
      [input.email],
    );
    const user = (userRows as Array<{ id: number; chandler_sub: string }>)[0];
    if (!user) throw new Error(`no user with email ${input.email}`);
    const userId = Number(user.id);
    const [orgRows] = await conn.execute(
      `SELECT id FROM organizations WHERE slug = ? LIMIT 1`,
      [`u-${user.chandler_sub}`],
    );
    const orgRow = (orgRows as Array<{ id: number }>)[0];
    if (!orgRow) throw new Error(`user ${userId} has no personal workspace`);
    const accountId = Number(orgRow.id);

    await conn.execute(`SELECT account_id FROM billing_accounts WHERE account_id = ? FOR UPDATE`, [accountId]);

    // Trial 钱包：无则自动创建（老用户兜底；source_key 稳定，重复创建靠 UNIQUE 兜底）
    const sourceKey = `trial:${userId}`;
    const [walletRows] = await conn.execute(
      `SELECT wallet_id, remaining, reserved FROM (
         SELECT wallet_id, remaining_sau AS remaining, reserved_sau AS reserved
         FROM billing_quota_wallets
         WHERE account_id = ? AND quota_type = 'trial' AND status = 'active'
         ORDER BY wallet_id DESC LIMIT 1
       ) t FOR UPDATE`,
      [accountId],
    );
    let walletId: number;
    let remaining = 0;
    const reserved = 0;
    // 派生表列名是运行时真实形状（wallet_id），不得用 camelCase 断言掩盖——生产 4318fd6 曾因此把 undefined 绑进 INSERT
    const wallet = (walletRows as Array<{ wallet_id: number; remaining: number; reserved: number }>)[0];
    if (wallet) {
      walletId = Number(wallet.wallet_id);
      remaining = Number(wallet.remaining);
    } else {
      const [insRows] = await conn.execute(
        `INSERT INTO billing_quota_wallets (account_id, quota_type, remaining_sau, reserved_sau, source_key, status, balance_after_remaining, balance_after_reserved)
         VALUES (?, 'trial', 0, 0, ?, 'active', 0, 0)`,
        [accountId, sourceKey],
      );
      walletId = Number((insRows as { insertId: number }).insertId);
    }

    const newRemaining = remaining + input.units;
    const idempotencyKey = `grt:manual:${input.reason}:${walletId}`;
    const [dupRows] = await conn.execute(`SELECT entry_id FROM billing_ledger WHERE idempotency_key = ? FOR UPDATE`, [idempotencyKey]);
    if ((dupRows as unknown[]).length > 0) {
      // 同 reason 已发放过：零副作用返回（重放防护）
      await conn.commit();
      conn.release();
      return { granted: false, walletId, newRemaining: remaining, accountId, userId };
    }
    await conn.execute(
      `INSERT INTO billing_ledger (account_id, wallet_id, idempotency_key, action, quota_type, units, reason, balance_after_remaining, balance_after_reserved)
       VALUES (?, ?, ?, 'granted', 'trial', ?, ?, ?, ?)`,
      [accountId, walletId, idempotencyKey, input.units, `manual grant${input.operator ? ` by ${input.operator}` : ""}: ${input.reason}`, newRemaining, reserved],
    );
    await conn.execute(
      `UPDATE billing_quota_wallets SET remaining_sau = ?, balance_after_remaining = ?, balance_after_reserved = ? WHERE wallet_id = ?`,
      [newRemaining, newRemaining, reserved, walletId],
    );
    await conn.commit();
    conn.release();
    return { granted: true, walletId, newRemaining, accountId, userId };
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* 连接可能未建立事务 */
    }
    conn.release();
    throw error;
  }
}

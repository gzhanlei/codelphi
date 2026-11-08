import { createHash } from "node:crypto";
import { getDb, type Execute } from "../db";
import { sendEmailNotification } from "../notifications";

/**
 * 计费通知 transactional outbox（契约 M4-T4，P1-5）：
 * - 事件层：业务事务内 INSERT（唯一键 = SHA256(account + billing_period + type + threshold)）——
 *   事件不重复创建是强保证；
 * - 投递层：at-least-once（sent 后不重发；明确失败 failed 可重试；**超时/结果未知 → unknown，
 *   不清键不自动重发**——远端可能已接受，重试即重复邮件），unknown 进每日对账人工判断；
 * - 不宣称 exactly-once。
 */

export type BillingNotificationType =
  | "quota_threshold"
  | "skipped_push"
  | "settlement_partially_settled"
  | "settlement_unfunded"
  | "quota_exceeded_rejected"
  | "period_ending"
  | "grace_notice"
  | "expired_notice"
  | "reconcile_summary";

export interface BillingNotificationInput {
  accountId: number;
  /** 周期标识：trial 账户为 "trial"，付费账户为周期末 ISO 日期。 */
  billingPeriod: string;
  type: BillingNotificationType;
  /** 阈值/细分（如 80）；无阈值传 0。 */
  threshold?: number;
  subject: string;
  body: string;
}

export function billingNotificationKey(input: Pick<BillingNotificationInput, "accountId" | "billingPeriod" | "type" | "threshold">): string {
  return createHash("sha256")
    .update(`${input.accountId}:${input.billingPeriod}:${input.type}:${input.threshold ?? 0}`)
    .digest("hex");
}

/** 事件入队（业务事务内调用则传 execute 保持原子；独立调用默认连接池）。幂等：撞唯一键静默跳过。 */
export async function enqueueBillingNotification(input: BillingNotificationInput, execute?: Execute): Promise<boolean> {
  const runner: Execute = execute ?? ((sql, params) => getDb().execute(sql, params));
  const key = billingNotificationKey(input);
  try {
    const [result] = (await runner(
      `INSERT IGNORE INTO billing_notification_outbox (idempotency_key, account_id, notification_type, payload_json)
       VALUES (?, ?, ?, ?)`,
      [key, input.accountId, input.type, JSON.stringify({ subject: input.subject, body: input.body, threshold: input.threshold ?? 0, billingPeriod: input.billingPeriod })],
    )) as [unknown, unknown];
    const inserted = Number((result as { affectedRows?: number } | null)?.affectedRows ?? 0) > 0;
    return inserted;
  } catch (error) {
    // 通知失败不影响业务主链路（outbox 是保护措施）；对账可见
    console.error("[billing] notification enqueue failed", { type: input.type, accountId: input.accountId, error });
    return false;
  }
}

/** 投递一轮 pending 通知（sweep 调用）：4xx/明确失败 → failed（可人工重试）；超时/5xx → unknown（不自动重发）。 */
export async function deliverPendingBillingNotifications(limit = 20): Promise<{ sent: number; failed: number; unknown: number }> {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT o.id, o.account_id, o.notification_type, o.payload_json, o.attempts
     FROM billing_notification_outbox o WHERE o.status = 'pending' ORDER BY o.id ASC LIMIT ${Number(limit) || 20}`,
  );
  let sent = 0;
  let failed = 0;
  let unknown = 0;
  for (const row of rows as Array<{ id: number; account_id: number; notification_type: string; payload_json: string; attempts: number }>) {
    let to: string | null = null;
    try {
      const [ownerRows] = await db.execute(
        `SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND m.role = 'owner' AND u.email IS NOT NULL LIMIT 1`,
        [row.account_id],
      );
      to = ((ownerRows as Array<{ email: string }>)[0]?.email ?? null)?.trim() || null;
    } catch {
      to = null;
    }
    if (!to) {
      await db.execute(`UPDATE billing_notification_outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ?`, [row.id]);
      failed += 1;
      continue;
    }
    const payload = JSON.parse(row.payload_json || "{}") as { subject?: string; body?: string };
    try {
      await sendEmailNotification(to, payload.subject ?? "CoDelphi 计费通知", payload.body ?? "");
      await db.execute(`UPDATE billing_notification_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP(3), attempts = attempts + 1 WHERE id = ?`, [row.id]);
      sent += 1;
    } catch (error) {
      const message = String(error);
      if (message.includes("chandler mail 4") || message.includes("chandler mail 5")) {
        // 结果未知（网络中断/5xx）→ unknown：远端可能已投递，重试即重复邮件
        await db.execute(`UPDATE billing_notification_outbox SET status = 'unknown', attempts = attempts + 1 WHERE id = ?`, [row.id]);
        unknown += 1;
        console.warn("[billing] notification delivery result unknown; left for reconciliation", { id: row.id, type: row.notification_type });
      } else {
        await db.execute(`UPDATE billing_notification_outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ?`, [row.id]);
        failed += 1;
      }
    }
  }
  return { sent, failed, unknown };
}

/** 组织 owner 邮箱（通知收件人）。 */
export async function ownerEmailForAccount(accountId: number): Promise<string | null> {
  const [rows] = await getDb().execute(
    `SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.role = 'owner' AND u.email IS NOT NULL LIMIT 1`,
    [accountId],
  );
  const email = (rows as Array<{ email: string }>)[0]?.email ?? null;
  return email?.trim() || null;
}

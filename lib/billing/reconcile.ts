import { getDb } from "../db";
import { sendEmailNotification } from "../notifications";

/**
 * 每日对账（契约 M4-T5/§11.2 第 6 条）：只读 SQL 集 + 汇总告警邮件，**不自动改账**
 * （三原则 1：差异修复走人工 adjustment）。全部 SQL 用墙钟字面量（时区坑规避）。
 */

export interface ReconcileFinding {
  check: string;
  count: number;
  samples?: Array<Record<string, unknown>>;
}

export interface ReconcileReport {
  ranAt: string;
  findings: ReconcileFinding[];
  healthy: boolean;
}

export async function runDailyReconcileOnce(): Promise<ReconcileReport> {
  const db = getDb();
  const findings: ReconcileFinding[] = [];

  const checks: Array<{ check: string; sql: string; params?: unknown[]; sample?: boolean }> = [
    {
      check: "expired_active_reservations_not_released",
      sql: `SELECT COUNT(*) AS count FROM billing_reservations WHERE status = 'active' AND expires_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`,
    },
    {
      check: "paid_orders_not_fulfilled_over_5m",
      sql: `SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'paid' AND paid_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)`,
    },
    {
      check: "refund_submitted_stale_over_30m",
      sql: `SELECT order_no, refund_status FROM payment_orders WHERE refund_status = 'refund_submitted' AND updated_at < DATE_SUB(NOW(3), INTERVAL 30 MINUTE) LIMIT 10`,
      sample: true,
    },
    {
      check: "open_settlement_exceptions",
      sql: `SELECT COUNT(*) AS count FROM billing_settlement_exceptions WHERE reconciliation_status = 'open'`,
    },
    {
      check: "outbox_unknown",
      sql: `SELECT COUNT(*) AS count FROM billing_notification_outbox WHERE status = 'unknown'`,
    },
    {
      check: "outbox_failed",
      sql: `SELECT COUNT(*) AS count FROM billing_notification_outbox WHERE status = 'failed'`,
    },
    {
      // 钱包余额 vs ledger 重放一致性（三原则 1 落地检查；不允许 SQL 侧自动修复）
      check: "wallet_ledger_replay_mismatch",
      sql: `SELECT w.wallet_id, w.remaining_sau, w.reserved_sau,
              COALESCE(SUM(CASE l.action WHEN 'granted' THEN l.units WHEN 'refunded' THEN -l.units ELSE 0 END), 0) AS replay_remaining,
              COALESCE(SUM(CASE l.action WHEN 'reserved' THEN l.units WHEN 'captured' THEN -l.units WHEN 'released' THEN -l.units ELSE 0 END), 0) AS replay_reserved
            FROM billing_quota_wallets w LEFT JOIN billing_ledger l ON l.wallet_id = w.wallet_id
            GROUP BY w.wallet_id, w.remaining_sau, w.reserved_sau
            HAVING w.remaining_sau <> replay_remaining OR w.reserved_sau <> replay_reserved
            LIMIT 10`,
      sample: true,
    },
    {
      check: "negative_or_overreserved_wallets",
      sql: `SELECT wallet_id, remaining_sau, reserved_sau FROM billing_quota_wallets WHERE remaining_sau < 0 OR reserved_sau < 0 OR reserved_sau > remaining_sau LIMIT 10`,
      sample: true,
    },
    {
      check: "accounts_on_reconciliation_hold",
      sql: `SELECT account_id FROM billing_accounts WHERE reconciliation_hold = 1 LIMIT 10`,
      sample: true,
    },
  ];

  for (const check of checks) {
    try {
      const [rows] = await db.execute(check.sql, check.params as string[] ?? []);
      const list = rows as Array<Record<string, unknown>>;
      const count = typeof list[0]?.count === "number" ? Number(list[0].count) : list.length;
      if (count > 0 || (check.sample && list.length > 0)) {
        findings.push({ check: check.check, count, samples: check.sample ? list.slice(0, 5) : undefined });
      }
    } catch (error) {
      findings.push({ check: `${check.check} (query failed)`, count: -1, samples: [{ error: String(error).slice(0, 200) }] });
    }
  }

  const report: ReconcileReport = {
    ranAt: new Date().toISOString(),
    findings,
    healthy: findings.length === 0,
  };

  // 告警邮件：直发 CODELPHI_ADMIN_EMAILS（管理员汇总不经 outbox——outbox 的 account 外键不适用）
  if (!report.healthy) {
    const admins = (process.env.CODELPHI_ADMIN_EMAILS ?? "").split(",").map((email) => email.trim()).filter(Boolean);
    const lines = findings.map((f) => `- ${f.check}: ${f.count}${f.samples ? `（样例 ${JSON.stringify(f.samples).slice(0, 300)}）` : ""}`);
    const subject = `[CoDelphi] 账务对账异常（${findings.length} 项）`;
    const body = `CoDelphi 每日账务对账发现 ${findings.length} 项异常：\n${lines.join("\n")}\n\n（对账作业只读不改账；修复走人工 adjustment，详见账务契约 §6.8/§2）`;
    for (const to of admins) {
      try {
        await sendEmailNotification(to, subject, body);
      } catch (error) {
        console.error("[billing] reconcile summary mail failed", { to, error });
      }
    }
    console.error("[billing] daily reconcile findings", { findings });
  }
  return report;
}

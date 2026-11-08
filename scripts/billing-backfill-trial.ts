import "dotenv/config";
import { getDb } from "../lib/db";
import { grantTrialQuota } from "../lib/billing/core";
import { TRIAL_UNITS } from "../lib/billing/constants";

/**
 * 存量组织 Trial 额度回填（契约 M1-T4 / 开发计划默认拍板项 §6-2）：
 * - 归属判定 = `u-<chandler_sub>` 个人工作区模式（ensureUserWorkspace 命名规则），手建组织不发放；
 * - 同一 user 名下多组织只发放创建最早的一个（trial_grants user_id 唯一约束兜底）；
 * - source='backfill'，输出清单供复核；幂等重跑不变（granted:false 的行跳过）。
 * 用法：npm run db:migrate 之后执行 `tsx scripts/billing-backfill-trial.ts`。
 */
async function main() {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT u.id AS userId, b.account_id AS accountId, o.slug, o.created_at AS createdAt
     FROM billing_accounts b
     JOIN organizations o ON o.id = b.account_id
     JOIN users u ON o.slug = CONCAT('u-', u.chandler_sub)
     WHERE b.plan_status = 'trialing'
       AND NOT EXISTS (SELECT 1 FROM trial_grants g WHERE g.user_id = u.id)
     ORDER BY u.id ASC, o.created_at ASC, o.id ASC`,
  );
  const candidates = rows as Array<{ userId: number; accountId: number; slug: string; createdAt: string | Date }>;

  const granted: Array<{ userId: number; accountId: number; slug: string }> = [];
  const skipped: Array<{ userId: number; slug: string; reason: string }> = [];
  const seenUsers = new Set<number>();
  for (const row of candidates) {
    // 已按 (user, created_at) 排序：每个 user 的第一行即其最早组织，后续行跳过
    if (seenUsers.has(row.userId)) {
      skipped.push({ userId: row.userId, slug: row.slug, reason: "user_already_granted_earlier_workspace" });
      continue;
    }
    seenUsers.add(row.userId);
    const result = await grantTrialQuota({ userId: row.userId, accountId: row.accountId, source: "backfill", units: TRIAL_UNITS });
    if (result.granted) {
      granted.push({ userId: row.userId, accountId: row.accountId, slug: row.slug });
      console.log(`[backfill] granted trial to user ${row.userId} → account ${row.accountId} (${row.slug})`);
    } else {
      skipped.push({ userId: row.userId, slug: row.slug, reason: "already_granted" });
    }
  }

  const [manual] = await db.execute(
    `SELECT o.id AS accountId, o.slug FROM billing_accounts b JOIN organizations o ON o.id = b.account_id
     WHERE b.plan_status = 'trialing' AND o.slug NOT LIKE 'u-%'`,
  );
  console.log(JSON.stringify({
    granted: granted.length,
    skippedPersonalDuplicates: skipped.length,
    manualOrganizationsNotGranted: (manual as Array<{ accountId: number; slug: string }>).map((row) => row.slug),
    grantedList: granted,
    skippedList: skipped,
  }, null, 2));
  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

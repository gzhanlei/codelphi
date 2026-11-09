import "dotenv/config";
import { getDb } from "../lib/db";
import { reconcileRunBilling, type ReceiptRow, type ReservationRow, type SettlementRow, type SettlementRequestRow } from "../lib/billing/run-reconcile";

/**
 * W0-5 三方对账（docs/specsight-gap-improvement-plan.md §3.2）：
 *   tsx scripts/reconcile-run-billing.ts <runId>
 * 取数：billing_settlement_requests（run 级）、billing_settlements / billing_reservations
 * （attempt 级）、llm_call_receipts（逐趟回执）。纯对账，不改任何数据。
 */

async function main() {
  const runId = Number(process.argv[2]);
  if (!Number.isInteger(runId) || runId <= 0) {
    console.error("用法：tsx scripts/reconcile-run-billing.ts <runId>");
    process.exitCode = 1;
    return;
  }
  const db = getDb();
  try {
    await reconcile(db, runId);
  } finally {
    // 连接池会吊住事件循环：无论对账成败都关闭（错误仍经 catch 退出码 1 报告）
    await db.end().catch(() => undefined);
  }
}

async function reconcile(db: ReturnType<typeof getDb>, runId: number) {
  const [requestRows, settlementRows, reservationRows, receiptRows] = await Promise.all([
    db.execute(
      `SELECT run_id, requested_actual_units AS requestedActualUnits, captured_units_total AS capturedUnitsTotal,
              released_units_total AS releasedUnitsTotal, unfunded_units AS unfundedUnits,
              run_settlement_status AS runSettlementStatus
       FROM billing_settlement_requests WHERE run_id = ?`,
      [runId],
    ),
    db.execute(
      `SELECT reservation_attempt AS attempt, original_units AS originalUnits, captured_units AS capturedUnits,
              released_units AS releasedUnits
       FROM billing_settlements WHERE run_id = ? ORDER BY reservation_attempt`,
      [runId],
    ),
    db.execute(
      `SELECT reservation_attempt AS attempt, wallet_id AS walletId, units AS reservedUnits
       FROM billing_reservations WHERE run_id = ? ORDER BY reservation_attempt`,
      [runId],
    ),
    db.execute(
      `SELECT charge_component AS chargeComponent, outcome, usage_status AS usageStatus,
              input_tokens AS inputTokens, output_tokens AS outputTokens
       FROM llm_call_receipts WHERE run_id = ? ORDER BY id`,
      [runId],
    ),
  ]);

  const input = {
    settlementRequest: ((requestRows[0] as SettlementRequestRow[])[0] ?? null) as SettlementRequestRow | null,
    settlements: settlementRows[0] as SettlementRow[],
    reservations: reservationRows[0] as ReservationRow[],
    receipts: receiptRows[0] as ReceiptRow[],
  };

  if (!input.settlementRequest && input.settlements.length === 0 && input.receipts.length === 0) {
    console.log(`run ${runId}：无账务数据（可能尚未结算或 runId 不存在）`);
    return;
  }

  const report = reconcileRunBilling(input);
  console.log(`run ${runId} 对账：${report.ok ? "一致 ✅" : "发现不一致 ❌"}`);
  for (const check of report.checks) {
    console.log(`  [${check.ok ? "ok" : "!!"}] ${check.check}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  console.log(`  回执行分布：${JSON.stringify(report.receiptRowsByComponent)}`);
  if (report.unfundedUnits > 0) console.log(`  未结算额度：${report.unfundedUnits} SAU（sweep 兜底）`);
  if (!report.ok) process.exitCode = 1;
  await db.end();
}

if (process.argv[1]?.endsWith("reconcile-run-billing.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

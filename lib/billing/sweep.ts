import type { PoolConnection } from "mysql2/promise";
import { getDb } from "../db";
import { runAnalysis } from "../analysis";
import { dispatchStuckQueuedRuns } from "../analysis-recovery";
import { capture, expireStaleReservationsOnce } from "./core";
import { markPaidAndFulfill, getOrderWithReconcile } from "../pay-orders";
import { confirmRefundFromRemote, reclaimWalletIfSettled } from "../pay-refunds";
import { getValidUserToken } from "../chandler-token";
import { queryChandlerOrder } from "../chandler-pay";
import { deliverPendingBillingNotifications, enqueueBillingNotification, ownerEmailForAccount } from "./notifications";
import { runDailyReconcileOnce } from "./reconcile";
import { runAnalysisTriggerSweepOnce } from "../analysis-trigger";
import { runDigestSweepOnce } from "../digest-sweep";
import { DEADLOCK_RETRIES, FIRST_RUN_UNITS, HEARTBEAT_FRESH_WINDOW_MINUTES, RESERVATION_TTL_MINUTES, SWEEP_RESERVATION_INTERVAL_MS } from "./constants";

/**
 * 账务 sweep 调度骨架（M1-T6，契约 §6.5；M3-T4 复用同一骨架扩展支付 job）：
 * - 单实例 setInterval（systemd 单服务，B6），每 job 独立运行标记 + MySQL GET_LOCK advisory 互斥——
 *   **单实例只解决多进程竞争，不解决异步重叠**：setInterval 不等上轮完成，advisory lock 保证不重叠执行；
 * - GET_LOCK 是连接级锁：必须在持锁的同一连接上执行作业语句，finally 中 UNLOCK 后才归还连接；
 *   GET_LOCK 只做 job 互斥，业务仲裁仍靠事务 + 行锁（contract §6），两者不得混用；
 * - 上次成功执行时间落库 billing_sweep_state（重启补跑观测 + 对账输入）；
 * - 每个作业自身幂等：重复执行/重叠跳过/崩溃重跑都收敛到同一结果。
 */

interface JobResult {
  executed: boolean;
  detail?: Record<string, unknown>;
}

const SWEEP_LOCK_PREFIX = "billing-sweep:";

/** 拿到 advisory lock 时在「同一连接」上执行作业（B6 连接级纪律）；拿不到锁 = 上轮未结束，跳过本轮。 */
async function withSweepLock(jobName: string, work: (conn: PoolConnection) => Promise<Record<string, unknown>>): Promise<JobResult> {
  const conn = await getDb().getConnection();
  try {
    const [lockRows] = await conn.execute(`SELECT GET_LOCK(?, 0) AS acquired`, [SWEEP_LOCK_PREFIX + jobName]);
    const acquired = Number((lockRows as Array<{ acquired: number }>)[0]?.acquired ?? 0) === 1;
    if (!acquired) {
      conn.release();
      return { executed: false, detail: { reason: "lock_busy" } };
    }
    try {
      const detail = await work(conn);
      await conn.execute(
        `INSERT INTO billing_sweep_state (job_name, last_success_at) VALUES (?, NOW(3))
         ON DUPLICATE KEY UPDATE last_success_at = NOW(3), last_error = NULL`,
        [jobName],
      );
      return { executed: true, detail };
    } finally {
      // 同一连接上释放 advisory lock 后才归还连接（B6）
      await conn.execute(`SELECT RELEASE_LOCK(?)`, [SWEEP_LOCK_PREFIX + jobName]);
      conn.release();
    }
  } catch (error) {
    // 作业失败：记录 last_error（不覆盖 last_success_at），连接归还前解锁
    try {
      await conn.execute(`SELECT RELEASE_LOCK(?)`, [SWEEP_LOCK_PREFIX + jobName]);
    } catch {
      /* 连接异常时锁随连接断开自动释放 */
    }
    try {
      const stateConn = await getDb().getConnection();
      try {
        await stateConn.execute(
          `INSERT INTO billing_sweep_state (job_name, last_error) VALUES (?, ?)
           ON DUPLICATE KEY UPDATE last_error = VALUES(last_error)`,
          [jobName, String(error).slice(0, 500)],
        );
      } finally {
        stateConn.release();
      }
    } catch {
      /* 状态记录失败不影响主流程 */
    }
    conn.release();
    throw error;
  }
}

/** 预留 TTL 清理作业（契约 §6.5）：处置 + 扫描二恢复结算；全部幂等，sweep/心跳/release 三方收敛。 */
export async function runReservationSweepOnce(): Promise<JobResult> {
  return withSweepLock("reservation-ttl", async (lockConn) => {
    // 处置在同一 GET_LOCK 连接上开事务（B6 连接级纪律 + 单行处置多语句原子性）；
    // 死锁不在此重试——sweep 周期性重跑即天然重试，下一轮幂等收敛。
    await lockConn.beginTransaction();
    const disposal = await expireStaleReservationsOnce(lockConn, {
      freshWindowMinutes: HEARTBEAT_FRESH_WINDOW_MINUTES,
      ttlMinutes: RESERVATION_TTL_MINUTES,
    });
    await lockConn.commit();
    // 扫描二（D15）：succeeded + 无 run 级结算请求 + 存在任意 reservations → 恢复 capture；
    // capture 自管事务与行锁（GET_LOCK 之外独立仲裁）；失败只告警，不改 run 分析状态（D15）。
    const [recoveryRows] = await lockConn.execute(
      `SELECT a.id FROM analysis_runs a
       WHERE a.status = 'succeeded'
         AND a.billing_reservation_attempt > 0
         AND NOT EXISTS (SELECT 1 FROM billing_settlement_requests q WHERE q.run_id = a.id)
         AND EXISTS (SELECT 1 FROM billing_reservations r WHERE r.run_id = a.id)
       LIMIT 50`,
    );
    const recovery: Array<{ runId: number }> = [];
    for (const row of recoveryRows as Array<{ id: number }>) {
      try {
        await capture(row.id, FIRST_RUN_UNITS);
        recovery.push({ runId: row.id });
      } catch (error) {
        console.error("[billing] settlement recovery failed for succeeded run", { runId: row.id, error });
      }
    }
    // work 只返回 detail 数据；executed/detail 外壳由 withSweepLock 统一包装
    return { ...disposal, settlementRecovered: recovery.length };
  });
}

/** 限流计数过期行清理（P1-5 派生）：已翻页的旧窗口行不再有用，防 rate_limit_hits 无界增长。 */
export async function runRateLimitCleanupOnce(windowSeconds = 3600): Promise<JobResult> {
  return withSweepLock("rate-limit-cleanup", async (conn) => {
    const [result] = await conn.execute(
      `DELETE FROM rate_limit_hits WHERE window_start < DATE_SUB(NOW(3), INTERVAL ? SECOND)`,
      [windowSeconds * 2],
    );
    return { deleted: Number((result as { affectedRows?: number }).affectedRows ?? 0) };
  });
}

const startedJobs = new Set<string>();

/**
 * 积压 queued run 补跑作业：闸门允许（额度/订阅状态恢复）时自动补跑超时未认领的
 * queued run（每仓库仅最新一条，更旧的标 superseded）。启动恢复管重启窗口，本作业
 * 管「入队后无人在途」的长尾——包括账务恢复（套餐生效/钱包发放）后的自动补分析。
 */
export async function runQueuedRunRecoveryOnce(): Promise<JobResult> {
  return withSweepLock("queued-run-recovery", async () => dispatchStuckQueuedRuns(runAnalysis));
}

/**
 * 触发模式兜底作业（每小时运行，仓库按 analysis_trigger_hour 匹配小时）：daily/push_count
 * 模式当天仍有未处理 push 的仓库，排队一次累计分析（before=成功水位 / after=当前 HEAD）。
 * 排队后的派发由 queued-run-recovery 接手；额度闸门拒绝时 pending 保留、下小时重试。
 */
export async function runAnalysisTriggerSweepJob(): Promise<JobResult> {
  const outcome = await runAnalysisTriggerSweepOnce();
  return { executed: true, detail: { ...outcome } };
}

/** Digest 周报作业（A2 §4.3）：滚动 7 天窗口，每小时检查一次，本期已生成则跳过。 */
export async function runDigestWeeklyJob(): Promise<JobResult> {
  const outcome = await runDigestSweepOnce();
  return { executed: true, detail: { ...outcome } };
}

/** 调度入口（instrumentation.ts 调用一次）：幂等启动，重复调用直接返回。 */
export function startBillingSweeps() {
  if (process.env.BILLING_SWEEP_ENABLED === "false") return { started: false };
  if (startedJobs.size > 0) return { started: false };
  scheduleJob("reservation-ttl", SWEEP_RESERVATION_INTERVAL_MS, runReservationSweepOnce);
  scheduleJob("payment-reconcile", 60 * 1_000, runPaymentReconcileOnce);
  scheduleJob("billing-notify-delivery", 60 * 1_000, runBillingNotifyDeliveryOnce);
  scheduleJob("billing-daily", 24 * 60 * 60 * 1_000, runBillingDailyOnce);
  scheduleJob("rate-limit-cleanup", 60 * 60 * 1_000, () => runRateLimitCleanupOnce(3600));
  scheduleJob("queued-run-recovery", 60 * 1_000, runQueuedRunRecoveryOnce);
  scheduleJob("analysis-trigger", 60 * 60 * 1_000, runAnalysisTriggerSweepJob);
  scheduleJob("digest-weekly", 60 * 60 * 1_000, runDigestWeeklyJob);
  return { started: true, jobs: [...startedJobs] };
}

function scheduleJob(name: string, intervalMs: number, job: () => Promise<JobResult>) {
  startedJobs.add(name);
  const timer = setInterval(() => {
    // 骨架保证不重叠（advisory lock）；单轮失败不终止调度
    job().catch((error) => console.error(`[billing] sweep job ${name} failed`, error));
  }, intervalMs);
  timer.unref?.();
}


/**
 * 支付对账作业（M3-T4，契约 §6 三重对账矩阵的 sweep 侧）：
 * - pending > 30 分钟：有平台单号先查单（paid → 履约，防 webhook 丢失误关已支付单）后关单；无平台单号直接关；
 * - paid 未 fulfilled（履约失败残留）：恢复履约；
 * - refund_submitted > 5 分钟：查单推进（refunded → 确认回收；明确 failed → refund_failed）；
 * - reclaiming 钱包：重试回收前置校验（reserved = 0 才执行 refunded 冲正）。
 */
export async function runPaymentReconcileOnce(): Promise<JobResult> {
  return withSweepLock("payment-reconcile", async (conn) => {
    const detail: Record<string, unknown> = {};
    // 1) 超时 pending 关单（先查单；同一连接开事务逐单处理）
    const [pendingRows] = await conn.execute(
      `SELECT order_no, platform_order_no, user_id FROM payment_orders
       WHERE status = 'pending' AND created_at < DATE_SUB(NOW(3), INTERVAL 30 MINUTE)
       ORDER BY created_at ASC LIMIT 100`,
    );
    let closed = 0;
    let paidRecovered = 0;
    for (const row of pendingRows as Array<{ order_no: string; platform_order_no: string | null; user_id: number }>) {
      if (row.platform_order_no) {
        try {
          const userToken = await getValidUserToken(Number(row.user_id));
          const remote = await queryChandlerOrder(row.platform_order_no, userToken);
          if (remote.status === "paid") {
            await markPaidAndFulfill(row.order_no);
            paidRecovered += 1;
            continue;
          }
        } catch (error) {
          // Chandler 不可达：跳过等下一轮；单龄 >24h 由止损规则在下方处理
          console.warn("[billing] pending sweep reconcile failed; will retry", { orderNo: row.order_no, error });
          continue;
        }
      }
      await conn.execute(`UPDATE payment_orders SET status = 'closed' WHERE order_no = ? AND status = 'pending'`, [row.order_no]);
      closed += 1;
    }
    detail.pendingClosed = closed;
    detail.pendingPaidRecovered = paidRecovered;

    // 2) paid 未 fulfilled 恢复（履约事务失败残留）
    const [paidRows] = await conn.execute(
      `SELECT order_no FROM payment_orders
       WHERE status = 'paid' AND fulfilled_at IS NULL AND paid_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
       LIMIT 50`,
    );
    let fulfilledRecovered = 0;
    for (const row of paidRows as Array<{ order_no: string }>) {
      try {
        await markPaidAndFulfill(row.order_no);
        fulfilledRecovered += 1;
      } catch (error) {
        console.error("[billing] paid order fulfillment recovery failed", { orderNo: row.order_no, error });
      }
    }
    detail.paidFulfilledRecovered = fulfilledRecovered;

    // 3) refund_submitted 超 5 分钟推进（查单；refunded → 确认回收，明确 failed → refund_failed）
    const [refundRows] = await conn.execute(
      `SELECT order_no, platform_order_no, user_id, updated_at FROM payment_orders
       WHERE refund_status = 'refund_submitted' AND updated_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)
       ORDER BY updated_at ASC LIMIT 50`,
    );
    let refundsConfirmed = 0;
    let refundsFailed = 0;
    for (const row of refundRows as Array<{ order_no: string; platform_order_no: string; user_id: number }>) {
      try {
        const userToken = await getValidUserToken(Number(row.user_id));
        const remote = await queryChandlerOrder(row.platform_order_no, userToken);
        if (remote.status === "refunded") {
          await confirmRefundFromRemote(row.order_no);
          refundsConfirmed += 1;
        } else if (remote.status === "failed" || remote.status === "closed") {
          await conn.execute(
            `UPDATE payment_orders SET refund_status = 'refund_failed' WHERE order_no = ? AND refund_status = 'refund_submitted'`,
            [row.order_no],
          );
          refundsFailed += 1;
        }
      } catch (error) {
        console.warn("[billing] refund sweep reconcile failed; will retry", { orderNo: row.order_no, error });
      }
    }
    detail.refundsConfirmed = refundsConfirmed;
    detail.refundsFailed = refundsFailed;

    // 4) reclaiming 钱包回收重试（reserved 结清后执行 refunded 冲正）
    const [reclaimRows] = await conn.execute(
      `SELECT wallet_id FROM billing_quota_wallets WHERE status = 'reclaiming' LIMIT 50`,
    );
    let reclaimed = 0;
    for (const row of reclaimRows as Array<{ wallet_id: number }>) {
      try {
        const { reclaimWalletIfSettled } = await import("../pay-refunds");
        if (await reclaimWalletIfSettled(row.wallet_id)) reclaimed += 1;
      } catch (error) {
        console.warn("[billing] reclaim retry failed; will retry next round", { walletId: row.wallet_id, error });
      }
    }
    detail.reclaimed = reclaimed;
    return detail;
  });
}


/** 计费通知投递（M4-T4）：outbox pending → 邮件；unknown/failed 留给对账。 */
export async function runBillingNotifyDeliveryOnce(): Promise<JobResult> {
  return withSweepLock("billing-notify-delivery", async () => {
    const detail = await deliverPendingBillingNotifications(20);
    return { executed: true, detail };
  });
}

/** 账务每日作业（M4-T5）：到期/宽限提醒入队 + 每日对账（只读 SQL 集 + 管理员告警邮件）。 */
export async function runBillingDailyOnce(): Promise<JobResult> {
  return withSweepLock("billing-daily", async (conn) => {
    // 到期提醒（契约 §13.1）：active 且周期将结束（7/3/0 天内）→ period_ending（threshold=剩余整天数）
    const [endingRows] = await conn.execute(
      `SELECT b.account_id, b.current_period_end,
              CEILING(TIMESTAMPDIFF(HOUR, NOW(3), b.current_period_end) / 24) AS daysLeft
       FROM billing_accounts b
       WHERE b.plan_status = 'active' AND b.current_period_end IS NOT NULL
         AND b.current_period_end <= DATE_ADD(NOW(3), INTERVAL 7 DAY)
         AND b.current_period_end > NOW(3)`,
    );
    let periodReminders = 0;
    for (const row of endingRows as Array<{ account_id: number; current_period_end: string | Date; daysLeft: number }>) {
      const periodEnd = new Date(row.current_period_end).toISOString().slice(0, 10);
      const inserted = await enqueueBillingNotification({
        accountId: row.account_id,
        billingPeriod: periodEnd,
        type: "period_ending",
        threshold: Number(row.daysLeft) || 0,
        subject: `[CoDelphi] 订阅将在 ${row.daysLeft} 天后到期`,
        body: `当前计费周期将于 ${periodEnd} 结束。到期后账户进入只读宽限期（7 天），期间无法发起新分析；续费可延续周期并保留全部规格历史。`,
      });
      // owner 缺失/未发放不影响计数
      void inserted;
      periodReminders += 1;
    }
    void ownerEmailForAccount;
    // 每日对账（只读 + 管理员告警邮件）
    const reconcile = await runDailyReconcileOnce();
    return {
      executed: true,
      detail: { periodReminders, reconcileFindings: reconcile.findings.length, reconcileHealthy: reconcile.healthy },
    };
  });
}

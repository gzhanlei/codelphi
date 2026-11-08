import type { PoolConnection } from "mysql2/promise";
import { getDb } from "../db";
import { capture, expireStaleReservationsOnce } from "./core";
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

/** 调度入口（instrumentation.ts 调用一次）：幂等启动，重复调用直接返回。 */
export function startBillingSweeps() {
  if (process.env.BILLING_SWEEP_ENABLED === "false") return { started: false };
  if (startedJobs.size > 0) return { started: false };
  scheduleJob("reservation-ttl", SWEEP_RESERVATION_INTERVAL_MS, runReservationSweepOnce);
  scheduleJob("rate-limit-cleanup", 60 * 60 * 1_000, () => runRateLimitCleanupOnce(3600));
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

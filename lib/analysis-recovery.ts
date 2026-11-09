import { defaultExecute, type Execute } from "./db";
import { decideQueuedRunDispatch, type QueuedRunDispatchDecision } from "./billing/core";

export const orphanedRunMessage = "analysis interrupted by server restart (orphaned running run)";
export const supersededRunMessagePrefix = "[superseded]";
export const QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES = 10;

export type QueuedRunGate = typeof decideQueuedRunDispatch;

async function defaultGate(run: { id: number; triggerType: string; accountId: number | null }): Promise<QueuedRunDispatchDecision> {
  return decideQueuedRunDispatch(run);
}

/**
 * 启动恢复：重启会杀掉 after() 里的在途分析，遗留的 running run（以及旧版本
 * 启动逻辑置为孤儿失败的 run）永远无人认领（loadRun 只认 queued/failed）。
 * saveResult 是原子事务——孤儿 run 必然没有落库，重新排队并派发是安全且幂等的：
 * 产品页显示「等待分析」直到补跑完成，用户不需要看到失败或手工处理。
 * 单实例部署假设（README 拓扑）：启动时不存在并发持有者。
 * 派发前过补跑闸门（decideQueuedRunDispatch）：账务不允许的（trialing push / 额度不足）
 * 保持 queued 不标 failed，等条件满足后由 queued-run-recovery sweep 补跑；
 * 派发前原子认领（started_at 置位）防与 sweep 重叠双跑。
 */
export async function recoverInterruptedRuns(
  runAnalysis: (runId: number) => Promise<void>,
  execute: Execute = defaultExecute,
  gate: QueuedRunGate = defaultGate,
) {
  const [result] = await execute(
    `UPDATE analysis_runs SET status = 'queued', error_message = NULL, finished_at = NULL, started_at = NULL
     WHERE status = 'running' OR (status = 'failed' AND error_message = ?)`,
    [orphanedRunMessage],
  ) as [{ affectedRows?: number }, unknown];
  const requeued = result.affectedRows ?? 0;

  const dispatched = await dispatchQueuedRuns(
    "SELECT id, trigger_type AS triggerType, account_id AS accountId FROM analysis_runs WHERE status = 'queued' AND started_at IS NULL ORDER BY id",
    [],
    runAnalysis,
    execute,
    gate,
  );
  return { requeued, dispatched };
}

/**
 * 积压 queued run 补跑（queued-run-recovery sweep 的周期入口）：
 * 只处理超过阈值仍无人认领的 queued（after() 正常派发在秒级完成，超时即孤儿）。
 * 每个仓库只补跑最新一条——旧 push 的变化被最新 after_sha 的累计 change 覆盖，
 * 逐条跑只会白烧额度；更旧的 queued 标记 superseded 终态（内容已被覆盖，不是用户失败）。
 * 最新一条过补跑闸门后原子认领派发；闸门不满足 → 原样保留 queued 等下一轮，
 * 账务恢复（套餐生效/钱包发放）后自动补上。遗留预留由 reservation-ttl sweep 兜底回收。
 */
export async function dispatchStuckQueuedRuns(
  runAnalysis: (runId: number) => Promise<void>,
  execute: Execute = defaultExecute,
  gate: QueuedRunGate = defaultGate,
) {
  const [rows] = await execute(
    `SELECT r.id, r.repository_id AS repositoryId, r.trigger_type AS triggerType, r.account_id AS accountId
     FROM analysis_runs r
     JOIN (
       SELECT repository_id, MAX(id) AS max_id
       FROM analysis_runs
       WHERE status = 'queued' AND started_at IS NULL AND created_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)
       GROUP BY repository_id
     ) latest ON latest.repository_id = r.repository_id AND latest.max_id = r.id
     ORDER BY r.id`,
    [QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES],
  ) as [Array<{ id: number; repositoryId: number; triggerType: string; accountId: number | null }>, unknown];

  let superseded = 0;
  const candidates: Array<{ id: number; triggerType: string; accountId: number | null }> = [];
  for (const row of rows) {
    const id = Number(row.id);
    const [stale] = await execute(
      `UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3)
       WHERE repository_id = ? AND status = 'queued' AND started_at IS NULL AND id < ?`,
      [`${supersededRunMessagePrefix} newer queued run ${id} covers this repository's pending pushes`, Number(row.repositoryId), id],
    ) as [{ affectedRows?: number }, unknown];
    superseded += stale.affectedRows ?? 0;
    candidates.push({ id, triggerType: String(row.triggerType), accountId: row.accountId == null ? null : Number(row.accountId) });
  }

  const dispatched = await dispatchCandidates(candidates, runAnalysis, execute, gate);
  return { superseded, dispatched };
}

/** 逐条过闸门 + 原子认领派发；认领失败（并发赢面丢失）静默跳过。 */
async function dispatchQueuedRuns(
  selectSql: string,
  selectParams: Array<string | number | null>,
  runAnalysis: (runId: number) => Promise<void>,
  execute: Execute,
  gate: QueuedRunGate,
): Promise<number> {
  const [rows] = await execute(selectSql, selectParams) as [Array<{ id: number; triggerType: string; accountId: number | null }>, unknown];
  return dispatchCandidates(
    rows.map((row) => ({ id: Number(row.id), triggerType: String(row.triggerType), accountId: row.accountId == null ? null : Number(row.accountId) })),
    runAnalysis,
    execute,
    gate,
  );
}

async function dispatchCandidates(
  candidates: Array<{ id: number; triggerType: string; accountId: number | null }>,
  runAnalysis: (runId: number) => Promise<void>,
  execute: Execute,
  gate: QueuedRunGate,
): Promise<number> {
  let dispatched = 0;
  for (const run of candidates) {
    const decision = await gate(run);
    if (!decision.dispatch) continue;
    // 认领（原子）：置 started_at 标记，赢面唯一；输给并发派发方则跳过
    const [claim] = await execute(
      "UPDATE analysis_runs SET started_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'queued' AND started_at IS NULL",
      [run.id],
    ) as [{ affectedRows?: number }, unknown];
    if ((claim.affectedRows ?? 0) !== 1) continue;
    dispatched += 1;
    void runAnalysis(run.id).catch(() => undefined);
  }
  return dispatched;
}

import { defaultExecute, type Execute } from "./db";

export const orphanedRunMessage = "analysis interrupted by server restart (orphaned running run)";

/**
 * 启动恢复：重启会杀掉 after() 里的在途分析，遗留的 running run（以及旧版本
 * 启动逻辑置为孤儿失败的 run）永远无人认领（loadRun 只认 queued/failed）。
 * saveResult 是原子事务——孤儿 run 必然没有落库，重新排队并派发是安全且幂等的：
 * 产品页显示「等待分析」直到补跑完成，用户不需要看到失败或手工处理。
 * 单实例部署假设（README 拓扑）：启动时不存在并发持有者。
 * 崩溃窗口自愈：重排队后、派发前再崩，run 留在 queued，下次启动照常派发。
 */
export async function recoverInterruptedRuns(runAnalysis: (runId: number) => Promise<void>, execute: Execute = defaultExecute) {
  const [result] = await execute(
    `UPDATE analysis_runs SET status = 'queued', error_message = NULL, finished_at = NULL
     WHERE status = 'running' OR (status = 'failed' AND error_message = ?)`,
    [orphanedRunMessage],
  ) as [{ affectedRows?: number }, unknown];
  const requeued = result.affectedRows ?? 0;

  const [rows] = await execute("SELECT id FROM analysis_runs WHERE status = 'queued' ORDER BY id", []) as [Array<{ id: number }>, unknown];
  for (const row of rows) void runAnalysis(Number(row.id)).catch(() => undefined);
  return { requeued, dispatched: rows.length };
}

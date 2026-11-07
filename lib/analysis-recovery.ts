import { defaultExecute, type Execute } from "./db";

export const orphanedRunMessage = "analysis interrupted by server restart (orphaned running run)";

/**
 * 服务重启后遗留的 running run 已无主进程（after() 任务随进程消亡）：
 * 标记为失败，产品卡片不再无限“分析中”。单实例部署假设（README 拓扑）：
 * 启动时不存在并发持有者，置失败是安全且诚实的。
 */
export async function failOrphanedRuns(execute: Execute = defaultExecute) {
  const [result] = await execute(
    `UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE status = 'running'`,
    [orphanedRunMessage],
  ) as [{ affectedRows?: number }, unknown];
  return result.affectedRows ?? 0;
}

/** 重启时遗留的 queued run 同样失去了 after() 执行者：fire-and-forget 重新派发。 */
export async function redispatchQueuedRuns(runAnalysis: (runId: number) => Promise<void>, execute: Execute = defaultExecute) {
  const [rows] = await execute("SELECT id FROM analysis_runs WHERE status = 'queued' ORDER BY id", []) as [Array<{ id: number }>, unknown];
  for (const row of rows) void runAnalysis(Number(row.id)).catch(() => undefined);
  return rows.length;
}

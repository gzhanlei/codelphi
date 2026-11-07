export async function register() {
  // 启动恢复：重启会杀掉 after() 里的在途分析，遗留的 running/queued run
  // 永远无人认领（loadRun 只认 queued/failed）。这里 running 置失败、
  // queued 重新派发；失败只记日志，不阻塞服务就绪。
  try {
    const { failOrphanedRuns, redispatchQueuedRuns } = await import("./lib/analysis-recovery");
    const { runAnalysis } = await import("./lib/analysis");
    const failed = await failOrphanedRuns();
    if (failed > 0) console.log(`[analysis-recovery] marked ${failed} orphaned running run(s) as failed`);
    const queued = await redispatchQueuedRuns(runAnalysis);
    if (queued > 0) console.log(`[analysis-recovery] re-dispatched ${queued} queued run(s)`);
  } catch (error) {
    console.error("[analysis-recovery] startup recovery skipped", error);
  }
}

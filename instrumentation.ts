export async function register() {
  // 启动恢复：重启会杀掉 after() 里的在途分析，遗留的 running run（含旧版本
  // 置为孤儿失败的）由 recoverInterruptedRuns 重新排队并派发——saveResult 是
  // 原子事务，孤儿 run 未落库，补跑安全且幂等；用户看到「等待分析」而非失败。
  try {
    const { recoverInterruptedRuns } = await import("./lib/analysis-recovery");
    const { runAnalysis } = await import("./lib/analysis");
    const { requeued, dispatched } = await recoverInterruptedRuns(runAnalysis);
    if (requeued > 0) console.log(`[analysis-recovery] re-queued ${requeued} interrupted run(s)`);
    if (dispatched > 0) console.log(`[analysis-recovery] re-dispatched ${dispatched} queued run(s)`);
  } catch (error) {
    console.error("[analysis-recovery] startup recovery skipped", error);
  }
}

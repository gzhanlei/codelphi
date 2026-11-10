/**
 * 本地 dev 防护（2026-11-11 事故复盘）：.env 若指向生产库，dev 启动会触发
 * 启动恢复与 sweep，直接作用于生产数据（派发 run、发通知、动账务）。
 * development 默认跳过两者；确需本地联调时显式 ALLOW_PROD_SIDE_EFFECTS=true 放行。
 * 生产（next start，NODE_ENV=production）不受影响。
 */
export function allowStartupSideEffects(): boolean {
  if (process.env.NODE_ENV === "development") return process.env.ALLOW_PROD_SIDE_EFFECTS === "true";
  return true;
}

export async function register() {
  // 启动恢复：重启会杀掉 after() 里的在途分析，遗留的 running run（含旧版本
  // 置为孤儿失败的）由 recoverInterruptedRuns 重新排队并派发——saveResult 是
  // 原子事务，孤儿 run 未落库，补跑安全且幂等；用户看到「等待分析」而非失败。
  try {
    if (!allowStartupSideEffects()) {
      console.log("[analysis-recovery] skipped in development (set ALLOW_PROD_SIDE_EFFECTS=true to override)");
    } else {
      const { recoverInterruptedRuns } = await import("./lib/analysis-recovery");
      const { runAnalysis } = await import("./lib/analysis");
      const { requeued, dispatched } = await recoverInterruptedRuns(runAnalysis);
      if (requeued > 0) console.log(`[analysis-recovery] re-queued ${requeued} interrupted run(s)`);
      if (dispatched > 0) console.log(`[analysis-recovery] re-dispatched ${dispatched} queued run(s)`);
    }
  } catch (error) {
    console.error("[analysis-recovery] startup recovery skipped", error);
  }

  // 账务 sweep（M1-T6）：预留 TTL 清理（五行处置 + 扫描二结算恢复，D15）+
  // 限流过期行清理；GET_LOCK 互斥防重叠，BILLING_SWEEP_ENABLED=false 关闭；
  // M3-T4 复用同一骨架扩展支付 job。
  try {
    if (!allowStartupSideEffects()) {
      console.log("[billing] sweeps skipped in development (set ALLOW_PROD_SIDE_EFFECTS=true to override)");
    } else {
      const { startBillingSweeps } = await import("./lib/billing/sweep");
      const sweep = startBillingSweeps();
      if (sweep.started) console.log(`[billing] sweeps started: ${(sweep.jobs ?? []).join(", ")}`);
    }
  } catch (error) {
    console.error("[billing] sweeps failed to start", error);
  }
}

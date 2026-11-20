import "dotenv/config";

/**
 * Task 15 bench 断点续跑入口（scratch 库专用）：npx tsx scripts/bench-resume.ts <runId>
 * 直接对既有 run 调 runAnalysis——manifest 校验加载、已提交 extracted/no_behavior 任务
 * 复用（绝不重跑）、failed 且 attempts<max 的任务用当前代码重试。FULL_ANALYSIS_MODE
 * 由 run 的编排路由决定（全量 run 按进程 env），调用方负责设置。
 */
process.env.FULL_ANALYSIS_MODE = process.argv[3] ?? process.env.FULL_ANALYSIS_MODE ?? "inventory";

async function main() {
  const runId = Number(process.argv[2]);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error("usage: bench-resume.ts <runId> [mode]");
  const { runAnalysis } = await import("../lib/analysis");
  const { getDb } = await import("../lib/db");
  console.log(`[bench] resume runId=${runId} mode=${process.env.FULL_ANALYSIS_MODE} starting`);
  const startedAt = Date.now();
  await runAnalysis(runId);
  const [rows] = (await getDb().execute(
    "SELECT status, error_message FROM analysis_runs WHERE id = ?",
    [runId],
  )) as unknown as [Array<{ status: string; error_message: string | null }>, unknown];
  const row = rows[0];
  console.log(JSON.stringify({ runId, status: row.status, durationMs: Date.now() - startedAt, error: row.error_message ? row.error_message.slice(0, 400) : null }, null, 2));
  process.exitCode = row.status === "succeeded" ? 0 : 1;
  process.exit(process.exitCode);
}

void main().catch((error: unknown) => {
  console.error("[bench] resume crashed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

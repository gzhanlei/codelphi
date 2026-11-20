/**
 * Task 15 bench 单次运行入口（scratch 库专用）：
 *   npx tsx scripts/bench-run-once.ts legacy|inventory
 * 为 gzhanlei/codelphi @ e157bab 建一条 manual 全量 run，然后走真实 runAnalysis。
 * FULL_ANALYSIS_MODE 在导入 lib 前由 argv 设置；产物只落 codelphi_bench，绝不触碰生产库。
 * 退出码：0 = run succeeded；1 = failed/queued（error_message 已打印）。
 */
import "dotenv/config";

const mode = process.argv[2] === "inventory" ? "inventory" : "legacy";
process.env.FULL_ANALYSIS_MODE = mode;

async function main() {
  const { getDb } = await import("../lib/db");
  const { runAnalysis } = await import("../lib/analysis");
  const db = getDb();
  const afterSha = "e157baba2bb1ae58f719c43f3a453e5b28326f33";
  const [inserted] = (await db.execute(
    `INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status, account_id)
     SELECT id, 'manual', NULL, ?, 'queued', 1 FROM repositories
     WHERE owner = 'gzhanlei' AND name = 'codelphi' LIMIT 1`,
    [afterSha],
  )) as unknown as [{ insertId: number }, unknown];
  const runId = Number(inserted.insertId);
  console.log(`[bench] mode=${mode} runId=${runId} after=${afterSha.slice(0, 8)} starting`);
  const startedAt = Date.now();
  await runAnalysis(runId);
  const [rows] = (await db.execute(
    "SELECT status, error_message, started_at, finished_at FROM analysis_runs WHERE id = ?",
    [runId],
  )) as unknown as [Array<{ status: string; error_message: string | null }>, unknown];
  const row = rows[0];
  console.log(JSON.stringify({
    mode,
    runId,
    status: row.status,
    durationMs: Date.now() - startedAt,
    error: row.error_message ? row.error_message.slice(0, 600) : null,
  }, null, 2));
  process.exitCode = row.status === "succeeded" ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error("[bench] runner crashed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

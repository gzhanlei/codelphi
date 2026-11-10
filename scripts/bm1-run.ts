import "dotenv/config";
import { getDb } from "../lib/db";
import { queueAnalysis, runAnalysis } from "../lib/analysis";

// BM-1 受控真增量运行：显式 beforeSha（= v48.sha）→ afterSha（master HEAD）
const BEFORE = "2645396b7a8ea1f5b1978f94b2ac0ec0c1b1397b";
const AFTER = "a131fcb623d88ed9eb7e7a414e226437423d645c";

async function main() {
  const db = getDb();
  try {
    const runId = await queueAnalysis(5, BEFORE, AFTER, "manual");
    console.log(`[bm1] run ${runId} queued (before=${BEFORE.slice(0, 7)} after=${AFTER.slice(0, 7)})`);
    await runAnalysis(runId);
    const [rows] = await db.execute(
      "SELECT id, status, before_sha, after_sha, error_message FROM analysis_runs WHERE id = ?",
      [runId],
    );
    console.log("[bm1] result", JSON.stringify(rows));
    const status = (rows as Array<{ status: string }>)[0]?.status;
    process.exitCode = status === "succeeded" ? 0 : 1;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

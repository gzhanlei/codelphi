/**
 * Execution batch benchmark 双臂入口（Task 11，scratch 库专用）：
 *   npx tsx scripts/execution-batch-benchmark.ts --mode task|batch --commit <sha> --concurrency 4
 * 固定 FULL_ANALYSIS_MODE=inventory；--mode 映射 ANALYSIS_BEHAVIOR_EXECUTION_MODE
 * （task|batch，缺省/垃圾值 task 由 lib/env 兜底）。同 commit/manifest/模型配置下
 * 分别成 run；产物只落 codelphi_bench，绝不触碰生产库。
 * 退出码：0 = run succeeded；1 = failed/queued（error_message 已打印）。
 */
import "dotenv/config";

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

const mode = argValue("--mode") === "batch" ? "batch" : "task";
const commit = argValue("--commit");
const concurrency = Number(argValue("--concurrency") ?? "4");

if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) {
  console.error("[bench] 缺少或非法 --commit（Git revision 必须在 origin 可达）");
  process.exit(2);
}
if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 16) {
  console.error("[bench] 非法 --concurrency（1-16）");
  process.exit(2);
}

process.env.FULL_ANALYSIS_MODE = "inventory";
process.env.ANALYSIS_BEHAVIOR_EXECUTION_MODE = mode;
process.env.BEHAVIOR_ANALYSIS_CONCURRENCY = String(concurrency);

interface Accounting {
  mode: "task" | "batch";
  runId: number;
  totalRequests: number;
  batchableDescribeJudgeCalls: number;
  totalTokens: number;
  costAmount: number;
  wallTimeMs: number | null;
  extractedCount: number;
  noBehaviorCount: number;
  unresolvedCount: number;
  failedCount: number;
  truncationCount: number | null;
  parseFailures: number | null;
  receiptsUnknown: number;
  notes: string[];
}

async function main() {
  const { getDb } = await import("../lib/db");
  const { runAnalysis } = await import("../lib/analysis");
  const db = getDb();
  const [inserted] = (await db.execute(
    `INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status, account_id)
     SELECT id, 'manual', NULL, ?, 'queued', 1 FROM repositories
     WHERE owner = 'gzhanlei' AND name = 'codelphi' LIMIT 1`,
    [commit],
  )) as unknown as [{ insertId: number }, unknown];
  const runId = Number(inserted.insertId);
  console.log(`[bench] mode=${mode} runId=${runId} commit=${commit.slice(0, 8)} concurrency=${concurrency} starting`);
  const startedAt = Date.now();
  await runAnalysis(runId);
  const elapsed = Date.now() - startedAt;
  const [rows] = (await db.execute(
    "SELECT status, error_message, started_at, finished_at FROM analysis_runs WHERE id = ?",
    [runId],
  )) as unknown as [Array<{ status: string; error_message: string | null; started_at: Date | null; finished_at: Date | null }>, unknown];
  const run = rows[0]!;

  // ---- 会计聚合（冻结口径：requests/tokens/cost/wall time 四类独立，§3）----
  const notes: string[] = [];
  const num = (value: unknown): number => Number(value ?? 0);
  const [requestRows] = (await db.execute(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN usage_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_n,
            SUM(CASE WHEN call_kind = 'batch' THEN 1 ELSE 0 END) AS batch_calls,
            SUM(CASE WHEN call_stage IN ('describe', 'judge') AND (call_kind IS NULL OR call_kind = 'task' OR call_kind = 'task_repair') THEN 1 ELSE 0 END) AS batchable_calls,
            SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
            SUM(COALESCE(llm_cost_amount, 0)) AS cost
       FROM llm_call_receipts WHERE run_id = ?`,
    [runId],
  )) as unknown as [Array<Record<string, unknown>>, unknown];
  const requestRow = requestRows[0]!;

  const [taskRows] = (await db.execute(
    `SELECT status, COUNT(*) AS n FROM analysis_behavior_tasks WHERE run_id = ? GROUP BY status`,
    [runId],
  )) as unknown as [Array<{ status: string; n: number }>, unknown];
  const statusCount = (status: string): number => num(taskRows.find((row) => row.status === status)?.n);

  const [truncRows] = (await db.execute(
    `SELECT COUNT(*) AS n FROM analysis_behavior_batch_requests
      WHERE batch_attempt_uuid IN (SELECT batch_attempt_uuid FROM analysis_behavior_batch_attempts WHERE run_id = ?)
        AND provider_finish_reason = 'length'`,
    [runId],
  )) as unknown as [Array<Record<string, unknown>>, unknown];

  const accounting: Accounting = {
    mode,
    runId,
    totalRequests: num(requestRow.n),
    // 冻结分母：该臂实际可组批 describe/judge 调用（不含 semantic_repair/product_summary）
    batchableDescribeJudgeCalls: num(requestRow.batchable_calls),
    totalTokens: num(requestRow.tokens),
    costAmount: num(requestRow.cost),
    wallTimeMs: run.started_at && run.finished_at ? Date.parse(String(run.finished_at)) - Date.parse(String(run.started_at)) : null,
    extractedCount: statusCount("extracted"),
    noBehaviorCount: statusCount("no_behavior"),
    unresolvedCount: statusCount("unresolved"),
    failedCount: statusCount("failed"),
    // 截断口径：batch 臂用 batch_requests.provider_finish_reason；task 臂无此表 → null（诚实缺失）
    truncationCount: mode === "batch" ? num(truncRows[0]?.n) : null,
    // 硬失败计数口径：failed 状态含源不可读等，非纯解析失败 → 标注
    parseFailures: null,
    receiptsUnknown: num(requestRow.unknown_n),
    notes,
  };
  if (mode === "task") {
    notes.push("task 臂截断计数不可得（batch_requests 表仅 batch 臂写入）：truncationCount=null");
  }
  notes.push("parseFailures 以 failed 状态近似不可靠：导出 null，failedCount 另列");
  if (run.status !== "succeeded") {
    notes.push(`run 未成功：${String(run.error_message ?? "").slice(0, 400)}`);
  }

  console.log(JSON.stringify({
    mode,
    runId,
    status: run.status,
    durationMs: elapsed,
    accounting,
    error: run.error_message ? run.error_message.slice(0, 600) : null,
  }, null, 2));
  process.exitCode = run.status === "succeeded" ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error("[bench] runner crashed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

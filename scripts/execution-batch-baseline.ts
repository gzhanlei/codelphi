/**
 * Execution run 画像 CLI（只读，计划 Task 1）：
 *   npx tsx scripts/execution-batch-baseline.ts --run-id <runId> [--output <path>]
 * 读取指定 run 的 run 行/manifest/tasks/receipts/reservations 做实测画像；不读取或打印
 * 硬编码凭证。官方统计基线 JSON（artifacts/execution-batch/run-baseline.json）待
 * Task 11 配对基准的 task 模式臂完成后由本 CLI 产出；没有实测数据时不用估算替代。
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultExecute } from "../lib/db";
import {
  summarizeExecutionBaseline,
  type BaselineInput,
  type BaselineReceiptFact,
  type BaselineRunFact,
  type BaselineTaskFact,
} from "../lib/execution-batch/baseline";

interface CliArgs {
  runId: number;
  output: string;
}

interface Row extends Record<string, unknown> {}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.length > 0 ? text : null;
}

async function selectRows(statement: string, parameters: Array<string | number | null>): Promise<Row[]> {
  const [rows] = (await defaultExecute(statement, parameters)) as [Row[], unknown];
  return rows;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let runId: number | null = null;
  let output = "artifacts/execution-batch/run-baseline.json";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") {
      runId = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
    } else if (argv[index] === "--output") {
      output = argv[index + 1] ?? output;
      index += 1;
    }
  }
  if (runId === null || !Number.isInteger(runId) || runId <= 0) {
    throw new Error("缺少或非法 --run-id；用法：npx tsx scripts/execution-batch-baseline.ts --run-id <runId> [--output <path>]");
  }
  return { runId, output };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.runId;

  const runRows = await selectRows(
    "SELECT id, status, trigger_type, after_sha, started_at, finished_at FROM analysis_runs WHERE id = ?",
    [runId],
  );
  if (runRows.length === 0) {
    console.error(`run ${runId} 不存在`);
    return 1;
  }
  const runRow = runRows[0]!;
  const runFact: BaselineRunFact = {
    runId: Number(runRow.id),
    status: str(runRow.status) ?? "unknown",
    triggerType: str(runRow.trigger_type) ?? "unknown",
    afterSha: str(runRow.after_sha),
    startedAt: str(runRow.started_at),
    finishedAt: str(runRow.finished_at),
  };

  const receiptRows = await selectRows(
    `SELECT call_stage, outcome, usage_status, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens, llm_cost_amount
       FROM llm_call_receipts WHERE run_id = ?`,
    [runId],
  );
  const receipts: BaselineReceiptFact[] = receiptRows.map((row) => ({
    callStage: str(row.call_stage),
    outcome: str(row.outcome) ?? "failed",
    usageStatus: str(row.usage_status) ?? "unknown",
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheHitTokens: num(row.cache_hit_tokens),
    cacheMissTokens: num(row.cache_miss_tokens),
    llmCostAmount: row.llm_cost_amount === null || row.llm_cost_amount === undefined ? null : String(row.llm_cost_amount),
    // duration_ms 列由 Task 4 gateway 扩展引入；此前画像一律 null + 原因，不反推。
    durationMs: num(row.duration_ms),
  }));

  const taskRows = await selectRows(
    `SELECT status, attempts, scenario_count, reviewed_count, unresolved_anchor_count
       FROM analysis_behavior_tasks WHERE run_id = ?`,
    [runId],
  );
  const tasks: BaselineTaskFact[] = taskRows.map((row) => ({
    status: str(row.status) ?? "unknown",
    attempts: num(row.attempts) ?? 0,
    scenarioCount: num(row.scenario_count) ?? 0,
    reviewedCount: num(row.reviewed_count) ?? 0,
    unresolvedAnchorCount: num(row.unresolved_anchor_count) ?? 0,
  }));

  const reservationRows = await selectRows(
    "SELECT kind, status FROM analysis_behavior_budget_reservations WHERE run_id = ?",
    [runId],
  );
  const reservations = reservationRows.map((row) => ({ kind: str(row.kind) ?? "unknown", status: str(row.status) ?? "unknown" }));

  const manifestRows = await selectRows(
    "SELECT manifest_hash, inventory_generated_at FROM analysis_behavior_manifests WHERE run_id = ?",
    [runId],
  );

  const input: BaselineInput = { run: runFact, receipts, tasks, reservations };
  const summary = summarizeExecutionBaseline(input);
  const payload = {
    runId,
    generatedAt: new Date().toISOString(),
    manifest: manifestRows[0]
      ? { manifestHash: str(manifestRows[0]!.manifest_hash), generatedAt: str(manifestRows[0]!.inventory_generated_at) }
      : null,
    summary,
  };

  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`run ${runId} 画像 → ${args.output}`);
  console.log(
    `calls=${summary.totalCalls} (describe=${summary.stageCalls.describe} judge=${summary.stageCalls.judge} repair=${summary.stageCalls.semantic_repair} summary=${summary.stageCalls.product_summary} other=${summary.stageCalls.other})`,
  );
  console.log(
    `usage known/unknown=${summary.usage.knownCalls}/${summary.usage.unknownCalls} tasks=${summary.tasks.total} completions=${summary.tasks.successfulCompletions}`,
  );
  for (const note of [...summary.notes, ...summary.usage.reasons, ...summary.latency.reasons, ...summary.efficiency.reasons, ...summary.wallTime.reasons]) {
    console.log(`note: ${note}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

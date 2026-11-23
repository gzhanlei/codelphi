#!/usr/bin/env tsx
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { databaseConfig } from "../lib/database-config";
import { getDb } from "../lib/db";
import {
  aggregatePipelineUsage,
  assertBenchmarkDatabaseName,
  resolveBenchDatabaseUrl,
  type PipelineReceiptRow,
  type PipelineTaskRow,
} from "../lib/pipeline-usage";

function args(argv: readonly string[]): { runId: number; out: string } {
  let runId: number | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-id") runId = Number(argv[++index]);
    else if (argv[index] === "--out") out = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(runId) || Number(runId) < 1 || !out) {
    throw new Error("usage: tsx scripts/export-pipeline-usage.ts --run-id <id> --out <usage.json>");
  }
  return { runId: Number(runId), out };
}

export async function exportPipelineUsage(runId: number, out: string): Promise<void> {
  process.env.DATABASE_URL = resolveBenchDatabaseUrl(process.env.DATABASE_URL!, process.env.BENCH_DATABASE);
  assertBenchmarkDatabaseName(databaseConfig().database ?? "");
  const db = getDb();
  try {
    const [receiptRows] = await db.execute(
      "SELECT task_key AS taskKey, call_stage AS callStage FROM llm_call_receipts WHERE run_id = ? ORDER BY id",
      [runId],
    ) as [PipelineReceiptRow[], unknown];
    const [taskRows] = await db.execute(
      "SELECT task_key AS taskKey, status FROM analysis_behavior_tasks WHERE run_id = ? ORDER BY task_key",
      [runId],
    ) as [PipelineTaskRow[], unknown];
    const usage = aggregatePipelineUsage(receiptRows, taskRows);
    writeFileSync(out, `${JSON.stringify({ schema: "analysis-pipeline-usage-v1", runId, ...usage }, null, 2)}\n`);
    console.log(`[export-pipeline-usage] runId=${runId} tasks=${usage.tasks.length} productSummary=${usage.productSummary} out=${out}`);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = args(process.argv.slice(2));
  exportPipelineUsage(parsed.runId, parsed.out).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

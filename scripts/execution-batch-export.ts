/**
 * Task 11 对照文件组装（scratch 库专用）：
 *   npx tsx scripts/execution-batch-export.ts --task-run <id> --batch-run <id> --task-accounting <json> --batch-accounting <json> --out <path>
 * 从两臂 accounting JSON（scripts/execution-batch-benchmark.ts 输出）+ 盲评会计
 * （docs/benchmark 盲评流程产出）组装 batch-comparison.json——只导出真实记录，
 * 盲评缺失时 verdict=inconclusive（不得视为通过）。统计计算复用 evaluateBenchmarkOutcome。
 */
import "dotenv/config";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { evaluateBenchmarkOutcome, type BenchmarkArmAccounting, type BenchmarkBlindAccounting } from "../lib/execution-batch/benchmark";

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function readAccounting(path: string | null, label: string): BenchmarkArmAccounting {
  if (!path) throw new Error(`缺少 --${label}-accounting`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { accounting: BenchmarkArmAccounting };
  return parsed.accounting;
}

async function main() {
  const taskRun = argValue("--task-run");
  const batchRun = argValue("--batch-run");
  const taskAccounting = readAccounting(argValue("--task-accounting"), "task");
  const batchAccounting = readAccounting(argValue("--batch-accounting"), "batch");
  const out = argValue("--out") ?? "artifacts/execution-batch/batch-comparison.json";
  const blindPath = argValue("--blind-accounting");

  let blindAccounting: BenchmarkBlindAccounting | null = null;
  if (blindPath) {
    blindAccounting = JSON.parse(readFileSync(blindPath, "utf8")) as BenchmarkBlindAccounting;
  } else {
    console.warn("[export] 未提供 --blind-accounting：verdict=inconclusive（盲评缺失不得视为通过）");
  }

  const outcome = evaluateBenchmarkOutcome({ taskArm: taskAccounting, batchArm: batchAccounting, blindAccounting });
  const payload = {
    generatedAt: new Date().toISOString(),
    commit: process.env.BENCH_COMMIT ?? null,
    modelConfig: { note: "scratch .env 冻结配置（AI_MODEL/AI_BASE_URL 等）" },
    runs: { task: taskRun, batch: batchRun },
    outcome,
  };
  mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[export] verdict=${outcome.verdict} → ${out}`);
  for (const reason of outcome.reasons) console.log(`reason: ${reason}`);
}

void main().catch((error: unknown) => {
  console.error("[export] crashed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

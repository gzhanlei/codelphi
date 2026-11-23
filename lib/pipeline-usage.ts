export interface PipelineReceiptRow {
  taskKey: string | null;
  callStage: string | null;
}

export interface PipelineTaskRow {
  taskKey: string;
  status: string;
}

export interface PipelineTaskUsage {
  taskKey: string;
  total: number;
  describe: number;
  judge: number;
  semanticRepair: number;
  reusedTerminal: boolean;
}

export interface PipelineUsage {
  tasks: PipelineTaskUsage[];
  productSummary: number;
}

function emptyTask(taskKey: string): PipelineTaskUsage {
  return { taskKey, total: 0, describe: 0, judge: 0, semanticRepair: 0, reusedTerminal: false };
}

export function aggregatePipelineUsage(
  receipts: readonly PipelineReceiptRow[],
  taskRows: readonly PipelineTaskRow[],
): PipelineUsage {
  const byTask = new Map<string, PipelineTaskUsage>();
  for (const row of taskRows) byTask.set(row.taskKey, emptyTask(row.taskKey));
  let productSummary = 0;
  for (const receipt of receipts) {
    if (receipt.taskKey === null) {
      if (receipt.callStage === "product_summary") productSummary += 1;
      continue;
    }
    const task = byTask.get(receipt.taskKey) ?? emptyTask(receipt.taskKey);
    byTask.set(receipt.taskKey, task);
    task.total += 1;
    if (receipt.callStage === "describe") task.describe += 1;
    else if (receipt.callStage === "judge") task.judge += 1;
    else if (receipt.callStage === "semantic_repair") task.semanticRepair += 1;
  }
  const receiptTaskKeys = new Set(receipts.map((receipt) => receipt.taskKey).filter((key): key is string => key !== null));
  for (const row of taskRows) {
    if ((row.status === "extracted" || row.status === "no_behavior") && !receiptTaskKeys.has(row.taskKey)) {
      byTask.get(row.taskKey)!.reusedTerminal = true;
    }
  }
  return {
    tasks: [...byTask.values()].sort((left, right) => left.taskKey.localeCompare(right.taskKey)),
    productSummary,
  };
}

export function resolveBenchDatabaseUrl(databaseUrl: string, databaseOverride?: string): string {
  const url = new URL(databaseUrl);
  if (databaseOverride) url.pathname = `/${databaseOverride}`;
  assertBenchmarkDatabaseName(url.pathname.replace(/^\//, ""));
  return url.toString();
}

export function assertBenchmarkDatabaseName(database: string): void {
  if (database !== "codelphi_bench" && !database.startsWith("codelphi_bench_") && !database.endsWith("_bench")) {
    throw new Error(`refusing to export usage from non-scratch database: ${database}`);
  }
}

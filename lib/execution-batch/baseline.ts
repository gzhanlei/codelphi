/**
 * Execution run 画像聚合（纯函数，计划 Task 1）：对任意已完成 run 的回执/任务/预留做确定性汇总。
 * 诚实纪律：缺失观测输出 null + 原因，绝不写 0，绝不从总时长或 task 数反推缺失阶段耗时。
 * 官方统计基线 = Task 11 配对基准 task 模式臂的实测画像（spec §18/§20.3/§23.8）；
 * unresolved/failed/pending/running 不进入 R1/R2/R3 分母，防止以质量下降美化效率。
 */

export interface BaselineReceiptFact {
  /** describe | judge | semantic_repair | product_summary；null/其他计为 other（历史行）。 */
  callStage: string | null;
  outcome: string;
  usageStatus: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  llmCostAmount: string | number | null;
  durationMs: number | null;
}

export interface BaselineTaskFact {
  status: string;
  attempts: number;
  scenarioCount: number;
  reviewedCount: number;
  unresolvedAnchorCount: number;
}

export interface BaselineRunFact {
  runId: number;
  status: string;
  triggerType: string;
  afterSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BaselineReservationFact {
  kind: string;
  status: string;
}

export interface BaselineInput {
  run: BaselineRunFact | null;
  receipts: BaselineReceiptFact[];
  tasks: BaselineTaskFact[];
  reservations: BaselineReservationFact[];
}

export interface BaselineStageCalls {
  describe: number;
  judge: number;
  semantic_repair: number;
  product_summary: number;
  other: number;
}

export interface BaselineUsage {
  knownCalls: number;
  unknownCalls: number;
  inputTokensKnown: number | null;
  outputTokensKnown: number | null;
  cacheTokensKnown: number | null;
  costAmountKnown: number | null;
  reasons: string[];
}

export interface BaselineLatency {
  samples: number;
  durationMsP50: number | null;
  durationMsP90: number | null;
  durationMsP99: number | null;
  reasons: string[];
}

export interface BaselineWallTime {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  reasons: string[];
}

export interface BaselineEfficiency {
  r1CallsPerSuccessfulTask: number | null;
  r2TokensPerSuccessfulTask: number | null;
  r3SuccessfulTasksPerMinute: number | null;
  reasons: string[];
}

export interface BaselineSummary {
  runId: number | null;
  runStatus: string | null;
  totalCalls: number;
  stageCalls: BaselineStageCalls;
  outcomeCalls: { success: number; failed: number; timeout: number };
  usage: BaselineUsage;
  latency: BaselineLatency;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    successfulCompletions: number;
    attemptsTotal: number;
    retryTasks: number;
    unresolved: number;
    scenarioCountTotal: number;
    reviewedCountTotal: number;
    unresolvedAnchorCountTotal: number;
  };
  efficiency: BaselineEfficiency;
  wallTime: BaselineWallTime;
  reservations: { byKind: Record<string, { total: number; byStatus: Record<string, number> }> };
  benchmarkBaseline: { status: "awaiting_task_arm"; note: string };
  notes: string[];
}

const STAGE_KEYS = ["describe", "judge", "semantic_repair", "product_summary"] as const;
const SUCCESS_STATUSES = new Set(["extracted", "no_behavior"]);
const OUTCOME_KEYS = ["success", "failed", "timeout"] as const;

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function parseCost(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ReceiptSummary {
  totalCalls: number;
  stageCalls: BaselineStageCalls;
  outcomeCalls: { success: number; failed: number; timeout: number };
  usage: BaselineUsage;
  /** known token 汇总完整（无缺值）且至少有一条回执——R2 可用的前提。 */
  usageKnownComplete: boolean;
  latency: BaselineLatency;
  notes: string[];
}

function summarizeReceiptFacts(receipts: BaselineReceiptFact[]): ReceiptSummary {
  const notes: string[] = [];
  const stageCalls: BaselineStageCalls = { describe: 0, judge: 0, semantic_repair: 0, product_summary: 0, other: 0 };
  const outcomeCalls = { success: 0, failed: 0, timeout: 0 };
  const usageReasons: string[] = [];
  const latencyReasons: string[] = [];
  const durationSamples: number[] = [];
  let totalCalls = 0;
  let knownCalls = 0;
  let unknownCalls = 0;
  let inputTokensKnown = 0;
  let outputTokensKnown = 0;
  let cacheTokensKnown = 0;
  let costKnown = 0;
  let tokenGap = false;
  let costGap = false;

  for (const receipt of receipts) {
    totalCalls += 1;
    if ((STAGE_KEYS as readonly string[]).includes(receipt.callStage ?? "")) {
      stageCalls[receipt.callStage as (typeof STAGE_KEYS)[number]] += 1;
    } else {
      stageCalls.other += 1;
    }
    const outcomeKey = (OUTCOME_KEYS as readonly string[]).includes(receipt.outcome)
      ? (receipt.outcome as keyof typeof outcomeCalls)
      : "failed";
    outcomeCalls[outcomeKey] += 1;
    if (receipt.usageStatus === "unknown") {
      unknownCalls += 1;
      continue;
    }
    knownCalls += 1;
    if (receipt.inputTokens !== null) inputTokensKnown += receipt.inputTokens;
    else tokenGap = true;
    if (receipt.outputTokens !== null) outputTokensKnown += receipt.outputTokens;
    else tokenGap = true;
    if (receipt.cacheHitTokens !== null && receipt.cacheMissTokens !== null) {
      cacheTokensKnown += receipt.cacheHitTokens + receipt.cacheMissTokens;
    } else {
      tokenGap = true;
    }
    const cost = parseCost(receipt.llmCostAmount);
    if (cost !== null) costKnown += cost;
    else costGap = true;
    if (receipt.durationMs !== null && Number.isFinite(receipt.durationMs)) {
      durationSamples.push(receipt.durationMs);
    }
  }

  if (tokenGap) {
    usageReasons.push("部分 known usage 回执缺 token/cache 值：known 汇总 withheld 为 null，避免低估");
  }
  if (costGap) {
    usageReasons.push("部分 known usage 回执缺 cost：cost 汇总 withheld 为 null，不按 0 记账");
  }
  if (unknownCalls > 0) {
    usageReasons.push(`${unknownCalls} 条回执 usage unknown：不计入 known 汇总，费用按保守规则处理`);
  }
  if (stageCalls.other > 0) {
    notes.push(`${stageCalls.other} 条回执无 batch stage 标签（历史行），计入 other`);
  }

  durationSamples.sort((a, b) => a - b);
  if (durationSamples.length === 0) {
    latencyReasons.push("duration_ms 在任何回执上都缺失（Task 4 gateway 扩展前的历史行不记录耗时）：P50/P90/P99 = null，不得由总时长反推");
  } else if (durationSamples.length < totalCalls) {
    latencyReasons.push(`${totalCalls - durationSamples.length} 条回执缺 duration_ms：分位数只基于 ${durationSamples.length} 条真实样本`);
  }

  return {
    totalCalls,
    stageCalls,
    outcomeCalls,
    usage: {
      knownCalls,
      unknownCalls,
      inputTokensKnown: tokenGap ? null : inputTokensKnown,
      outputTokensKnown: tokenGap ? null : outputTokensKnown,
      cacheTokensKnown: tokenGap ? null : cacheTokensKnown,
      costAmountKnown: costGap ? null : costKnown,
      reasons: usageReasons,
    },
    usageKnownComplete: !tokenGap && receipts.length > 0,
    latency: {
      samples: durationSamples.length,
      durationMsP50: durationSamples.length > 0 ? percentile(durationSamples, 50) : null,
      durationMsP90: durationSamples.length > 0 ? percentile(durationSamples, 90) : null,
      durationMsP99: durationSamples.length > 0 ? percentile(durationSamples, 99) : null,
      reasons: latencyReasons,
    },
    notes,
  };
}

function summarizeTaskFacts(tasks: BaselineTaskFact[]): BaselineSummary["tasks"] {
  const byStatus: Record<string, number> = {};
  let successfulCompletions = 0;
  let attemptsTotal = 0;
  let retryTasks = 0;
  let unresolved = 0;
  let scenarioCountTotal = 0;
  let reviewedCountTotal = 0;
  let unresolvedAnchorCountTotal = 0;
  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    attemptsTotal += task.attempts;
    if (task.attempts > 1) retryTasks += 1;
    if (task.status === "unresolved") unresolved += 1;
    if (SUCCESS_STATUSES.has(task.status)) successfulCompletions += 1;
    scenarioCountTotal += task.scenarioCount;
    reviewedCountTotal += task.reviewedCount;
    unresolvedAnchorCountTotal += task.unresolvedAnchorCount;
  }
  return {
    total: tasks.length,
    byStatus,
    successfulCompletions,
    attemptsTotal,
    retryTasks,
    unresolved,
    scenarioCountTotal,
    reviewedCountTotal,
    unresolvedAnchorCountTotal,
  };
}

function summarizeWallTime(run: BaselineRunFact | null): BaselineWallTime {
  const startedMs = parseTimestamp(run?.startedAt ?? null);
  const finishedMs = parseTimestamp(run?.finishedAt ?? null);
  if (startedMs !== null && finishedMs !== null) {
    return {
      startedAt: run?.startedAt ?? null,
      endedAt: run?.finishedAt ?? null,
      durationMs: Math.max(0, finishedMs - startedMs),
      reasons: [],
    };
  }
  return {
    startedAt: run?.startedAt ?? null,
    endedAt: run?.finishedAt ?? null,
    durationMs: null,
    reasons: ["run started_at/finished_at 缺失：墙钟 unavailable，不得从 created_at 或 task 数反推"],
  };
}

function summarizeEfficiency(
  totalCalls: number,
  usage: BaselineUsage,
  usageKnownComplete: boolean,
  successfulCompletions: number,
  wallTime: BaselineWallTime,
): BaselineEfficiency {
  const reasons: string[] = [];
  const denominator = successfulCompletions;
  const r1 = denominator > 0 ? totalCalls / denominator : null;
  if (r1 === null) reasons.push("无 extracted/no_behavior 完成项：R1 undefined（unresolved 不计入分母）");
  const r2 = denominator > 0 && usageKnownComplete && usage.inputTokensKnown !== null && usage.outputTokensKnown !== null
    ? (usage.inputTokensKnown + usage.outputTokensKnown) / denominator
    : null;
  if (r2 === null) reasons.push("R2 需要完整 known token 汇总与成功完成项：当前不可得");
  const r3 = denominator > 0 && wallTime.durationMs !== null ? denominator / (wallTime.durationMs / 60_000) : null;
  if (r3 === null) reasons.push("R3 需要成功完成项与真实墙钟窗口：当前不可得");
  return {
    r1CallsPerSuccessfulTask: r1,
    r2TokensPerSuccessfulTask: r2,
    r3SuccessfulTasksPerMinute: r3,
    reasons,
  };
}

function summarizeReservations(reservations: BaselineReservationFact[]): BaselineSummary["reservations"] {
  const byKind: Record<string, { total: number; byStatus: Record<string, number> }> = {};
  for (const reservation of reservations) {
    const bucket = (byKind[reservation.kind] ??= { total: 0, byStatus: {} });
    bucket.total += 1;
    bucket.byStatus[reservation.status] = (bucket.byStatus[reservation.status] ?? 0) + 1;
  }
  return { byKind };
}

export function summarizeExecutionBaseline(input: BaselineInput): BaselineSummary {
  const receiptSummary = summarizeReceiptFacts(input.receipts);
  const tasks = summarizeTaskFacts(input.tasks);
  const wallTime = summarizeWallTime(input.run);
  const efficiency = summarizeEfficiency(receiptSummary.totalCalls, receiptSummary.usage, receiptSummary.usageKnownComplete, tasks.successfulCompletions, wallTime);
  const notes = [...receiptSummary.notes];
  if (input.run === null) notes.push("未提供 run 行：run 状态与墙钟不可得");

  return {
    runId: input.run?.runId ?? null,
    runStatus: input.run?.status ?? null,
    totalCalls: receiptSummary.totalCalls,
    stageCalls: receiptSummary.stageCalls,
    outcomeCalls: receiptSummary.outcomeCalls,
    usage: receiptSummary.usage,
    latency: receiptSummary.latency,
    tasks,
    efficiency,
    wallTime,
    reservations: summarizeReservations(input.reservations),
    benchmarkBaseline: {
      status: "awaiting_task_arm",
      note: "官方统计基线由 Task 11 配对基准的 task 模式臂实测产生（docs/benchmark/execution-batch-v1.md）；无历史 run 画像可比",
    },
    notes,
  };
}

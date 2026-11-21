import { describe, expect, it } from "vitest";
import {
  summarizeExecutionBaseline,
  type BaselineInput,
  type BaselineReceiptFact,
  type BaselineRunFact,
  type BaselineTaskFact,
} from "../lib/execution-batch/baseline";

function receipt(overrides: Partial<BaselineReceiptFact> = {}): BaselineReceiptFact {
  return {
    callStage: "describe",
    outcome: "success",
    usageStatus: "known",
    inputTokens: 100,
    outputTokens: 50,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    llmCostAmount: "0.100000",
    durationMs: null,
    ...overrides,
  };
}

function task(overrides: Partial<BaselineTaskFact> = {}): BaselineTaskFact {
  return {
    status: "extracted",
    attempts: 1,
    scenarioCount: 2,
    reviewedCount: 0,
    unresolvedAnchorCount: 0,
    ...overrides,
  };
}

function run(overrides: Partial<BaselineRunFact> = {}): BaselineRunFact {
  return {
    runId: 42,
    status: "succeeded",
    triggerType: "push",
    afterSha: "a".repeat(64),
    startedAt: "2026-11-22T00:00:00.000Z",
    finishedAt: "2026-11-22T00:30:00.000Z",
    ...overrides,
  };
}

describe("execution batch baseline aggregation", () => {
  it("classifies describe judge repair retry and unknown usage separately", () => {
    const input: BaselineInput = {
      run: run(),
      receipts: [
        receipt({ durationMs: 1200 }),
        receipt({ durationMs: 2400 }),
        receipt({ callStage: "judge", durationMs: 3600 }),
        receipt({ callStage: "semantic_repair", outcome: "failed", usageStatus: "unknown", inputTokens: null, outputTokens: null, llmCostAmount: null, durationMs: null }),
        receipt({ callStage: null, outcome: "timeout", usageStatus: "unknown", inputTokens: null, outputTokens: null, llmCostAmount: null, durationMs: null }),
      ],
      tasks: [task(), task({ status: "no_behavior" })],
      reservations: [],
    };
    const summary = summarizeExecutionBaseline(input);
    // 真实回执计数，而不是 2 × taskCount
    expect(summary.totalCalls).toBe(5);
    expect(summary.stageCalls).toEqual({ describe: 2, judge: 1, semantic_repair: 1, product_summary: 0, other: 1 });
    expect(summary.outcomeCalls).toEqual({ success: 3, failed: 1, timeout: 1 });
    expect(summary.usage.unknownCalls).toBe(2);
    expect(summary.usage.knownCalls).toBe(3);
    expect(summary.usage.inputTokensKnown).toBe(300);
    expect(summary.usage.outputTokensKnown).toBe(150);
    expect(summary.usage.costAmountKnown).toBeCloseTo(0.3, 6);
    // 延迟分位数只对有 duration 样本的真实样本计算（3 条 describe/judge 有 duration）
    expect(summary.latency.samples).toBe(3);
    expect(summary.latency.durationMsP50).toBe(2400);
    expect(summary.latency.durationMsP90).toBe(3600);
    expect(summary.latency.durationMsP99).toBe(3600);
  });

  it("does not invent latency or zero cost for missing receipts", () => {
    const input: BaselineInput = {
      run: run({ startedAt: null, finishedAt: null }),
      receipts: [
        receipt({ usageStatus: "unknown", inputTokens: null, outputTokens: null, llmCostAmount: null, durationMs: null }),
        receipt({ llmCostAmount: null, durationMs: null }),
      ],
      tasks: [],
      reservations: [],
    };
    const summary = summarizeExecutionBaseline(input);
    // 缺 duration → null + 原因，绝不写 0
    expect(summary.latency.samples).toBe(0);
    expect(summary.latency.durationMsP50).toBeNull();
    expect(summary.latency.durationMsP90).toBeNull();
    expect(summary.latency.durationMsP99).toBeNull();
    expect(summary.latency.reasons.join(" ")).toMatch(/duration/);
    // known usage 但缺 cost → null + 原因（部分求和会低估，也不得用 0 冒充）
    expect(summary.usage.costAmountKnown).toBeNull();
    expect(summary.usage.reasons.join(" ")).toMatch(/cost/);
    // 缺 run 时间戳 → 墙钟 null + 原因
    expect(summary.wallTime.durationMs).toBeNull();
    expect(summary.wallTime.reasons.join(" ")).toMatch(/started_at/);
  });

  it("counts only extracted and no_behavior as successful completions", () => {
    const input: BaselineInput = {
      run: run(),
      receipts: [
        receipt({ callStage: "describe", durationMs: 1000 }),
        receipt({ callStage: "judge", durationMs: 1000 }),
        receipt({ callStage: "describe", durationMs: 1000 }),
        receipt({ callStage: "judge", durationMs: 1000 }),
        receipt({ callStage: "judge", durationMs: 1000 }),
      ],
      tasks: [
        task(),
        task({ status: "extracted", attempts: 2 }),
        task({ status: "no_behavior" }),
        task({ status: "unresolved" }),
        task({ status: "failed" }),
        task({ status: "pending" }),
        task({ status: "running" }),
      ],
      reservations: [{ kind: "task", status: "settled" }, { kind: "task", status: "released" }],
    };
    const summary = summarizeExecutionBaseline(input);
    expect(summary.tasks.total).toBe(7);
    expect(summary.tasks.successfulCompletions).toBe(3);
    expect(summary.tasks.unresolved).toBe(1);
    expect(summary.tasks.retryTasks).toBe(1);
    expect(summary.tasks.attemptsTotal).toBe(8);
    // unresolved/failed/pending/running 都不进入 R1 分母
    expect(summary.efficiency.r1CallsPerSuccessfulTask).toBeCloseTo(5 / 3, 6);
    expect(summary.efficiency.r2TokensPerSuccessfulTask).toBeCloseTo(750 / 3, 6);
    // R3 = 成功完成数 / 总分钟（30 分钟窗口）
    expect(summary.efficiency.r3SuccessfulTasksPerMinute).toBeCloseTo(3 / 30, 6);
    expect(summary.reservations.byKind.task).toEqual({ total: 2, byStatus: { settled: 1, released: 1 } });
  });
});

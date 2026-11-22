import { describe, expect, it } from "vitest";
import {
  evaluateBenchmarkOutcome,
  type BenchmarkArmAccounting,
  type BenchmarkPairInput,
} from "../lib/execution-batch/benchmark";
import { NON_INFERIORITY_MARGIN } from "../lib/behavior-benchmark";

/** 冻结协议锚点：docs/benchmark/execution-batch-v1.md（Task 1 冻结，不得在实验后调整）。 */
describe("execution batch benchmark accounting (Task 11)", () => {
  const baseArm = (overrides: Partial<BenchmarkArmAccounting> = {}): BenchmarkArmAccounting => ({
    mode: "task",
    runId: 1,
    totalRequests: 100,
    batchableDescribeJudgeCalls: 100,
    totalTokens: 1_000_000,
    costAmount: 10,
    wallTimeMs: 60 * 60_000,
    extractedCount: 30,
    noBehaviorCount: 10,
    unresolvedCount: 5,
    truncationCount: 2,
    parseFailures: 1,
    receiptsUnknown: 0,
    ...overrides,
  });

  const pair = (overrides: Partial<BenchmarkPairInput> = {}): BenchmarkPairInput => ({
    taskArm: baseArm(),
    batchArm: baseArm({ mode: "batch", runId: 2, totalRequests: 40 }),
    blindAccounting: {
      pairedSamples: 34,
      recallDelta: -0.01,
      falsePositiveRise: 0.01,
      evidenceSupportDrop: 0.01,
      reviewedInternalMismatches: 0,
      processGatesPassed: true,
    },
    ...overrides,
  });

  it("uses actual batchable describe and judge calls as request reduction denominator", () => {
    const outcome = evaluateBenchmarkOutcome(pair());
    // 请求降幅 = (task 臂实际可组批调用数 − batch 臂实际调用数) / task 臂实际可组批调用数
    // 不用 2N 或总请求替代可组批分母
    expect(outcome.requestReductionRatio).toBeCloseTo(0.6, 6);
  });

  it("reports request token cost and wall time independently", () => {
    const outcome = evaluateBenchmarkOutcome(pair({
      batchArm: baseArm({ mode: "batch", runId: 2, totalRequests: 40, totalTokens: 900_000, costAmount: 9, wallTimeMs: 40 * 60_000 }),
    }));
    expect(outcome.task.totalTokens).toBe(1_000_000);
    expect(outcome.batch.totalTokens).toBe(900_000);
    expect(outcome.task.costAmount).toBe(10);
    expect(outcome.batch.costAmount).toBe(9);
    expect(outcome.task.wallTimeMs).toBe(60 * 60_000);
    expect(outcome.batch.wallTimeMs).toBe(40 * 60_000);
    // 四类指标互不折算
    expect(outcome.tokenRatio).toBeCloseTo(0.9, 6);
    expect(outcome.costRatio).toBeCloseTo(0.9, 6);
    expect(outcome.wallTimeRatio).toBeCloseTo(2 / 3, 6);
  });

  it("fails process gates before accepting statistical non inferiority", () => {
    const outcome = evaluateBenchmarkOutcome(pair({
      blindAccounting: {
        pairedSamples: 40,
        recallDelta: 0.05,
        falsePositiveRise: -0.01,
        evidenceSupportDrop: 0,
        reviewedInternalMismatches: 0,
        processGatesPassed: false,
      },
    }));
    // 过程门禁失败直接 failed——统计再好也不得通过（冻结协议 §4）
    expect(outcome.verdict).toBe("failed");
    expect(outcome.reasons.some((reason) => reason.includes("process gates"))).toBe(true);
  });

  it("marks missing blind accounting inconclusive rather than passed", () => {
    const outcome = evaluateBenchmarkOutcome(pair({ blindAccounting: null }));
    expect(outcome.verdict).toBe("inconclusive");
    expect(outcome.reasons.some((reason) => reason.includes("blind"))).toBe(true);
    // 样本不足同样 inconclusive（30 是下限≠功效证明）
    const thin = evaluateBenchmarkOutcome(pair({
      blindAccounting: {
        pairedSamples: 12,
        recallDelta: -0.01,
        falsePositiveRise: 0.01,
        evidenceSupportDrop: 0.01,
        reviewedInternalMismatches: 0,
        processGatesPassed: true,
      },
    }));
    expect(thin.verdict).toBe("inconclusive");
  });

  it("fails when recall lower confidence bound breaks the frozen margin or macro guards rise", () => {
    // 召回降幅超过冻结界限（margin -0.03）
    const recallFail = evaluateBenchmarkOutcome(pair({
      blindAccounting: {
        pairedSamples: 40,
        recallDelta: -0.05,
        falsePositiveRise: 0,
        evidenceSupportDrop: 0,
        reviewedInternalMismatches: 0,
        processGatesPassed: true,
      },
    }));
    expect(recallFail.verdict).toBe("failed");
    // 宏误报上升 > 0.03
    const fpFail = evaluateBenchmarkOutcome(pair({
      blindAccounting: {
        pairedSamples: 40,
        recallDelta: 0,
        falsePositiveRise: 0.05,
        evidenceSupportDrop: 0,
        reviewedInternalMismatches: 0,
        processGatesPassed: true,
      },
    }));
    expect(fpFail.verdict).toBe("failed");
    // 宏证据支持下降 > 0.02
    const evidenceFail = evaluateBenchmarkOutcome(pair({
      blindAccounting: {
        pairedSamples: 40,
        recallDelta: 0,
        falsePositiveRise: 0,
        evidenceSupportDrop: 0.05,
        reviewedInternalMismatches: 0,
        processGatesPassed: true,
      },
    }));
    expect(evidenceFail.verdict).toBe("failed");
    // 边界内 + 门禁通过 = passed（margin 常量与冻结协议一致）
    const passing = evaluateBenchmarkOutcome(pair());
    expect(passing.verdict).toBe("passed");
    expect(NON_INFERIORITY_MARGIN).toBe(-0.03);
  });

  it("unresolved inflation and truncation regressions are recorded as reasons not silently accepted", () => {
    const outcome = evaluateBenchmarkOutcome(pair({
      batchArm: baseArm({ mode: "batch", runId: 2, totalRequests: 40, unresolvedCount: 20, truncationCount: 30, parseFailures: 10 }),
    }));
    // unresolved 膨胀与截断暴涨记录在案（防以质量下降美化效率）
    expect(outcome.batch.unresolvedCount).toBe(20);
    expect(outcome.batch.truncationCount).toBe(30);
    expect(outcome.reasons.length).toBeGreaterThan(0);
  });
});

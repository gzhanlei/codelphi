import { NON_INFERIORITY_MARGIN } from "../behavior-benchmark";

/**
 * Task 11 配对基准的会计与裁决（纯函数）：组装冻结协议（docs/benchmark/execution-batch-v1.md）
 * 的四类独立指标（请求/Token/费用/墙钟互不折算）与三值结论（pass/fail/inconclusive）。
 * 统计非劣计算复用 lib/behavior-benchmark.ts（盲评流程产出 recallDelta 等），本模块只做
 * 会计汇总与门禁裁决——不实现第二套非劣统计。
 * 纪律：过程门禁失败直接 failed；盲评缺失/样本不足 inconclusive（不得视为通过）；
 * unresolved 膨胀与截断暴涨记录在案（防以质量下降美化效率）。
 */

export interface BenchmarkArmAccounting {
  mode: "task" | "batch";
  runId: number;
  /** 实际模型请求总数（含 repair/retry）。 */
  totalRequests: number;
  /** 该臂实际可组批 describe/judge 调用数——请求降幅分母的冻结口径（不用 2N 替代）。 */
  batchableDescribeJudgeCalls: number;
  totalTokens: number;
  costAmount: number;
  wallTimeMs: number | null;
  extractedCount: number;
  noBehaviorCount: number;
  unresolvedCount: number;
  truncationCount: number;
  parseFailures: number;
  /** usage unknown 回执条数（未知 ≠ 0）。 */
  receiptsUnknown: number;
}

export interface BenchmarkBlindAccounting {
  /** 冻结人工 behavior 的配对样本数；<30 为 inconclusive（下限≠功效证明）。 */
  pairedSamples: number;
  /** 盲评配对召回差（batch − task），来自 lib/behavior-benchmark 的 Newcombe 区间口径。 */
  recallDelta: number;
  falsePositiveRise: number;
  evidenceSupportDrop: number;
  reviewedInternalMismatches: number;
  /** 过程门禁（manifest hash/key 不变、allowSet 不扩大、激活门禁复用等，§4）全部通过。 */
  processGatesPassed: boolean;
}

export interface BenchmarkPairInput {
  taskArm: BenchmarkArmAccounting;
  batchArm: BenchmarkArmAccounting;
  /** 盲评会计缺失 = inconclusive（不得视为通过）。 */
  blindAccounting: BenchmarkBlindAccounting | null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return numerator / denominator;
}

export interface BenchmarkOutcome {
  task: BenchmarkArmAccounting;
  batch: BenchmarkArmAccounting;
  /** 请求降幅 = (task 可组批调用 − batch 实际调用) / task 可组批调用。 */
  requestReductionRatio: number | null;
  tokenRatio: number | null;
  costRatio: number | null;
  wallTimeRatio: number | null;
  verdict: "passed" | "failed" | "inconclusive";
  reasons: string[];
}

export function evaluateBenchmarkOutcome(input: BenchmarkPairInput): BenchmarkOutcome {
  const reasons: string[] = [];
  const { taskArm, batchArm } = input;

  const requestReductionRatio = ratio(
    Math.max(0, taskArm.batchableDescribeJudgeCalls - batchArm.totalRequests),
    taskArm.batchableDescribeJudgeCalls,
  );
  const tokenRatio = ratio(batchArm.totalTokens, taskArm.totalTokens);
  const costRatio = ratio(batchArm.costAmount, taskArm.costAmount);
  const wallTimeRatio = ratio(batchArm.wallTimeMs, taskArm.wallTimeMs);

  let verdict: BenchmarkOutcome["verdict"];

  const blind = input.blindAccounting;
  if (blind === null) {
    reasons.push("盲评会计缺失：inconclusive（不得视为通过，冻结协议 §5.6）");
    verdict = "inconclusive";
  } else if (!blind.processGatesPassed) {
    reasons.push("过程门禁未全通过：直接 failed（冻结协议 §4，统计非劣不得替代）");
    verdict = "failed";
  } else if (blind.pairedSamples < 30) {
    reasons.push(`配对样本 ${blind.pairedSamples} < 30：inconclusive（样本下限≠统计功效证明，冻结协议 §5.3）`);
    verdict = "inconclusive";
  } else {
    // 统计非劣：recallDelta 以 margin 判界（正式区间由 lib/behavior-benchmark 的
    // newcombePairedInterval 在盲评流程产出，此处用点估计做门禁裁决汇总）
    if (blind.recallDelta < NON_INFERIORITY_MARGIN) {
      reasons.push(`召回差 ${blind.recallDelta} 低于冻结非劣界限 ${NON_INFERIORITY_MARGIN}`);
    }
    if (blind.falsePositiveRise > 0.03) {
      reasons.push(`宏误报上升 ${blind.falsePositiveRise} > 0.03`);
    }
    if (blind.evidenceSupportDrop > 0.02) {
      reasons.push(`宏证据支持下降 ${blind.evidenceSupportDrop} > 0.02`);
    }
    if (blind.reviewedInternalMismatches > 0) {
      reasons.push(`reviewed_internal 误判 ${blind.reviewedInternalMismatches} 条`);
    }
    verdict = reasons.length === 0 ? "passed" : "failed";
  }

  // 质量守护记录（不改变 verdict，但必须出现在报告里，防美化）
  if (batchArm.unresolvedCount > taskArm.unresolvedCount) {
    reasons.push(`batch 臂 unresolved 膨胀：${batchArm.unresolvedCount} > ${taskArm.unresolvedCount}`);
  }
  if (batchArm.truncationCount > taskArm.truncationCount) {
    reasons.push(`batch 臂截断增多：${batchArm.truncationCount} > ${taskArm.truncationCount}`);
  }
  if (batchArm.parseFailures > taskArm.parseFailures) {
    reasons.push(`batch 臂解析失败增多：${batchArm.parseFailures} > ${taskArm.parseFailures}`);
  }
  if (batchArm.receiptsUnknown > taskArm.receiptsUnknown) {
    reasons.push(`batch 臂 usage unknown 回执增多：${batchArm.receiptsUnknown} > ${taskArm.receiptsUnknown}`);
  }

  return {
    task: taskArm,
    batch: batchArm,
    requestReductionRatio,
    tokenRatio,
    costRatio,
    wallTimeRatio,
    verdict,
    reasons,
  };
}

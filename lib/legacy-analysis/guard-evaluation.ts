import type { GuardExperimentArm } from "./guard-prompt";

/**
 * 单次运行的离线测量（来自独立人工评审与真实 usage 回执，不由锚点文本自动判定）。
 * CB-18 命中与非锚点命中均为评审结论；成本字段按同臂 3 次合计比较。
 */
export type GuardRunMeasurement = {
  arm: GuardExperimentArm;
  repetition: 1 | 2 | 3;
  cb18Hit: boolean;
  nonAnchorHits: number;
  overallHits: number;
  falsePositives: number;
  falseDeltas: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  actualCost: number;
  pricingVersion: string;
  cacheCondition: string;
  independentlyReviewed: boolean;
  evidenceAllowSetUnchanged: boolean;
  manualProtected: boolean;
};

export type GuardExperimentVerdict = {
  status: "passed" | "failed" | "inconclusive";
  reasons: string[];
};

const ARMS: readonly GuardExperimentArm[] = ["A", "B", "C", "D"];
const EPSILON = 1e-9;

type ArmAggregate = {
  cb18Hits: number;
  nonAnchorHits: number;
  overallHits: number;
  falsePositives: number;
  falseDeltas: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  actualCost: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function aggregate(runs: GuardRunMeasurement[]): ArmAggregate {
  const total: ArmAggregate = {
    cb18Hits: 0,
    nonAnchorHits: 0,
    overallHits: 0,
    falsePositives: 0,
    falseDeltas: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCost: 0,
  };
  for (const run of runs) {
    if (run.cb18Hit) total.cb18Hits += 1;
    total.nonAnchorHits += run.nonAnchorHits;
    total.overallHits += run.overallHits;
    total.falsePositives += run.falsePositives;
    total.falseDeltas += run.falseDeltas;
    total.llmCalls += run.llmCalls;
    total.inputTokens += run.inputTokens;
    total.outputTokens += run.outputTokens;
    total.actualCost += run.actualCost;
  }
  return total;
}

/**
 * 离线质量成本门禁：只消费手工/独立评审测量，不按锚点文本自动判 CB-18。
 * failed 优先于 inconclusive；证据允许集或 manual 保护被破坏恒为 failed；
 * usage 缺失、定价/缓存不可比、未独立评审、重复次数不齐均为 inconclusive。
 */
export function evaluateLegacyGuardExperiment(runs: GuardRunMeasurement[]): GuardExperimentVerdict {
  const failures: string[] = [];
  const inconclusives: string[] = [];

  if (runs.some((run) => run.evidenceAllowSetUnchanged === false)) {
    failures.push("evidence_allow_set_changed");
  }
  if (runs.some((run) => run.manualProtected === false)) {
    failures.push("manual_protection_violated");
  }

  const byArm = new Map<GuardExperimentArm, GuardRunMeasurement[]>();
  for (const arm of ARMS) {
    const group = runs.filter((run) => run.arm === arm);
    const repetitions = new Set(group.map((run) => run.repetition));
    if (group.length !== 3 || repetitions.size !== 3 || ![1, 2, 3].every((rep) => repetitions.has(rep as 1 | 2 | 3))) {
      inconclusives.push(`incomplete_arm_repetitions:${arm}`);
    }
    byArm.set(arm, group);
  }

  if (runs.some((run) =>
    !isFiniteNumber(run.llmCalls)
    || !isFiniteNumber(run.inputTokens)
    || !isFiniteNumber(run.outputTokens)
    || !isFiniteNumber(run.actualCost))) {
    inconclusives.push("usage_missing");
  }
  if (new Set(runs.map((run) => run.pricingVersion)).size !== 1) {
    inconclusives.push("pricing_version_not_comparable");
  }
  if (new Set(runs.map((run) => run.cacheCondition)).size !== 1) {
    inconclusives.push("cache_condition_not_comparable");
  }
  if (runs.some((run) => run.independentlyReviewed === false)) {
    inconclusives.push("not_independently_reviewed");
  }

  const comparable = inconclusives.length === 0;
  if (comparable) {
    const totals = new Map<GuardExperimentArm, ArmAggregate>();
    for (const arm of ARMS) totals.set(arm, aggregate(byArm.get(arm)!));
    const a = totals.get("A")!;
    const b = totals.get("B")!;
    const c = totals.get("C")!;
    const d = totals.get("D")!;

    if (a.cb18Hits === 3) failures.push("a_cb18_saturated_no_improvement_room");
    if (c.cb18Hits <= a.cb18Hits) failures.push("c_no_cb18_improvement");
    if (b.nonAnchorHits < a.nonAnchorHits) failures.push("b_non_anchor_recall_regression");
    if (b.overallHits < a.overallHits) failures.push("b_overall_recall_regression");
    if (d.cb18Hits < c.cb18Hits) failures.push("d_cb18_below_c");
    if (d.cb18Hits <= b.cb18Hits) failures.push("d_cb18_not_above_b");
    if (d.nonAnchorHits < a.nonAnchorHits) failures.push("d_non_anchor_recall_regression");
    if (d.overallHits < a.overallHits) failures.push("d_overall_recall_regression");
    if (d.falsePositives > a.falsePositives) failures.push("d_false_positives_increase");
    if (d.falseDeltas > a.falseDeltas) failures.push("d_false_deltas_increase");
    if (d.llmCalls > a.llmCalls) failures.push("d_llm_calls_increase");
    if (d.inputTokens > a.inputTokens) failures.push("d_input_tokens_increase");
    if (d.outputTokens > a.outputTokens) failures.push("d_output_tokens_increase");
    if (d.actualCost > a.actualCost + EPSILON) failures.push("d_actual_cost_increase");
  }

  if (failures.length > 0) return { status: "failed", reasons: [...failures, ...inconclusives] };
  if (inconclusives.length > 0) return { status: "inconclusive", reasons: inconclusives };
  return { status: "passed", reasons: [] };
}

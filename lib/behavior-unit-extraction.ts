import { AiOutputTruncatedError, requestStructuredCompletion, systemPrompt, type AnalysisResult, type LlmBillingContext } from "./ai";
import type { LlmCallStage } from "./billing/cost-receipt";
import type { EvidenceSanitizeSummary } from "./completeness-ledger";
import { sanitizeEvidence } from "./extraction-pass";
import type { TaskSource } from "./behavior-inventory/planner";
import type { BehaviorAnchorFragment, BehaviorExecutionTask } from "./behavior-inventory/types";
import type { BehaviorTaskOutcome } from "./behavior-unit-receipts";
import {
  describeBehaviorTaskPrompt,
  judgeBehaviorTaskPrompt,
  parseDescribeContent,
  parseJudgeContent,
  taskRegionIds,
  type BehaviorAnchorDisposition,
  type BehaviorInternalKind,
  type BehaviorJudgeOutput,
  type BehaviorRegionConclusion,
} from "./behavior-unit-ai";

/**
 * Task 9 · 单元复述/判定提取编排与状态推导（D4/D5）：
 * 复述 → 判定 → 证据清洗 → 逐 fragment 结论核销 → 任务终态。
 * 「无行为」是受控终态：空 features、缺失结论、无证据内部结论、候选全清洗、截断与
 * 不确定判断一律落在 unresolved，绝不伪装成 no_behavior（D5）。
 * 硬失败（网关/超时/解析）原样抛出，由调用方（Task 13）走重试与 failed 路径；
 * 输出截断（finish_reason=length，同输入确定性复现）映射为 unresolved，不烧重试预算。
 */

/** §5.3 锚点结论回执；Task 9 产出 fragment 级，Task 10 聚合成锚点级。 */
export interface BehaviorAnchorReceipt {
  anchorKey: string;
  evidence: Array<{ path: string; startLine?: number | null }>;
  disposition: BehaviorAnchorDisposition;
  internalKind?: BehaviorInternalKind;
  reason?: string;
  scenarioRefs: string[];
  relatedUnitKeys?: string[];
  relatedScenarioRefs?: string[];
}

export interface BehaviorFragmentReceipt extends BehaviorAnchorReceipt {
  anchorFragmentKey: string;
}

export interface BehaviorTaskExtractionResult {
  outcome: BehaviorTaskOutcome;
  features: AnalysisResult["features"];
  anchorReceipts: BehaviorFragmentReceipt[];
  scenarioCount: number;
  reviewedCount: number;
  unresolvedAnchorCount: number;
  sanitize: EvidenceSanitizeSummary;
}

export type StructuredRequest = (messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext) => Promise<string>;

export interface ExtractBehaviorTaskInput {
  task: BehaviorExecutionTask;
  /** 实际读取的任务源码（allowSet 取自其 path；行号是证据唯一可信来源）。 */
  sources: TaskSource[];
  /** Task 6 计费身份；本模块为两次调用分别盖上 describe/judge 的 callStage。 */
  billing?: LlmBillingContext;
  knownFeatureNames?: string[];
  label?: string;
  /** 测试/宿主注入点；生产保持 requestStructuredCompletion。 */
  requestCompletion?: StructuredRequest;
}

type ScenarioEvidence = AnalysisResult["features"][number]["scenarios"][number]["evidence"];

function withCallStage(billing: LlmBillingContext | undefined, callStage: LlmCallStage): LlmBillingContext | undefined {
  return billing ? { ...billing, callStage } : undefined;
}

function dedupeEvidence(items: ScenarioEvidence): BehaviorAnchorReceipt["evidence"] {
  const seen = new Set<string>();
  const out: BehaviorAnchorReceipt["evidence"] = [];
  for (const item of items) {
    const key = `${item.path}:${item.startLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: item.path, startLine: item.startLine ?? null });
  }
  return out;
}

function unresolvedReceipt(
  fragment: BehaviorAnchorFragment,
  reason: string,
  evidence: BehaviorAnchorReceipt["evidence"] = [],
): BehaviorFragmentReceipt {
  return {
    anchorKey: fragment.anchorKey,
    anchorFragmentKey: fragment.anchorFragmentKey,
    disposition: "unresolved",
    reason,
    evidence,
    scenarioRefs: [],
  };
}

/** 纯函数：单个 fragment 的核销判定。任何结构性缺陷都落在 unresolved，绝不猜测放行。 */
function deriveFragmentReceipt(
  fragment: BehaviorAnchorFragment,
  conclusion: BehaviorRegionConclusion | undefined,
  survivingRefs: ReadonlySet<string>,
  refEvidence: ReadonlyMap<string, ScenarioEvidence>,
  allowSet: ReadonlySet<string>,
): BehaviorFragmentReceipt {
  if (!conclusion) return unresolvedReceipt(fragment, "missing_disposition");
  const evidence = dedupeEvidence(conclusion.evidence.filter((item) => allowSet.has(item.path)));
  if (conclusion.disposition === "unresolved") return unresolvedReceipt(fragment, "model_unresolved", evidence);
  if (conclusion.disposition === "extracted") {
    const refs = [...new Set(conclusion.scenarioRefs)].filter((ref) => survivingRefs.has(ref));
    if (refs.length === 0) return unresolvedReceipt(fragment, "extracted_without_surviving_scenarios", evidence);
    const scenarioEvidence = dedupeEvidence(refs.flatMap((ref) => refEvidence.get(ref) ?? []));
    return {
      anchorKey: fragment.anchorKey,
      anchorFragmentKey: fragment.anchorFragmentKey,
      disposition: "extracted",
      evidence: scenarioEvidence,
      scenarioRefs: refs,
      ...(conclusion.reason ? { reason: conclusion.reason } : {}),
    };
  }
  if (!conclusion.internalKind) return unresolvedReceipt(fragment, "reviewed_internal_without_kind", evidence);
  if (conclusion.scenarioRefs.length > 0) return unresolvedReceipt(fragment, "reviewed_internal_with_scenario_refs", evidence);
  if (evidence.length === 0) return unresolvedReceipt(fragment, "reviewed_internal_without_evidence", evidence);
  if (conclusion.internalKind === "covered_elsewhere" && !(conclusion.relatedUnitKeys?.length || conclusion.relatedScenarioRefs?.length)) {
    return unresolvedReceipt(fragment, "covered_elsewhere_without_relation", evidence);
  }
  return {
    anchorKey: fragment.anchorKey,
    anchorFragmentKey: fragment.anchorFragmentKey,
    disposition: "reviewed_internal",
    internalKind: conclusion.internalKind,
    evidence,
    scenarioRefs: [],
    ...(conclusion.reason ? { reason: conclusion.reason } : {}),
    ...(conclusion.relatedUnitKeys ? { relatedUnitKeys: conclusion.relatedUnitKeys } : {}),
    ...(conclusion.relatedScenarioRefs ? { relatedScenarioRefs: conclusion.relatedScenarioRefs } : {}),
  };
}

/** 纯函数：清洗后的候选 + 逐 fragment 结论 → 任务终态与计数（D5 状态推导的唯一场所）。 */
function deriveTaskResult(
  task: BehaviorExecutionTask,
  sources: TaskSource[],
  judged: BehaviorJudgeOutput,
  label: string,
): BehaviorTaskExtractionResult {
  const allowSet = new Set(sources.map((source) => source.path));
  const primary = sources.find((source) => source.role === "primary") ?? sources[0];
  // product/release 是占位（合并层只取最终摘要，占位不进规格），仅为复用 sanitizeEvidence 的形状
  const candidate: AnalysisResult = {
    product: { description: `behavior task extraction (${task.taskKey})`, evidence: [{ path: primary.path, startLine: primary.startLine }] },
    release: { title: "behavior task extraction", summary: "单元提取占位（合并层只取最终摘要，占位不进规格）。" },
    changes: [],
    features: judged.features,
  };
  const sanitize = sanitizeEvidence(candidate, allowSet, label);
  const refEvidence = new Map<string, ScenarioEvidence>();
  for (const feature of candidate.features) {
    for (const scenario of feature.scenarios) refEvidence.set(scenario.reference, scenario.evidence);
  }
  const survivingRefs = new Set(refEvidence.keys());
  const conclusionsById = new Map(judged.regions.map((region) => [region.id, region]));
  const ids = taskRegionIds(task);
  const anchorReceipts = task.anchorFragments.map((fragment, index) =>
    deriveFragmentReceipt(fragment, conclusionsById.get(ids[index]), survivingRefs, refEvidence, allowSet),
  );
  const unresolvedAnchorCount = anchorReceipts.filter((receipt) => receipt.disposition === "unresolved").length;
  const reviewedCount = anchorReceipts.filter((receipt) => receipt.disposition === "reviewed_internal").length;
  const scenarioCount = candidate.features.reduce((total, feature) => total + feature.scenarios.length, 0);
  let outcome: BehaviorTaskOutcome;
  // 候选全部被清洗（含「有内部结论但场景证据全越界」）不得成为 no_behavior（D5）
  if (unresolvedAnchorCount > 0 || sanitize.allCandidatesRejected) outcome = "unresolved";
  else if (anchorReceipts.some((receipt) => receipt.disposition === "extracted")) outcome = "extracted";
  else outcome = "no_behavior";
  return { outcome, features: candidate.features, anchorReceipts, scenarioCount, reviewedCount, unresolvedAnchorCount, sanitize };
}

function truncatedResult(task: BehaviorExecutionTask): BehaviorTaskExtractionResult {
  const anchorReceipts = task.anchorFragments.map((fragment) => unresolvedReceipt(fragment, "output_truncated"));
  return {
    outcome: "unresolved",
    features: [],
    anchorReceipts,
    scenarioCount: 0,
    reviewedCount: 0,
    unresolvedAnchorCount: anchorReceipts.length,
    sanitize: { droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: true, keptClaims: 0 },
  };
}

/**
 * 执行单个执行任务的双步提取。只读 AI 与传入源码，不写数据库；
 * 结果交给调用方经 Task 8 条件提交。同输入（manifest 固定的任务与源码）产出确定。
 */
export async function extractBehaviorTask(input: ExtractBehaviorTaskInput): Promise<BehaviorTaskExtractionResult> {
  if (!Array.isArray(input.task?.anchorFragments) || input.task.anchorFragments.length === 0) {
    throw new Error("extractBehaviorTask requires a task with at least one anchor fragment");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new Error("extractBehaviorTask requires at least one loaded source");
  }
  const request = input.requestCompletion ?? requestStructuredCompletion;
  const label = input.label ?? input.task.taskKey;
  try {
    const describeContent = await request(
      [
        { role: "system", content: systemPrompt() },
        { role: "user", content: describeBehaviorTaskPrompt(input.task, input.sources) },
      ],
      withCallStage(input.billing, "describe"),
    );
    const descriptions = parseDescribeContent(describeContent, input.task);
    const judgeContent = await request(
      [
        { role: "system", content: systemPrompt() },
        { role: "user", content: judgeBehaviorTaskPrompt({ task: input.task, sources: input.sources, descriptions, knownFeatureNames: input.knownFeatureNames }) },
      ],
      withCallStage(input.billing, "judge"),
    );
    const judged = parseJudgeContent(judgeContent, input.task);
    return deriveTaskResult(input.task, input.sources, judged, label);
  } catch (error) {
    // 输出截断是同输入确定性复现的内容级失败：标记 unresolved（定向复核），不走硬失败重试
    if (AiOutputTruncatedError.isInstance(error)) return truncatedResult(input.task);
    throw error;
  }
}

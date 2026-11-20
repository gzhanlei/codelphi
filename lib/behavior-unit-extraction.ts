import { AiOutputTruncatedError, requestStructuredCompletion, systemPrompt, type AnalysisResult, type LlmBillingContext } from "./ai";
import type { OutputLanguage } from "./analysis-language";
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
  /** 有效单元 key 目录（related-reference）：随 judge prompt 下发，约束 relatedUnitKeys 取值。 */
  knownUnitKeys?: string[];
  /** 输出语言（Task 13 传 run.outputLanguage）；缺省 zh-CN。 */
  outputLanguage?: OutputLanguage;
  label?: string;
  /** 语义复核（I）：携带同一任务上一趟的提取结果，只对其中仍 unresolved 的 fragment
   *  做一次判定步复核（callStage=semantic_repair），已决结论原样保留。 */
  repair?: { previous: BehaviorTaskExtractionResult };
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
  const hasExtracted = anchorReceipts.some((receipt) => receipt.disposition === "extracted");
  const attributedRefs = new Set(anchorReceipts.flatMap((receipt) => receipt.scenarioRefs));
  const unattributedCount = candidate.features.reduce(
    (total, feature) => total + feature.scenarios.filter((scenario) => !attributedRefs.has(scenario.reference)).length,
    0,
  );
  let outcome: BehaviorTaskOutcome;
  // 候选全部被清洗（含「有内部结论但场景证据全越界」）不得成为 no_behavior（D5）
  if (unresolvedAnchorCount > 0 || sanitize.allCandidatesRejected) {
    outcome = "unresolved";
  } else if (unattributedCount > 0) {
    // 存活场景缺少有效 extracted 归属（含全部区域 reviewed_internal 却有场景存活）是核算漏洞：
    // 无锚点来源的事实不得静默进入规格，按 unresolved 定向复核，绝不落入 no_behavior（D5）。
    console.warn("[analysis] surviving scenarios lack extracted attribution; task stays unresolved", { label, unattributedCount, scenarioCount });
    outcome = "unresolved";
  } else if (hasExtracted) {
    outcome = "extracted";
  } else {
    // 到达此处：scenarioCount===0 且全部区域为有效 reviewed_internal——合法 no_behavior
    outcome = "no_behavior";
  }
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
 * 复核趟场景引用重编号（I）：模型在每趟都从 HP-1 起编号，直接合并会与首趟引用撞号
 * （撞号会破坏锚点-场景归属）。按前缀（HP/EC/ER）取最小未占用号重排复核趟引用，
 * 同步改写 receipts 的 scenarioRefs，保持引用-归属一致。
 */
function renumberRepairRefs(
  previous: BehaviorTaskExtractionResult,
  repair: BehaviorTaskExtractionResult,
): BehaviorTaskExtractionResult {
  const used = new Set(previous.features.flatMap((feature) => feature.scenarios.map((scenario) => scenario.reference)));
  const mapping = new Map<string, string>();
  const nextFree = (prefix: string): string => {
    let ordinal = 1;
    while (used.has(`${prefix}-${ordinal}`)) ordinal += 1;
    const ref = `${prefix}-${ordinal}`;
    used.add(ref);
    return ref;
  };
  const features = repair.features.map((feature) => ({
    ...feature,
    scenarios: feature.scenarios.map((scenario) => {
      const match = /^(HP|EC|ER)-\d+$/.exec(scenario.reference);
      if (!match) return scenario;
      if (!used.has(scenario.reference)) {
        used.add(scenario.reference);
        mapping.set(scenario.reference, scenario.reference);
        return scenario;
      }
      const renamed = nextFree(match[1]);
      mapping.set(scenario.reference, renamed);
      return { ...scenario, reference: renamed };
    }),
  }));
  const anchorReceipts = repair.anchorReceipts.map((receipt) => ({
    ...receipt,
    scenarioRefs: receipt.scenarioRefs.map((ref) => mapping.get(ref) ?? ref),
  }));
  return { ...repair, features, anchorReceipts };
}

/** 合并首趟与复核趟：复核趟只替换其覆盖的（原 unresolved）fragment 结论，其余原样保留；
 *  合并后按与 deriveTaskResult 相同的状态规则重新推导终态（D5 不削弱）。 */
function mergeRepairResult(
  previous: BehaviorTaskExtractionResult,
  repair: BehaviorTaskExtractionResult,
  label: string,
): BehaviorTaskExtractionResult {
  const repairByFragment = new Map(repair.anchorReceipts.map((receipt) => [receipt.anchorFragmentKey, receipt]));
  const anchorReceipts = previous.anchorReceipts.map((receipt) => repairByFragment.get(receipt.anchorFragmentKey) ?? receipt);
  const features = [...previous.features, ...repair.features];
  const scenarioCount = features.reduce((total, feature) => total + feature.scenarios.length, 0);
  const unresolvedAnchorCount = anchorReceipts.filter((receipt) => receipt.disposition === "unresolved").length;
  const reviewedCount = anchorReceipts.filter((receipt) => receipt.disposition === "reviewed_internal").length;
  const hasExtracted = anchorReceipts.some((receipt) => receipt.disposition === "extracted");
  const attributedRefs = new Set(anchorReceipts.flatMap((receipt) => receipt.scenarioRefs));
  const unattributedCount = features.reduce(
    (total, feature) => total + feature.scenarios.filter((scenario) => !attributedRefs.has(scenario.reference)).length,
    0,
  );
  const sanitize: EvidenceSanitizeSummary = {
    droppedClaims: previous.sanitize.droppedClaims + repair.sanitize.droppedClaims,
    droppedScenarios: previous.sanitize.droppedScenarios + repair.sanitize.droppedScenarios,
    droppedFeatures: previous.sanitize.droppedFeatures + repair.sanitize.droppedFeatures,
    keptClaims: previous.sanitize.keptClaims + repair.sanitize.keptClaims,
    allCandidatesRejected:
      scenarioCount === 0 && (previous.sanitize.allCandidatesRejected || repair.sanitize.allCandidatesRejected),
    empty: previous.sanitize.empty && repair.sanitize.empty,
  };
  let outcome: BehaviorTaskOutcome;
  if (unresolvedAnchorCount > 0 || sanitize.allCandidatesRejected) {
    outcome = "unresolved";
  } else if (unattributedCount > 0) {
    console.warn("[analysis] surviving scenarios lack extracted attribution after repair; task stays unresolved", {
      label,
      unattributedCount,
      scenarioCount,
    });
    outcome = "unresolved";
  } else if (hasExtracted) {
    outcome = "extracted";
  } else {
    outcome = "no_behavior";
  }
  return { outcome, features, anchorReceipts, scenarioCount, reviewedCount, unresolvedAnchorCount, sanitize };
}

/**
 * 语义复核（I）：只对上一趟仍 unresolved 的 fragment 做一次判定步调用（无复述步——
 * 判定 prompt 已有「无复述直接核对源码」分支），callStage=semantic_repair。
 * 全部已决时原样返回上一趟结果，不发任何 AI 调用；复核趟截断时未决 fragment 保持未决。
 */
async function repairBehaviorTask(input: ExtractBehaviorTaskInput): Promise<BehaviorTaskExtractionResult> {
  const previous = input.repair!.previous;
  const unresolvedKeys = new Set(
    previous.anchorReceipts.filter((receipt) => receipt.disposition === "unresolved").map((receipt) => receipt.anchorFragmentKey),
  );
  if (unresolvedKeys.size === 0) return previous;
  const reducedTask: BehaviorExecutionTask = {
    ...input.task,
    anchorFragments: input.task.anchorFragments.filter((fragment) => unresolvedKeys.has(fragment.anchorFragmentKey)),
  };
  if (reducedTask.anchorFragments.length === 0) return previous;
  const request = input.requestCompletion ?? requestStructuredCompletion;
  const label = input.label ?? input.task.taskKey;
  const language: OutputLanguage = input.outputLanguage ?? "zh-CN";
  try {
    const judgeContent = await request(
      [
        { role: "system", content: systemPrompt(language) },
        {
          role: "user",
          content: judgeBehaviorTaskPrompt({
            task: reducedTask,
            sources: input.sources,
            descriptions: [],
            knownFeatureNames: input.knownFeatureNames,
            knownUnitKeys: input.knownUnitKeys,
            language,
          }),
        },
      ],
      withCallStage(input.billing, "semantic_repair"),
    );
    const judged = parseJudgeContent(judgeContent, reducedTask);
    const repaired = deriveTaskResult(reducedTask, input.sources, judged, label);
    return mergeRepairResult(previous, renumberRepairRefs(previous, repaired), label);
  } catch (error) {
    if (AiOutputTruncatedError.isInstance(error)) return mergeRepairResult(previous, truncatedResult(reducedTask), label);
    throw error;
  }
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
  if (input.repair) return repairBehaviorTask(input);
  const request = input.requestCompletion ?? requestStructuredCompletion;
  const label = input.label ?? input.task.taskKey;
  const language: OutputLanguage = input.outputLanguage ?? "zh-CN";
  try {
    const describeContent = await request(
      [
        { role: "system", content: systemPrompt(language) },
        { role: "user", content: describeBehaviorTaskPrompt(input.task, input.sources, language) },
      ],
      withCallStage(input.billing, "describe"),
    );
    const descriptions = parseDescribeContent(describeContent, input.task);
    const judgeContent = await request(
      [
        { role: "system", content: systemPrompt(language) },
        { role: "user", content: judgeBehaviorTaskPrompt({ task: input.task, sources: input.sources, descriptions, knownFeatureNames: input.knownFeatureNames, knownUnitKeys: input.knownUnitKeys, language }) },
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

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

/**
 * D5 终态规则的唯一推导场所：任何合并形态（首趟 / 复核趟 / 空白区域合成）都以同一
 * 规则重新推导任务终态，绝不削弱。候选全部被清洗（含「有内部结论但场景证据全越界」）
 * 与存活场景缺 extracted 归属都不得成为 no_behavior。
 */
function deriveTaskOutcome(
  anchorReceipts: BehaviorFragmentReceipt[],
  features: AnalysisResult["features"],
  sanitize: EvidenceSanitizeSummary,
  label: string,
  stage: string,
): BehaviorTaskOutcome {
  const unresolvedAnchorCount = anchorReceipts.filter((receipt) => receipt.disposition === "unresolved").length;
  const hasExtracted = anchorReceipts.some((receipt) => receipt.disposition === "extracted");
  const attributedRefs = new Set(anchorReceipts.flatMap((receipt) => receipt.scenarioRefs));
  const scenarioCount = features.reduce((total, feature) => total + feature.scenarios.length, 0);
  const unattributedCount = features.reduce(
    (total, feature) => total + feature.scenarios.filter((scenario) => !attributedRefs.has(scenario.reference)).length,
    0,
  );
  if (unresolvedAnchorCount > 0 || sanitize.allCandidatesRejected) return "unresolved";
  if (unattributedCount > 0) {
    // 存活场景缺少有效 extracted 归属（含全部区域 reviewed_internal 却有场景存活）是核算漏洞：
    // 无锚点来源的事实不得静默进入规格，按 unresolved 定向复核，绝不落入 no_behavior（D5）。
    console.warn("[analysis] surviving scenarios lack extracted attribution; task stays unresolved", { label, stage, unattributedCount, scenarioCount });
    return "unresolved";
  }
  if (hasExtracted) return "extracted";
  // 到达此处：scenarioCount===0 且全部区域为有效 reviewed_internal——合法 no_behavior
  return "no_behavior";
}

function countByDisposition(anchorReceipts: BehaviorFragmentReceipt[], disposition: BehaviorFragmentReceipt["disposition"]): number {
  return anchorReceipts.filter((receipt) => receipt.disposition === disposition).length;
}

/** 纯函数：清洗后的候选 + 逐 fragment 结论 → 任务终态与计数（复用 D5 唯一推导场所）。 */
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
  const scenarioCount = candidate.features.reduce((total, feature) => total + feature.scenarios.length, 0);
  const outcome = deriveTaskOutcome(anchorReceipts, candidate.features, sanitize, label, "first pass");
  return {
    outcome,
    features: candidate.features,
    anchorReceipts,
    scenarioCount,
    reviewedCount: countByDisposition(anchorReceipts, "reviewed_internal"),
    unresolvedAnchorCount: countByDisposition(anchorReceipts, "unresolved"),
    sanitize,
  };
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
 * 空白区域确定性分类（H 修正）：fragment 区间内实际读取的每一行都是纯空白时，该区域
 * 无代码可审，直接合成 no_code_content 内部结论——零 AI 调用、证据引用区域自身行号、
 * 与同 revision 源码内容确定性一致。绝不把「AI 空结果」伪装成该结论（D5 边界不变）：
 * 只有源码内容事实（而非模型回答缺失）才触发本路径。
 */
/** 导出供 execution batch 编排层复用（Task 3 最小导出，判定逻辑不变）。 */
export function primaryLineIndexOf(sources: TaskSource[]): Map<string, Map<number, string>> {
  const index = new Map<string, Map<number, string>>();
  for (const source of sources) {
    if (source.role !== "primary") continue;
    const lines = index.get(source.path) ?? new Map<number, string>();
    source.content.split("\n").forEach((line, offset) => lines.set(source.startLine + offset, line));
    index.set(source.path, lines);
  }
  return index;
}

/** 导出供 execution batch 编排层复用（Task 3 最小导出，判定逻辑不变）。 */
export function fragmentIsBlank(fragment: BehaviorAnchorFragment, index: ReadonlyMap<string, ReadonlyMap<number, string>>): boolean {
  let inspected = 0;
  for (const range of fragment.ranges) {
    for (const lines of index.values()) {
      for (let line = range.startLine; line <= range.endLine; line += 1) {
        const text = lines.get(line);
        if (text == null) continue;
        inspected += 1;
        if (text.trim() !== "") return false;
      }
    }
  }
  // 没有任何实际读取到的行支撑空白判定时不得放行（fail closed，交回模型/硬失败路径）
  return inspected > 0;
}

function blankRegionReceipt(fragment: BehaviorAnchorFragment, primaryPath: string): BehaviorFragmentReceipt {
  return {
    anchorKey: fragment.anchorKey,
    anchorFragmentKey: fragment.anchorFragmentKey,
    disposition: "reviewed_internal",
    internalKind: "no_code_content",
    reason: "blank_lines_only",
    evidence: [{ path: primaryPath, startLine: fragment.ranges[0]?.startLine ?? null }],
    scenarioRefs: [],
  };
}

function blankRegionsResult(task: BehaviorExecutionTask, sources: TaskSource[]): BehaviorTaskExtractionResult {
  const primary = sources.find((source) => source.role === "primary") ?? sources[0];
  const anchorReceipts = task.anchorFragments.map((fragment) => blankRegionReceipt(fragment, primary.path));
  return {
    outcome: "no_behavior",
    features: [],
    anchorReceipts,
    scenarioCount: 0,
    reviewedCount: anchorReceipts.length,
    unresolvedAnchorCount: 0,
    sanitize: { droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: true, keptClaims: 0 },
  };
}

/** 空白合成回执并入内容趟结果后，按 D5 唯一规则重新推导任务终态（绝不削弱）。 */
function mergeBlankReceipts(
  content: BehaviorTaskExtractionResult,
  blanks: BehaviorFragmentReceipt[],
  label: string,
): BehaviorTaskExtractionResult {
  const anchorReceipts = [...content.anchorReceipts, ...blanks];
  const outcome = deriveTaskOutcome(anchorReceipts, content.features, content.sanitize, label, "blank-region merge");
  return {
    outcome,
    features: content.features,
    anchorReceipts,
    scenarioCount: content.scenarioCount,
    reviewedCount: countByDisposition(anchorReceipts, "reviewed_internal"),
    unresolvedAnchorCount: countByDisposition(anchorReceipts, "unresolved"),
    sanitize: content.sanitize,
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
  const unresolvedAnchorCount = countByDisposition(anchorReceipts, "unresolved");
  const reviewedCount = countByDisposition(anchorReceipts, "reviewed_internal");
  const sanitize: EvidenceSanitizeSummary = {
    droppedClaims: previous.sanitize.droppedClaims + repair.sanitize.droppedClaims,
    droppedScenarios: previous.sanitize.droppedScenarios + repair.sanitize.droppedScenarios,
    droppedFeatures: previous.sanitize.droppedFeatures + repair.sanitize.droppedFeatures,
    keptClaims: previous.sanitize.keptClaims + repair.sanitize.keptClaims,
    allCandidatesRejected:
      scenarioCount === 0 && (previous.sanitize.allCandidatesRejected || repair.sanitize.allCandidatesRejected),
    empty: previous.sanitize.empty && repair.sanitize.empty,
  };
  const outcome = deriveTaskOutcome(anchorReceipts, features, sanitize, label, "semantic repair");
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

/** 双步模型提取（复述 + 判定）；task/sources 由调用方给定（全量或缩减任务），截断映射 unresolved。 */
async function modelTaskExtraction(
  task: BehaviorExecutionTask,
  sources: TaskSource[],
  request: StructuredRequest,
  billing: LlmBillingContext | undefined,
  knownFeatureNames: string[] | undefined,
  knownUnitKeys: string[] | undefined,
  language: OutputLanguage,
  label: string,
): Promise<BehaviorTaskExtractionResult> {
  try {
    const describeContent = await request(
      [
        { role: "system", content: systemPrompt(language) },
        { role: "user", content: describeBehaviorTaskPrompt(task, sources, language) },
      ],
      withCallStage(billing, "describe"),
    );
    const descriptions = parseDescribeContent(describeContent, task);
    const judgeContent = await request(
      [
        { role: "system", content: systemPrompt(language) },
        { role: "user", content: judgeBehaviorTaskPrompt({ task, sources, descriptions, knownFeatureNames, knownUnitKeys, language }) },
      ],
      withCallStage(billing, "judge"),
    );
    const judged = parseJudgeContent(judgeContent, task);
    return deriveTaskResult(task, sources, judged, label);
  } catch (error) {
    // 输出截断是同输入确定性复现的内容级失败：标记 unresolved（定向复核），不走硬失败重试
    if (AiOutputTruncatedError.isInstance(error)) return truncatedResult(task);
    throw error;
  }
}

/**
 * 执行单个执行任务的双步提取。只读 AI 与传入源码，不写数据库；
 * 结果交给调用方经 Task 8 条件提交。同输入（manifest 固定的任务与源码）产出确定。
 *
 * 空白区域确定性分类（H 修正）：纯空行 fragment 不进模型（零 AI 调用）——全空任务直接
 * 合成 no_behavior；混合任务先裁出纯空 fragment 走缩减任务提取，再并回合成回执按 D5
 * 规则重推终态。含任一非空白行的区域不受影响，仍走完整模型判定。
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
  const lineIndex = primaryLineIndexOf(input.sources);
  const blankFragments = input.task.anchorFragments.filter((fragment) => fragmentIsBlank(fragment, lineIndex));
  if (blankFragments.length === input.task.anchorFragments.length) {
    return blankRegionsResult(input.task, input.sources);
  }
  if (blankFragments.length > 0) {
    const blankKeys = new Set(blankFragments.map((fragment) => fragment.anchorFragmentKey));
    const reducedTask: BehaviorExecutionTask = {
      ...input.task,
      anchorFragments: input.task.anchorFragments.filter((fragment) => !blankKeys.has(fragment.anchorFragmentKey)),
    };
    const reducedSources = input.sources.filter((source) => !source.content.split("\n").every((line) => line.trim() === ""));
    const primary = reducedSources.find((source) => source.role === "primary") ?? reducedSources[0];
    const contentResult = await modelTaskExtraction(
      reducedTask,
      reducedSources,
      request,
      input.billing,
      input.knownFeatureNames,
      input.knownUnitKeys,
      language,
      label,
    );
    return mergeBlankReceipts(contentResult, blankFragments.map((fragment) => blankRegionReceipt(fragment, primary.path)), label);
  }
  return modelTaskExtraction(input.task, input.sources, request, input.billing, input.knownFeatureNames, input.knownUnitKeys, language, label);
}

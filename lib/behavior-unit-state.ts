import type { AnalysisResult } from "./ai";
import { compareCodePoints } from "./behavior-inventory/identity";
import type { BehaviorAnchorFragment, BehaviorExecutionTask, BehaviorUnit } from "./behavior-inventory/types";
import type { BehaviorFragmentReceipt, BehaviorTaskExtractionResult } from "./behavior-unit-extraction";
import type { BehaviorTaskOutcome } from "./behavior-unit-receipts";
import { normalizeSpecText, scenarioBehaviorEqual } from "./spec-diff";
import type { Evidence } from "./types";

/**
 * Task 10 · 分片聚合与局部场景身份（设计 §5.3，D5）：
 *
 * - assignLocalScenarioKeys：汇总同一锚点全部已终态分片引用的存活场景（输入即 Task 9
 *   已清洗并提交的持久化结果），行为等价去重后按 证据(path/startLine)→category→规范化
 *   context/action/outcome 稳定排序，分配补零序号。localScenarioKey = unitKey + anchorKey
 *   + deterministicOrdinal——AI 的 feature 名与 HP/EC/ER 引用只是内容字段，绝不进入身份；
 *   不引入语义哈希，只承诺同一持久化结果内稳定。重试整体替换：本函数对当前持久化结果
 *   全量重算整个局部集合，绝不向旧集合追加新 ordinal（Task 8 条件提交已整体覆盖
 *   result_json，本层只需纯函数式重算）。
 * - aggregateBehaviorUnitStatus：单元状态的唯一决策场所（D5）。分片锚点在全部分片
 *   终态前不得完成；任何 worker 都不得凭单个任务核销整个锚点。unresolved 永不计入完成。
 * - buildAnchorScenarioLinks：锚点 ↔ 局部场景关联行（analysis_behavior_anchor_scenarios
 *   的纯函数形态；final_scenario_id 由 Task 12 回填）。多锚点可关联同一局部场景；
 *   reviewed_internal 没有 scenarioRefs、unresolved 不产生关联。
 *
 * 全部为纯函数：不读数据库、不调 AI、不依赖输入数组顺序。
 */

/** 执行任务在单元聚合视角下的当前持久化状态（Task 8 提交口径）。 */
export type BehaviorUnitTaskStatus = "pending" | "running" | "failed" | BehaviorTaskOutcome;

/** manifest 任务（分片清单的权威来源）+ 当前持久化状态与已提交结果。 */
export interface UnitTaskState {
  task: BehaviorExecutionTask;
  status: BehaviorUnitTaskStatus;
  /** 已提交的终态结果（result_json）；非终态任务为 null。 */
  result: Pick<BehaviorTaskExtractionResult, "outcome" | "features" | "anchorReceipts"> | null;
}

export interface LocalScenarioInput {
  unit: BehaviorUnit;
  /** 单元的全部执行任务（manifest 全集 + 当前状态）；调用方负责把缺行任务补为 pending。 */
  tasks: UnitTaskState[];
}

type Feature = AnalysisResult["features"][number];
type Scenario = Feature["scenarios"][number];

export interface LocalScenarioKeyAssignment {
  localScenarioKey: string;
  unitKey: string;
  /** 归属锚点：ordinal 在该锚点的局部集合内分配。 */
  anchorKey: string;
  /** 1-based；key 内为补零三位序号。 */
  ordinal: number;
  /** 存活场景记录的定位（内容，不承担身份）。 */
  taskKey: string;
  featureName: string;
  /** HP-n/EC-n/ER-n：内容字段，不承担身份。 */
  reference: string;
  /** 存活的场景内容（来自其所属任务的持久化结果，未经改写）。 */
  scenario: Scenario;
  /** 支撑本局部场景的全部锚点（含归属锚点，码点序）；多锚点共享同一局部场景。 */
  linkedAnchorKeys: string[];
}

export interface UnitAggregationInput {
  unit: BehaviorUnit;
  tasks: UnitTaskState[];
}

/** 单元状态（D5）；extracted/no_behavior 是成功终态，unresolved 永不计入完成。 */
export type BehaviorUnitStatus = "pending" | "running" | "failed" | "unresolved" | "extracted" | "no_behavior";

export interface AnchorLinkInput {
  runId: number;
  unitKey: string;
  assignments: LocalScenarioKeyAssignment[];
}

export interface AnchorScenarioLink {
  runId: number;
  unitKey: string;
  anchorKey: string;
  localScenarioKey: string;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<BehaviorTaskOutcome>(["extracted", "no_behavior", "unresolved"]);

function isTerminalTask(state: UnitTaskState): boolean {
  return TERMINAL_STATUSES.has(state.status) && state.result != null;
}

/** localScenarioKey = unitKey + anchorKey + 补零序号；格式是不透明实现细节，身份就是三元组本身。 */
function formatLocalScenarioKey(unitKey: string, anchorKey: string, ordinal: number): string {
  return `scenario|${JSON.stringify([unitKey, anchorKey, String(ordinal).padStart(3, "0")])}`;
}

/** 锚点的可归因锚点集合（entry 只用于定位，不计入完成分子），按 anchorKey 码点序。 */
function accountableAnchorKeys(unit: BehaviorUnit): string[] {
  return unit.anchors
    .filter((anchor) => anchor.role !== "entry")
    .map((anchor) => anchor.anchorKey)
    .sort(compareCodePoints);
}

interface FragmentResolution {
  fragment: BehaviorAnchorFragment;
  state: UnitTaskState;
  receipt: BehaviorFragmentReceipt | null;
}

/** 汇总同一锚点跨任务的全部分片及其当前回执（锚点级聚合的唯一场所）。 */
function resolveAnchorFragments(anchorKey: string, tasks: UnitTaskState[]): FragmentResolution[] {
  const resolutions: FragmentResolution[] = [];
  for (const state of tasks) {
    for (const fragment of state.task.anchorFragments) {
      if (fragment.anchorKey !== anchorKey) continue;
      const receipt = state.result?.anchorReceipts.find((candidate) => candidate.anchorFragmentKey === fragment.anchorFragmentKey) ?? null;
      resolutions.push({ fragment, state, receipt });
    }
  }
  return resolutions;
}

/** 锚点完成 = 每个期望分片都有终态回执；缺任务结果或缺回执一律视为未完成（绝不静默放行）。 */
function anchorComplete(resolutions: FragmentResolution[]): boolean {
  return resolutions.length > 0 && resolutions.every((resolution) => isTerminalTask(resolution.state) && resolution.receipt != null);
}

interface ScenarioCandidate {
  taskKey: string;
  anchorFragmentKey: string;
  featureName: string;
  reference: string;
  scenario: Scenario;
}

/** 汇总已完成锚点全部分片中 extracted 回执引用的存活场景；引用回其所属任务的持久化结果解析。 */
function collectAnchorCandidates(resolutions: FragmentResolution[]): ScenarioCandidate[] {
  const candidates: ScenarioCandidate[] = [];
  for (const { fragment, state, receipt } of resolutions) {
    if (receipt == null || receipt.disposition !== "extracted" || state.result == null) continue;
    const refIndex = new Map<string, { featureName: string; scenario: Scenario }>();
    for (const feature of state.result.features) {
      for (const scenario of feature.scenarios) refIndex.set(scenario.reference, { featureName: feature.name, scenario });
    }
    for (const reference of new Set(receipt.scenarioRefs)) {
      const resolved = refIndex.get(reference);
      if (!resolved) {
        // extracted 回执的引用必命中存活场景（Task 9 契约）；落空即持久化内容异常，跳过并留痕
        console.warn("[behavior-unit-state] extracted receipt references a scenario missing from the persisted result; skipped", {
          anchorKey: receipt.anchorKey,
          anchorFragmentKey: fragment.anchorFragmentKey,
          reference,
        });
        continue;
      }
      candidates.push({ taskKey: state.task.taskKey, anchorFragmentKey: fragment.anchorFragmentKey, featureName: resolved.featureName, reference, scenario: resolved.scenario });
    }
  }
  return candidates;
}

/** 缺省行号按 0 处理（先于任何真实行号），保证与输入顺序无关的全序。 */
function compareEvidenceItems(a: Evidence, b: Evidence): number {
  return compareCodePoints(a.path, b.path) || (a.startLine ?? 0) - (b.startLine ?? 0) || (a.endLine ?? 0) - (b.endLine ?? 0);
}

function compareEvidenceLists(left: Evidence[], right: Evidence[]): number {
  const a = [...left].sort(compareEvidenceItems);
  const b = [...right].sort(compareEvidenceItems);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const compared = compareEvidenceItems(a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

/**
 * §5.3 排序键：证据(path/startLine) → category → 规范化 context/action/outcome。
 * 规范化只用于比较（NFKC + 空白折叠），不改写落库文本。尾部兜底键（原文/定位）仅在
 * 全部判定键打平时生效——那种对必然行为等价、已被去重吞掉；兜底只为全序确定性兜底。
 */
function compareCandidates(a: ScenarioCandidate, b: ScenarioCandidate): number {
  return (
    compareEvidenceLists(a.scenario.evidence, b.scenario.evidence) ||
    compareCodePoints(a.scenario.category, b.scenario.category) ||
    compareCodePoints(normalizeSpecText(a.scenario.context), normalizeSpecText(b.scenario.context)) ||
    compareCodePoints(normalizeSpecText(a.scenario.action), normalizeSpecText(b.scenario.action)) ||
    compareCodePoints(normalizeSpecText(a.scenario.outcome), normalizeSpecText(b.scenario.outcome)) ||
    compareCodePoints(a.scenario.context, b.scenario.context) ||
    compareCodePoints(a.scenario.action, b.scenario.action) ||
    compareCodePoints(a.scenario.outcome, b.scenario.outcome) ||
    compareCodePoints(a.featureName, b.featureName) ||
    compareCodePoints(a.reference, b.reference) ||
    compareCodePoints(a.taskKey, b.taskKey) ||
    compareCodePoints(a.anchorFragmentKey, b.anchorFragmentKey)
  );
}

/**
 * 分配单元的局部场景身份。只对「全部分片已终态」的锚点分配：分片未完成时没有任何
 * worker 能凭局部结果核销锚点。锚点内先排序后按行为等价（BM-5 严通道，不做跨调用
 * 语义哈希）去重再编号；跨锚点的同行为共享先分配锚点的局部场景（多锚点支撑同一场景）。
 */
export function assignLocalScenarioKeys(input: LocalScenarioInput): LocalScenarioKeyAssignment[] {
  const assignments: LocalScenarioKeyAssignment[] = [];
  for (const anchorKey of accountableAnchorKeys(input.unit)) {
    const resolutions = resolveAnchorFragments(anchorKey, input.tasks);
    if (!anchorComplete(resolutions)) continue;
    const kept: ScenarioCandidate[] = [];
    for (const candidate of collectAnchorCandidates(resolutions).sort(compareCandidates)) {
      if (kept.some((existing) => scenarioBehaviorEqual(existing.scenario, candidate.scenario))) continue;
      kept.push(candidate);
    }
    let ordinal = 0;
    for (const candidate of kept) {
      const shared = assignments.find((assignment) => scenarioBehaviorEqual(assignment.scenario, candidate.scenario));
      if (shared) {
        if (!shared.linkedAnchorKeys.includes(anchorKey)) {
          shared.linkedAnchorKeys.push(anchorKey);
          shared.linkedAnchorKeys.sort(compareCodePoints);
        }
        continue;
      }
      ordinal += 1;
      assignments.push({
        localScenarioKey: formatLocalScenarioKey(input.unit.unitKey, anchorKey, ordinal),
        unitKey: input.unit.unitKey,
        anchorKey,
        ordinal,
        taskKey: candidate.taskKey,
        featureName: candidate.featureName,
        reference: candidate.reference,
        scenario: candidate.scenario,
        linkedAnchorKeys: [anchorKey],
      });
    }
  }
  return assignments;
}

/**
 * 单元状态的唯一决策场所（D5）。优先级：running > failed > pending（任务级硬事实），
 * 然后逐可归因锚点聚合分片回执：锚点未完成（分片未全部终态/缺回执）或任一 fragment
 * unresolved、任一任务终态 unresolved（候选全清洗/存活场景无归属/输出截断）→ unresolved；
 * 全部锚点终态且至少一个 extracted → extracted；全部带证据内部实现且无保留场景 → no_behavior。
 */
export function aggregateBehaviorUnitStatus(input: UnitAggregationInput): BehaviorUnitStatus {
  if (input.tasks.length === 0) {
    // planner 契约：无法安全拆到预算内的单元不生成任务 → unresolved，绝不截断伪装成功
    return "unresolved";
  }
  if (input.tasks.some((state) => state.status === "running")) return "running";
  if (input.tasks.some((state) => state.status === "failed")) return "failed";
  if (input.tasks.some((state) => state.status === "pending")) return "pending";

  let hasExtracted = false;
  for (const anchorKey of accountableAnchorKeys(input.unit)) {
    const resolutions = resolveAnchorFragments(anchorKey, input.tasks);
    if (!anchorComplete(resolutions)) return "unresolved";
    const receipts = resolutions.map((resolution) => resolution.receipt as BehaviorFragmentReceipt);
    if (receipts.some((receipt) => receipt.disposition === "unresolved")) return "unresolved";
    if (receipts.some((receipt) => receipt.disposition === "extracted")) hasExtracted = true;
  }
  // 任务终态覆盖回执之外的未决形态（含「回执全 extracted 但存活场景无归属」）；
  // 终态却缺 result_json 是持久化异常，同样按 unresolved 处理，绝不放行。
  for (const state of input.tasks) {
    if (state.result == null || state.result.outcome === "unresolved") return "unresolved";
  }
  if (hasExtracted) return "extracted";
  return "no_behavior";
}

/**
 * 锚点 ↔ 局部场景关联行：展开 assignment 的 linkedAnchorKeys，按 (anchorKey,
 * localScenarioKey) 码点序返回去重行。final_scenario_id 由 Task 12 在最终事务回填。
 */
export function buildAnchorScenarioLinks(input: AnchorLinkInput): AnchorScenarioLink[] {
  const rows = new Map<string, AnchorScenarioLink>();
  for (const assignment of input.assignments) {
    for (const anchorKey of assignment.linkedAnchorKeys) {
      const id = `${anchorKey}${assignment.localScenarioKey}`;
      if (!rows.has(id)) {
        rows.set(id, { runId: input.runId, unitKey: input.unitKey, anchorKey, localScenarioKey: assignment.localScenarioKey });
      }
    }
  }
  return [...rows.values()].sort((a, b) => compareCodePoints(a.anchorKey, b.anchorKey) || compareCodePoints(a.localScenarioKey, b.localScenarioKey));
}

import type { AnalysisCoverageReceipt } from "./analysis-coverage";
import type { BehavioralEnumerationMetrics } from "./behavioral-enumeration";

/**
 * R1 · 分析完整性账本（Analysis Completeness Ledger）：run 级汇总「一次成功的分析
 * 到底完成了什么、没完成什么」。六维度各自 complete / partial / failed /
 * not_applicable，整体状态由确定性规则推导——**禁止合并成单一百分比**：
 * 分析成功 ≠ 分析完整 ≠ 分析正确，三者必须分开。
 *
 * 维度与数据来源：
 *   sourceCoverage         覆盖率回执（W0-7 diff 计数含）
 *   behavioralEnumeration  W0-8 枚举指标
 *   extractionCompletion   分区趟完成/重试/空结果
 *   evidenceIntegrity      sanitize 剔除计数与 all_candidates_rejected
 *   mergeIntegrity         changes 截断 / 去重 / 一致性冲突 / 坍缩
 *   verification           一致性冲突 + M9 影子（人工核实为外部生命周期，另行追踪）
 */

export type LedgerState = "complete" | "partial" | "failed" | "not_applicable";

export interface SourceCoverageDimension {
  state: LedgerState;
  implFilesAssembled: number;
  implFilesTotal: number;
  coverageRatio: number;
  partitionsCapped: boolean;
  diffTotalPaths: number | null;
  diffSelectedPaths: number | null;
  diffOmittedPaths: number | null;
}

export interface BehavioralEnumerationDimension extends BehavioralEnumerationMetrics {
  state: LedgerState;
}

export interface ExtractionCompletionDimension {
  state: LedgerState;
  partitions: number;
  passes: number;
  retries: number;
  emptyPasses: number;
}

export interface EvidenceIntegrityDimension {
  state: LedgerState;
  droppedClaims: number;
  droppedScenarios: number;
  droppedFeatures: number;
  allCandidatesRejectedPasses: number;
}

export interface MergeIntegrityDimension {
  state: LedgerState;
  changesTruncated: number;
  scenariosDeduped: number;
  outcomeConflicts: number;
  collapse: boolean;
}

export interface VerificationDimension {
  state: LedgerState;
  outcomeConflicts: number;
  /** M9 影子是否执行（增量 run 才执行）。 */
  shadowRan: boolean;
  shadowConsistent: boolean | null;
  /** 人工核实在外部核实生命周期追踪，不在 run 级账本内。 */
  humanVerification: "external";
}

export interface AnalysisCompletenessLedger {
  runId: number;
  specVersionId: number;
  sourceCoverage: SourceCoverageDimension;
  behavioralEnumeration: BehavioralEnumerationDimension;
  extractionCompletion: ExtractionCompletionDimension;
  evidenceIntegrity: EvidenceIntegrityDimension;
  mergeIntegrity: MergeIntegrityDimension;
  verification: VerificationDimension;
  overall: LedgerState;
}

const ORDER: Record<LedgerState, number> = { complete: 0, not_applicable: 1, partial: 2, failed: 3 };

/** 整体状态 = 各维度中最差的（failed > partial > not_applicable > complete），不合并不平均。 */
export function deriveOverallState(states: LedgerState[]): LedgerState {
  return states.reduce((worst, state) => (ORDER[state] > ORDER[worst] ? state : worst), "complete");
}

export function deriveSourceCoverage(receipt: AnalysisCoverageReceipt): SourceCoverageDimension {
  const omitted = receipt.diffOmittedPaths ?? 0;
  let state: LedgerState;
  if (receipt.implFilesAssembled === 0) state = "failed";
  else if (receipt.partitionsCapped || omitted > 0) state = "partial";
  else state = "complete";
  return {
    state,
    implFilesAssembled: receipt.implFilesAssembled,
    implFilesTotal: receipt.implFilesTotal,
    coverageRatio: receipt.coverageRatio,
    partitionsCapped: receipt.partitionsCapped,
    diffTotalPaths: receipt.diffTotalPaths,
    diffSelectedPaths: receipt.diffSelectedPaths,
    diffOmittedPaths: receipt.diffOmittedPaths,
  };
}

export function deriveBehavioralEnumeration(metrics: BehavioralEnumerationMetrics): BehavioralEnumerationDimension {
  return { ...metrics, state: metrics.status };
}

export interface ExtractionPassInfo {
  retries: number;
  /** 清洗后无任何场景（无行为变化窗口）。 */
  emptyAfterSanitize: boolean;
  /** 候选存在但全部被清洗（独立告警事件）。 */
  allCandidatesRejected: boolean;
}

export function deriveExtractionCompletion(partitions: number, passes: ExtractionPassInfo[]): ExtractionCompletionDimension {
  const retries = passes.reduce((total, pass) => total + pass.retries, 0);
  const emptyPasses = passes.filter((pass) => pass.emptyAfterSanitize).length;
  let state: LedgerState = "complete";
  if (retries > 0 || emptyPasses > 0) state = "partial";
  return { state, partitions, passes: passes.length, retries, emptyPasses };
}

export interface EvidenceSanitizeSummary {
  droppedClaims: number;
  droppedScenarios: number;
  droppedFeatures: number;
  allCandidatesRejected: boolean;
  /** 本趟完全没有产出（无行为变化窗口或全被清洗）。 */
  empty: boolean;
  keptClaims: number;
}

export function deriveEvidenceIntegrity(summaries: EvidenceSanitizeSummary[]): EvidenceIntegrityDimension {
  const droppedClaims = summaries.reduce((total, s) => total + s.droppedClaims, 0);
  const droppedScenarios = summaries.reduce((total, s) => total + s.droppedScenarios, 0);
  const droppedFeatures = summaries.reduce((total, s) => total + s.droppedFeatures, 0);
  const allCandidatesRejectedPasses = summaries.filter((s) => s.allCandidatesRejected).length;
  const totalClaims = summaries.reduce((total, s) => total + s.keptClaims + s.droppedClaims, 0);
  let state: LedgerState;
  if (allCandidatesRejectedPasses > 0) state = "failed";
  else if (droppedClaims > 0) state = "partial";
  else if (totalClaims === 0) state = "not_applicable";
  else state = "complete";
  return { state, droppedClaims, droppedScenarios, droppedFeatures, allCandidatesRejectedPasses };
}

export function deriveMergeIntegrity(input: { changesTruncated: number; scenariosDeduped: number; outcomeConflicts: number; collapse: boolean }): MergeIntegrityDimension {
  let state: LedgerState = "complete";
  if (input.changesTruncated > 0 || input.outcomeConflicts > 0 || input.collapse) state = "partial";
  return { state, ...input };
}

export function deriveVerification(input: { outcomeConflicts: number; shadowRan: boolean; shadowConsistent: boolean | null }): VerificationDimension {
  let state: LedgerState = "not_applicable";
  if (input.shadowRan) state = input.shadowConsistent ? "complete" : "partial";
  if (input.outcomeConflicts > 0) state = "partial";
  return {
    state,
    outcomeConflicts: input.outcomeConflicts,
    shadowRan: input.shadowRan,
    shadowConsistent: input.shadowConsistent ?? null,
    /** 人工核实在外部核实生命周期追踪，不在 run 级账本内。 */
    humanVerification: "external",
  };
}

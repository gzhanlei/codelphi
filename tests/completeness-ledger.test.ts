import { describe, expect, it } from "vitest";
import type { AnalysisCoverageReceipt } from "../lib/analysis-coverage";
import type { BehavioralEnumerationMetrics, InventoryEnumerationSummary } from "../lib/behavioral-enumeration";
import {
  deriveBehavioralEnumeration,
  deriveEvidenceIntegrity,
  deriveExtractionCompletion,
  deriveMergeIntegrity,
  deriveOverallState,
  deriveSourceCoverage,
  deriveVerification,
} from "../lib/completeness-ledger";

const receipt = (overrides: Partial<AnalysisCoverageReceipt> = {}): AnalysisCoverageReceipt => ({
  implFilesAssembled: 126,
  implFilesTotal: 2149,
  implBytesAssembled: 948_753,
  implBytesTotal: 79_888_435,
  coverageRatio: 0.0119,
  partitionsUsed: 6,
  partitionsCapped: true,
  diffTotalPaths: 131,
  diffSelectedPaths: 131,
  diffOmittedPaths: 0,
  ...overrides,
});

const enumMetrics = (overrides: Partial<BehavioralEnumerationMetrics> = {}): BehavioralEnumerationMetrics => ({
  pathsTotal: 30,
  pathsEnumerated: 30,
  pathsOmitted: 0,
  groupsTotal: 5,
  hunksTotal: 0,
  hunksTruncated: 0,
  groupsCompleted: 5,
  groupsFailed: 0,
  status: "complete",
  ...overrides,
});

describe("deriveSourceCoverage", () => {
  it("partial when partitions capped (W0-7 语义：diff 优先 ≠ 全覆盖)", () => {
    expect(deriveSourceCoverage(receipt()).state).toBe("partial");
  });

  it("complete when uncapped and no diff omission", () => {
    expect(deriveSourceCoverage(receipt({ partitionsCapped: false, diffOmittedPaths: 0 })).state).toBe("complete");
  });

  it("partial when diff paths omitted even without cap", () => {
    expect(deriveSourceCoverage(receipt({ partitionsCapped: false, diffSelectedPaths: 120, diffOmittedPaths: 11 })).state).toBe("partial");
  });

  it("failed when nothing assembled", () => {
    expect(deriveSourceCoverage(receipt({ implFilesAssembled: 0 })).state).toBe("failed");
  });
});

describe("deriveBehavioralEnumeration", () => {
  it("maps metrics status directly and preserves counts", () => {
    const dim = deriveBehavioralEnumeration(enumMetrics({ status: "partial", groupsFailed: 2, pathsOmitted: 12 }));
    expect(dim.state).toBe("partial");
    expect(dim.pathsOmitted).toBe(12);
    expect(deriveBehavioralEnumeration(enumMetrics({ status: "not_applicable", pathsTotal: 0 })).state).toBe("not_applicable");
  });
});

describe("deriveExtractionCompletion", () => {
  it("complete when all passes clean on first try", () => {
    const dim = deriveExtractionCompletion(6, [
      { retries: 0, empty: false },
      { retries: 0, empty: false },
    ]);
    expect(dim.state).toBe("complete");
    expect(dim.passes).toBe(2);
  });

  it("partial when any pass retried or sanitized empty", () => {
    const dim = deriveExtractionCompletion(6, [
      { retries: 1, empty: false },
      { retries: 0, empty: true },
    ]);
    expect(dim.state).toBe("partial");
    expect(dim.retries).toBe(1);
    expect(dim.emptyPasses).toBe(1);
  });
});

describe("deriveEvidenceIntegrity", () => {
  it("complete when no claims dropped", () => {
    expect(deriveEvidenceIntegrity([{ droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: false, keptClaims: 12 }]).state).toBe("complete");
  });

  it("partial when some claims dropped but content kept", () => {
    expect(deriveEvidenceIntegrity([{ droppedClaims: 3, droppedScenarios: 2, droppedFeatures: 0, allCandidatesRejected: false, empty: false, keptClaims: 40 }]).state).toBe("partial");
  });

  it("failed when any pass had all candidates rejected", () => {
    expect(deriveEvidenceIntegrity([
      { droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: false, keptClaims: 40 },
      { droppedClaims: 7, droppedScenarios: 5, droppedFeatures: 2, allCandidatesRejected: true, empty: true, keptClaims: 0 },
    ]).state).toBe("failed");
  });

  it("not_applicable when no claims existed at all", () => {
    expect(deriveEvidenceIntegrity([{ droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: true, keptClaims: 0 }]).state).toBe("not_applicable");
  });
});

describe("deriveMergeIntegrity", () => {
  it("partial on truncation, conflicts, collapse, identity hijacks, feature collapses, or misplaced scenarios", () => {
    expect(deriveMergeIntegrity({ changesTruncated: 20, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 1, collapse: false }).state).toBe("partial");
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: true }).state).toBe("partial");
    // BM-4：身份劫持被门禁拦下 ≠ 没发生——模型违约本身是完整性信号
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 2, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    // BM-7：单功能坍缩被护栏发现同样如实 partial
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 1, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    // BM-6：跨域放置被检出同样如实 partial
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 3, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    // BM-11：功能级变体被折叠同样如实 partial
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, featuresFolded: 1, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
  });

  it("complete when merge is clean (dedup alone is by-design, not partial)", () => {
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 9, featuresFolded: 0, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("complete");
  });
});

describe("deriveVerification", () => {
  it("partial on conflicts", () => {
    expect(deriveVerification({ outcomeConflicts: 1, shadowRan: false, shadowConsistent: null }).state).toBe("partial");
  });

  it("partial when shadow ran inconsistently; complete when consistent", () => {
    expect(deriveVerification({ outcomeConflicts: 0, shadowRan: true, shadowConsistent: false }).state).toBe("partial");
    expect(deriveVerification({ outcomeConflicts: 0, shadowRan: true, shadowConsistent: true }).state).toBe("complete");
  });

  it("not_applicable when no shadow and no conflicts (full mode)", () => {
    expect(deriveVerification({ outcomeConflicts: 0, shadowRan: false, shadowConsistent: null }).state).toBe("not_applicable");
  });
});

describe("deriveOverallState", () => {
  it("picks the worst dimension without merging or averaging", () => {
    expect(deriveOverallState(["complete", "not_applicable", "complete"])).toBe("not_applicable");
    expect(deriveOverallState(["complete", "partial", "not_applicable"])).toBe("partial");
    expect(deriveOverallState(["partial", "failed", "complete"])).toBe("failed");
    expect(deriveOverallState(["complete", "complete"])).toBe("complete");
  });
});

describe("deriveSourceCoverage with inventory primary-range accounting (Task 14)", () => {
  it("new-path receipts require zero primary range omissions for complete", () => {
    const dim = deriveSourceCoverage(receipt({ partitionsCapped: false, diffOmittedPaths: 0, primaryRangesOmitted: 0 }));
    expect(dim.state).toBe("complete");
    expect(dim.primaryRangesOmitted).toBe(0);
  });

  it("new-path receipts with primary range omissions are partial even when uncapped with full diff coverage", () => {
    // 设计 §6.3：新路径不能仅凭「装配数大于零且未触分区帽」推导 complete——
    // 主覆盖区间遗漏必须为零，文件数和字节数只作辅助诊断。
    const dim = deriveSourceCoverage(receipt({ partitionsCapped: false, diffSelectedPaths: 131, diffOmittedPaths: 0, primaryRangesOmitted: 320 }));
    expect(dim.state).toBe("partial");
    expect(dim.primaryRangesOmitted).toBe(320);
  });

  it("legacy receipts without primary-range fields keep historical semantics", () => {
    const legacy = receipt({ partitionsCapped: false, diffOmittedPaths: 0 });
    const dim = deriveSourceCoverage(legacy);
    expect(dim.state).toBe("complete");
    expect(dim.primaryRangesOmitted).toBeNull();
  });
});

describe("deriveBehavioralEnumeration with inventory details (Task 14)", () => {
  const inventorySummary: InventoryEnumerationSummary = {
    unitsTotal: 12,
    unitsPending: 0,
    unitsRunning: 1,
    unitsExtracted: 9,
    unitsNoBehavior: 2,
    unitsUnresolved: 0,
    unitsFailed: 0,
    anchorsTotal: 20,
    entryAnchors: 6,
    behaviorAnchors: 8,
    implicitReviewAnchors: 6,
    coarseReviewAnchors: 4,
    semanticUnits: 9,
    residualUnits: 3,
    unreadableUnits: 0,
    // D：清单生成诊断暴露（随 manifest 持久化的检测器失败面）
    detectorUnsupportedPaths: [],
    detectorParseFailurePaths: [],
    dynamicRegistrationFallbackPaths: [],
    unreadablePaths: [],
    primaryRangesCoveredLines: 4800,
    primaryRangesOmittedLines: 0,
    anchorRangesCoveredLines: 4800,
    anchorRangesOmittedLines: 0,
    tasksTotal: 15,
    tasksReusedTerminal: 11,
    tasksExecuted: 4,
    tasksPending: 0,
    leasesHeld: 1,
    attemptsTotal: 17,
    budgetBlocked: false,
    productDescriptionStatus: "generated",
  };

  it("records running/coarse/implicit/fallback/lease/budget/summary metrics plus resumed-task accounting", () => {
    const dim = deriveBehavioralEnumeration(enumMetrics({ status: "not_applicable", pathsTotal: 0, inventory: inventorySummary }));
    expect(dim.state).toBe("not_applicable");
    expect(dim.inventory).toEqual(inventorySummary);
    // 关键披露面逐项钉死：running / coarse / implicit / fallback（residual）/ lease / budget / summary / 恢复会计
    expect(dim.inventory?.unitsRunning).toBe(1);
    expect(dim.inventory?.coarseReviewAnchors).toBe(4);
    expect(dim.inventory?.implicitReviewAnchors).toBe(6);
    expect(dim.inventory?.residualUnits).toBe(3);
    expect(dim.inventory?.leasesHeld).toBe(1);
    expect(dim.inventory?.attemptsTotal).toBe(17);
    expect(dim.inventory?.budgetBlocked).toBe(false);
    expect(dim.inventory?.productDescriptionStatus).toBe("generated");
    expect(dim.inventory?.tasksReusedTerminal).toBe(11);
    expect(dim.inventory?.tasksExecuted).toBe(4);
  });

  it("old diff-enumeration receipts without inventory details stay compatible", () => {
    const dim = deriveBehavioralEnumeration(enumMetrics({ status: "partial", pathsOmitted: 3 }));
    expect(dim.inventory).toBeUndefined();
    expect(dim.state).toBe("partial");
    expect(dim.pathsOmitted).toBe(3);
  });
});

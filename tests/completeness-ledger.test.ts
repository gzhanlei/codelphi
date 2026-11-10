import { describe, expect, it } from "vitest";
import type { AnalysisCoverageReceipt } from "../lib/analysis-coverage";
import type { BehavioralEnumerationMetrics } from "../lib/behavioral-enumeration";
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
    expect(deriveMergeIntegrity({ changesTruncated: 20, scenariosDeduped: 5, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 1, collapse: false }).state).toBe("partial");
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: true }).state).toBe("partial");
    // BM-4：身份劫持被门禁拦下 ≠ 没发生——模型违约本身是完整性信号
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, identityHijacksDropped: 2, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    // BM-7：单功能坍缩被护栏发现同样如实 partial
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, identityHijacksDropped: 0, featureCollapses: 1, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
    // BM-6：跨域放置被检出同样如实 partial
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 5, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 3, outcomeConflicts: 0, collapse: false }).state).toBe("partial");
  });

  it("complete when merge is clean (dedup alone is by-design, not partial)", () => {
    expect(deriveMergeIntegrity({ changesTruncated: 0, scenariosDeduped: 9, identityHijacksDropped: 0, featureCollapses: 0, misplacedScenarios: 0, outcomeConflicts: 0, collapse: false }).state).toBe("complete");
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

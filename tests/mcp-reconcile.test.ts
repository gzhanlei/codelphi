import { describe, expect, it } from "vitest";
import { evidencePathsFromSubject, reconcileRelease, type ReconcileChange } from "../lib/mcp/reconcile";

function change(id: number, featureName: string, reference: string, path = "lib/a.ts"): ReconcileChange {
  return {
    id,
    featureName,
    featureKey: featureName.toLowerCase(),
    entityType: "scenario",
    scenarioReference: reference,
    before: null,
    after: { reference, context: "c", action: "a", outcome: "o", category: "edge", evidence: [{ path, startLine: id }] },
  };
}

const completeAnalysis = { status: "complete" as const, runId: 333, error: null };

describe("evidencePathsFromSubject", () => {
  it("reads both nested feature evidence and direct scenario evidence", () => {
    expect(evidencePathsFromSubject({ scenarios: [{ evidence: [{ path: "lib/feature.ts" }] }] })).toEqual(["lib/feature.ts"]);
    expect(evidencePathsFromSubject({ evidence: [{ path: "lib/scenario.ts" }] })).toEqual(["lib/scenario.ts"]);
  });
});

describe("reconcileRelease", () => {
  it("keeps stableKey matching at name level and passes only the declared evidence scope", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "变化条目措辞变体判定", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "变化条目措辞变体判定" }],
    });

    expect(result.verdict).toBe("pass");
    expect(result.intentResults[0]).toMatchObject({ identityMatched: true, pathMatched: null, status: "matched" });
    expect(result.intentResults[0].reasonCodes).toContain("exact_name");
    expect(result.intentResults[0].reasonCodes).not.toContain("identity_proven");
  });

  it("never lets path-only intents produce pass", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ paths: ["lib/a.ts"] }],
    });

    expect(result.verdict).toBe("review");
    expect(result.intentResults[0]).toMatchObject({ identityMatched: null, pathMatched: true, status: "unverified" });
  });

  it("separates partial matches from proven missing identities", () => {
    const partial = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "功能", paths: ["lib/missing.ts"] }, { stableKey: "功能" }],
    });
    expect(partial.verdict).toBe("review");
    expect(partial.intentResults[0]).toMatchObject({ identityMatched: true, pathMatched: false, status: "partial" });
    expect(partial.missingExpected).toEqual([]);

    const missing = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "不存在功能" }],
    });
    expect(missing.verdict).toBe("failed");
    expect(missing.missingExpected[0].reasonCodes).toContain("identity_not_found");
  });

  it("marks changes outside every intent as unexpected", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1"), change(2, "计划外功能", "EC-2", "lib/b.ts")],
      releaseFilePaths: ["lib/a.ts", "lib/b.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "功能" }],
    });

    expect(result.verdict).toBe("failed");
    expect(result.unexpected).toEqual([{ changeId: 2, stableKey: "计划外功能", evidencePaths: ["lib/b.ts"], beforePaths: [], afterPaths: ["lib/b.ts"], releaseFilePaths: ["lib/a.ts", "lib/b.ts"], reasonCode: "not_covered_by_intents" }]);
  });

  it("reports duplicate projections but only warns about shared evidence", () => {
    const first = change(1, "功能 A", "EC-1", "lib/shared.ts");
    const duplicate = change(1, "功能 A", "EC-1", "lib/shared.ts");
    const other = change(2, "功能 B", "EC-2", "lib/shared.ts");
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [first, duplicate, other],
      releaseFilePaths: ["lib/shared.ts"],
      analysis: completeAnalysis,
    });

    expect(result.verdict).toBe("review");
    expect(result.duplicateClusters).toHaveLength(1);
    expect(result.duplicateClusters[0]).toMatchObject({ kind: "duplicate_projection", changeIds: [1, 1] });
    expect(result.sharedEvidenceWarnings).toHaveLength(1);
    expect(result.sharedEvidenceWarnings[0].stableKeys).toEqual(["功能 a", "功能 b"]);
  });

  it("reports duplicate scenario identities only with in-version proof", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1"), change(2, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [],
    });

    expect(result.duplicateClusters[0]).toMatchObject({ kind: "duplicate_scenario_identity", stableKey: "功能", scenarioIdentity: "EC-1", changeIds: [1, 2] });
  });

  it("uses persisted feature_key over a drifting display name", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [{ ...change(1, "展示名漂移", "EC-1"), featureKey: "功能" }],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "功能" }],
    });
    expect(result.intentResults[0].identityMatched).toBe(true);
  });

  it("does not mark an identity intent matched when its path belongs to another feature", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能 A", "EC-1", "lib/a.ts"), change(2, "功能 B", "EC-2", "lib/x.ts")],
      releaseFilePaths: ["lib/a.ts", "lib/x.ts"],
      analysis: completeAnalysis,
      expectedIntents: [{ stableKey: "功能 A", paths: ["lib/x.ts"] }],
    });

    expect(result.intentResults[0]).toMatchObject({ identityMatched: true, pathMatched: false, matchedChangeIds: [], status: "partial" });
    expect(result.unexpected.map((item) => item.changeId)).toEqual([1, 2]);
    expect(result.unexpected[0]).toMatchObject({ beforePaths: [], afterPaths: ["lib/a.ts"], releaseFilePaths: ["lib/a.ts", "lib/x.ts"] });
  });

  it("keeps scenario duplicate keys collision-safe for feature names containing pipes", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [{ ...change(1, "功能|子功能", "EC-1"), featureKey: "功能|子功能" }, { ...change(2, "功能|子功能", "EC-1"), featureKey: "功能|子功能" }],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [],
    });
    expect(result.duplicateClusters[0]).toMatchObject({ stableKey: "功能|子功能", scenarioIdentity: "EC-1" });
  });

  it("never passes incomplete analysis even when intents match", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: { status: "partial", runId: 333, error: null },
      expectedIntents: [{ stableKey: "功能" }],
    });

    expect(result.verdict).toBe("review");
    expect(result.analysis.status).toBe("partial");
  });

  it("rejects unexpected deltas for a commit-level no-change declaration", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [change(1, "功能", "EC-1")],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectNoChange: true,
    });

    expect(result.verdict).toBe("failed");
    expect(result.noChangeStatus).toBe("unexpected_change");
    expect(result.missingExpected).toEqual([]);
    expect(result.unexpected[0].reasonCode).toBe("unexpected_change");
  });

  it("does not prove behavior preservation from zero deltas alone", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectNoChange: true,
    });

    expect(result.verdict).toBe("review");
    expect(result.noChangeStatus).toBe("unverified_no_change");
    expect(result.reasons).toContain("unverified_no_change");
    expect(result.missingExpected).toEqual([]);
  });

  it("does not treat an empty intent list as a no-change declaration", () => {
    const result = reconcileRelease({
      releaseId: 229,
      slug: "codelphi",
      sha: "abc",
      changes: [],
      releaseFilePaths: ["lib/a.ts"],
      analysis: completeAnalysis,
      expectedIntents: [],
    });

    expect(result.verdict).toBe("review");
    expect(result.reasons).toContain("no_expected_intents");
  });
});

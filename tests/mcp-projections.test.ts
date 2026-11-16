import { describe, expect, it } from "vitest";
import { canonicalizeScenarios, paginateById, projectFileRisks, type CanonicalScenarioInput } from "../lib/mcp/projections";

function scenario(id: number, reference = "EC-1", path = "lib/a.ts"): CanonicalScenarioInput {
  return { id, featureName: "功能", reference, specReference: "v230", evidencePaths: [path] };
}

describe("canonicalizeScenarios", () => {
  it("collapses only duplicate rows with the same in-version identity and retains every source", () => {
    const result = canonicalizeScenarios([scenario(1), scenario(2), scenario(3, "EC-2")]);

    expect(result.rawCount).toBe(3);
    expect(result.canonicalCount).toBe(2);
    expect(result.collapsedCount).toBe(1);
    expect(result.scenarios[0]).toMatchObject({
      scenarioIdentity: "EC-1",
      rawRecordIds: [1, 2],
      specReferences: ["v230"],
      identityStatus: "proven",
      identityScope: "v230",
    });
    expect(result.scenarios[1]).toMatchObject({ scenarioIdentity: "EC-2", rawRecordIds: [3], identityStatus: "proven" });
    expect(result.rawCount).toBe(result.canonicalCount + result.collapsedCount);
  });

  it("leaves records unresolved when version or evidence differs", () => {
    const result = canonicalizeScenarios([
      scenario(1, "EC-1", "lib/a.ts"),
      { ...scenario(2), specReference: "v231" },
      scenario(3, "EC-1", "lib/b.ts"),
    ]);

    expect(result.canonicalCount).toBe(3);
    expect(result.collapsedCount).toBe(0);
    expect(result.scenarios.every((item) => item.identityStatus === "unresolved" && item.identityScope === "unresolved")).toBe(true);
  });

  it("uses collision-safe keys for feature names containing pipes", () => {
    const result = canonicalizeScenarios([
      { ...scenario(1), featureName: "功能|子功能" },
      { ...scenario(2), featureName: "功能|子功能" },
    ]);
    expect(result.canonicalCount).toBe(1);
    expect(result.collapsedCount).toBe(1);
    expect(result.scenarios[0]).toMatchObject({ identityStatus: "proven", identityScope: "v230", rawRecordIds: [1, 2] });
  });
});

describe("paginateById", () => {
  it("uses stable id ordering and preserves compatible changes field", () => {
    const result = paginateById([{ id: 3 }, { id: 1 }, { id: 2 }], { offset: 1, limit: 1 });
    expect(result.changes.map((item) => item.id)).toEqual([2]);
    expect(result).toMatchObject({ offset: 1, limit: 1, total: 3, hasMore: true });
  });

  it("rejects offset without limit and oversized limits", () => {
    expect(() => paginateById([], { offset: 2 })).toThrow("offset requires limit");
    expect(() => paginateById([], { limit: 101 })).toThrow("limit must be between 1 and 100");
  });
});

describe("projectFileRisks", () => {
  it("returns a stable bounded risk list and distinguishes file from scenario coverage", () => {
    const result = projectFileRisks({
      requestedPaths: ["lib/a.ts", "lib/missing.ts"],
      snapshotSha: "abc",
      rows: Array.from({ length: 12 }, (_, index) => ({
        stableKey: `功能${index}`,
        source: index === 0 ? "manual" : "generated",
        changeIds: [index + 1],
        evidencePaths: [index === 0 ? "lib/other.ts" : "lib/a.ts"],
      })),
    });

    expect(result.risks).toHaveLength(10);
    expect(result.risks[0]).toMatchObject({ rank: 1, severity: "high", coverageType: "scenario" });
    expect(result.coveredPaths).toEqual(["lib/a.ts"]);
    expect(result.uncoveredPaths).toEqual(["lib/missing.ts"]);
    expect(result.totalCount).toBe(12);
    expect(result.hasMore).toBe(true);
  });
});

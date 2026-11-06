import { describe, expect, it } from "vitest";
import { matchSuspectedRenames } from "../lib/spec-rename";
import type { BehaviorChangeRow } from "../lib/types";

function featureChange(id: number, kind: "added" | "removed", name: string, evidencePaths: string[]): BehaviorChangeRow {
  const scenarios = evidencePaths.map((path, index) => ({ reference: `HP-${index + 1}`, context: "c", action: "a", outcome: "o", category: "happy" as const, evidence: [{ path }] }));
  const feature = { name, summary: "", scenarios };
  return { id, releaseId: 1, kind, entityType: "feature", featureName: name, scenarioReference: "", summary: "", before: kind === "removed" ? feature : null, after: kind === "added" ? feature : null };
}

describe("matchSuspectedRenames", () => {
  it("pairs a removed and added feature sharing enough evidence paths", () => {
    const pairs = matchSuspectedRenames([
      featureChange(1, "removed", "Explainer 导出", ["lib/explainer-export.ts", "lib/archify-cli.ts", "lib/old.ts"]),
      featureChange(2, "added", "规格导出与 Explainer", ["lib/explainer-export.ts", "lib/archify-cli.ts", "lib/new.ts"]),
    ]);
    expect(pairs).toEqual([
      { removedId: 1, addedId: 2, removedName: "Explainer 导出", addedName: "规格导出与 Explainer", sharedPaths: 2 },
    ]);
  });

  it("ignores pairs below the shared-path threshold and unrelated kinds", () => {
    const pairs = matchSuspectedRenames([
      featureChange(1, "removed", "甲", ["lib/a.ts"]),
      featureChange(2, "added", "乙", ["lib/a.ts", "lib/b.ts"]),
      { id: 3, releaseId: 1, kind: "removed", entityType: "scenario", featureName: "丙", scenarioReference: "HP-1", summary: "", before: {}, after: null },
    ]);
    expect(pairs).toEqual([]);
  });

  it("greedily assigns each change to at most one pair by best overlap, respecting the threshold", () => {
    const pairs = matchSuspectedRenames([
      featureChange(1, "removed", "旧一", ["lib/a.ts", "lib/b.ts", "lib/c.ts"]),
      featureChange(2, "removed", "旧二", ["lib/d.ts"]),
      featureChange(3, "added", "新一", ["lib/a.ts", "lib/b.ts"]),
      featureChange(4, "added", "新二", ["lib/d.ts"]),
    ]);
    expect(pairs).toEqual([
      { removedId: 1, addedId: 3, removedName: "旧一", addedName: "新一", sharedPaths: 2 },
    ]);
  });
});

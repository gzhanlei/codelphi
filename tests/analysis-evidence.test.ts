import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { assertEvidence } from "../lib/analysis";

const result: AnalysisResult = {
  release: { title: "Test", summary: "Test" },
  changes: [{ featureName: "Auth", kind: "changed", description: "Changed", userImpact: "", evidence: [{ path: "lib/change.ts" }] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [{ reference: "HP-1", context: "User", action: "Logs in", outcome: "Accepted", category: "happy", evidence: [{ path: "lib/feature.ts" }] }] }],
};

describe("analysis evidence validation", () => {
  it("accepts evidence from the current source or changed files", () => {
    expect(() => assertEvidence(result, new Set(["lib/feature.ts", "lib/change.ts"]))).not.toThrow();
  });

  it("rejects every unknown evidence path and reports it once", () => {
    expect(() => assertEvidence(result, new Set(["lib/feature.ts"]))).toThrow("lib/change.ts");
    const duplicated = structuredClone(result);
    duplicated.features[0].scenarios[0].evidence = [{ path: "missing.ts" }, { path: "missing.ts" }];
    expect(() => assertEvidence(duplicated, new Set())).toThrow("missing.ts");
  });

});

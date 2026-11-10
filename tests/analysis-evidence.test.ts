import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { sanitizeEvidence } from "../lib/analysis";

const result: AnalysisResult = {
  product: { description: "Test product", evidence: [{ path: "lib/feature.ts", startLine: 1 }] },
  release: { title: "Test", summary: "Test" },
  changes: [{ featureName: "Auth", kind: "changed", description: "Changed", userImpact: "", evidence: [{ path: "lib/change.ts" }] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [{ reference: "HP-1", context: "User", action: "Logs in", outcome: "Accepted", category: "happy", evidence: [{ path: "lib/feature.ts" }] }] }],
};

describe("analysis evidence sanitization", () => {
  it("keeps evidence from the current source or changed files", () => {
    const sanitized = structuredClone(result);
    expect(() => sanitizeEvidence(sanitized, new Set(["lib/feature.ts", "lib/change.ts"]), "test")).not.toThrow();
    expect(sanitized.features[0].scenarios[0].evidence).toHaveLength(1);
  });

  it("drops claims citing unknown paths instead of failing the pass", () => {
    const sanitized = structuredClone(result);
    sanitizeEvidence(sanitized, new Set(["lib/feature.ts"]), "test");
    // 变化引用 lib/change.ts 不在允许集 → 整条变化被剔除；场景保留（其证据可溯源）
    expect(sanitized.changes).toHaveLength(0);
    expect(sanitized.features[0].scenarios[0].evidence).toHaveLength(1);
  });

  it("keeps the pass when sanitization leaves no evidence-backed scenarios (no-change window)", () => {
    const emptied = structuredClone(result);
    emptied.features[0].scenarios[0].evidence = [{ path: "missing.ts" }];
    expect(() => sanitizeEvidence(emptied, new Set(["lib/feature.ts"]), "test")).not.toThrow();
    expect(emptied.features).toHaveLength(0);
  });
});

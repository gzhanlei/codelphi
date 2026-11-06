import { describe, expect, it } from "vitest";
import { compareIncrementalShadow, type ShadowAnalysis } from "../lib/incremental-shadow";

function feature(name: string, scenarios: Array<[string, string, string, string]>): ShadowAnalysis["features"][number] {
  return {
    name,
    summary: `${name} 摘要`,
    scenarios: scenarios.map(([reference, context, action, outcome]) => ({ reference, context, action, outcome, category: "happy" as const, evidence: [] })),
  };
}

describe("compareIncrementalShadow", () => {
  it("is consistent when key sets and scenario behaviors match regardless of wording drift", () => {
    const incremental = { features: [feature("登录", [["HP-1", "访客", "登录", "进入后台"]])], changes: [] };
    const full = { features: [{ name: "登录", summary: "换个说法", scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入后台", category: "happy" as const, evidence: [] }] }], changes: [] };
    const report = compareIncrementalShadow(incremental, full);
    expect(report.consistent).toBe(true);
    expect(report.missingKeys).toEqual([]);
    expect(report.extraKeys).toEqual([]);
    expect(report.scenarioDiffs).toEqual([]);
  });

  it("reports keys the full run has but the incremental run dropped", () => {
    const report = compareIncrementalShadow(
      { features: [feature("登录", [])], changes: [] },
      { features: [feature("登录", []), feature("支付", [])], changes: [] },
    );
    expect(report.consistent).toBe(false);
    expect(report.missingKeys).toEqual(["支付"]);
  });

  it("reports scenario behavior differences per feature key", () => {
    const report = compareIncrementalShadow(
      { features: [feature("登录", [["HP-1", "访客", "登录", "进入后台"]])], changes: [] },
      { features: [feature("登录", [["HP-1", "访客", "登录", "回到首页"]])], changes: [] },
    );
    expect(report.consistent).toBe(false);
    expect(report.scenarioDiffs).toEqual(["登录:HP-1"]);
  });
});

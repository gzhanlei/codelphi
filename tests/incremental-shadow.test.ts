import { describe, expect, it } from "vitest";
import { SHADOW_REFERENCE_GATE, compareIncrementalShadow, type ShadowAnalysis } from "../lib/incremental-shadow";

function feature(name: string, scenarios: Array<[string, string, string, string]>, category: "happy" | "edge" | "error" = "happy"): ShadowAnalysis["features"][number] {
  return {
    name,
    summary: `${name} 摘要`,
    scenarios: scenarios.map(([reference, context, action, outcome]) => ({ reference, context, action, outcome, category, evidence: [] })),
  };
}

describe("compareIncrementalShadow (方案 A 门槛)", () => {
  it("is consistent when key sets and (reference, category) sets match regardless of wording or decomposition granularity drift", () => {
    // 场景文本完全不同（分解/措辞漂移），但回归编号与类别集合一致 → 通过
    const incremental = { features: [feature("登录", [["HP-1", "分析运行中", "等待", "卡片显示分析中"]])], changes: [] };
    const full = { features: [feature("登录", [["HP-1", "访客", "登录", "进入后台"]])], changes: [] };
    const report = compareIncrementalShadow(incremental, full);
    expect(report.consistent).toBe(true);
    expect(report.referenceConsistency).toBe(1);
    expect(report.inconsistentFeatures).toEqual([]);
  });

  it("reports keys the full run has but the incremental run dropped, at zero consistency", () => {
    const report = compareIncrementalShadow(
      { features: [feature("登录", [])], changes: [] },
      { features: [feature("登录", []), feature("支付", [])], changes: [] },
    );
    expect(report.consistent).toBe(false);
    expect(report.missingKeys).toEqual(["支付"]);
    expect(report.referenceConsistency).toBe(0.5);
  });

  it("fails the gate when (reference, category) sets diverge beyond the threshold", () => {
    // 受影响功能:增量提取比全量少一半场景(Jaccard 0.56 场景的典型形态)
    const report = compareIncrementalShadow(
      { features: [feature("通知", [["HP-1", "a", "b", "c"], ["HP-2", "a", "b", "c"], ["EC-1", "a", "b", "c"], ["EC-2", "a", "b", "c"], ["ER-1", "a", "b", "c"]])], changes: [] },
      { features: [feature("通知", [["HP-1", "x", "y", "z"], ["HP-2", "x", "y", "z"], ["HP-3", "x", "y", "z"], ["HP-4", "x", "y", "z"], ["EC-1", "x", "y", "z"], ["EC-2", "x", "y", "z"], ["EC-3", "x", "y", "z"], ["ER-1", "x", "y", "z"], ["ER-2", "x", "y", "z"]], "edge")], changes: [] },
    );
    expect(report.consistent).toBe(false);
    expect(report.referenceConsistency).toBeLessThan(SHADOW_REFERENCE_GATE);
    expect(report.inconsistentFeatures).toEqual(["通知"]);
  });

  it("gates on the category half of the signature, not just the reference", () => {
    const report = compareIncrementalShadow(
      { features: [feature("登录", [["HP-1", "a", "b", "c"]], "happy")], changes: [] },
      { features: [feature("登录", [["HP-1", "x", "y", "z"]], "error")], changes: [] },
    );
    expect(report.consistent).toBe(false);
    expect(report.referenceConsistency).toBe(0);
  });

  it("marks extra keys as inconsistent too", () => {
    const report = compareIncrementalShadow(
      { features: [feature("登录", []), feature("幽灵", [])], changes: [] },
      { features: [feature("登录", [])], changes: [] },
    );
    expect(report.extraKeys).toEqual(["幽灵"]);
    expect(report.consistent).toBe(false);
    expect(report.referenceConsistency).toBe(0.5);
  });
});

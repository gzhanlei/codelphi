import { describe, expect, it } from "vitest";
import type { SpecFeature, SpecScenario } from "../lib/spec-diff";
import { nextReference, planRestores } from "../scripts/restore-collapsed-scenarios";

const scenario = (reference: string, outcome: string): SpecScenario => ({
  reference,
  context: "访客打开产品页",
  action: "查看行为变化",
  outcome,
  category: "happy",
  evidence: [{ path: "lib/auth.ts", startLine: 10 }],
});

function feature(name: string, scenarios: SpecScenario[]): SpecFeature {
  return { name, summary: "s", scenarios };
}

describe("nextReference", () => {
  it("takes the max suffix per prefix and increments", () => {
    expect(nextReference(["HP-1", "HP-5", "EC-2"], "HP-3")).toBe("HP-6");
    expect(nextReference(["ER-1"], "ER-2")).toBe("ER-2");
    expect(nextReference([], "HP-1")).toBe("HP-1");
  });

  it("keeps non-numeric references untouched", () => {
    expect(nextReference(["HP-1"], "demo")).toBe("demo");
  });
});

describe("planRestores", () => {
  const current = [feature("额度账务核心", [scenario("HP-1", "预留成功后扣减钱包额度")])];
  const baselines = new Map([
    [94, [feature("额度账务核心", [scenario("HP-1", "预留成功后扣减钱包额度"), scenario("HP-2", "心跳续期预留窗口"), scenario("HP-3", "余额不足拒绝预留")])]],
    // v96 场景更少，不应覆盖 v94 作为基线
    [96, [feature("额度账务核心", [scenario("HP-1", "预留成功后扣减钱包额度")])]],
  ]);

  it("restores only scenarios missing from the latest version, from the richest baseline", () => {
    const { plans, skippedMissingFiles } = planRestores(current, baselines, () => true);
    expect(skippedMissingFiles).toBe(0);
    expect(plans).toHaveLength(1);
    expect(plans[0].scenarios.map((item) => [item.reference, item.scenario.outcome])).toEqual([
      ["HP-2", "心跳续期预留窗口"],
      ["HP-3", "余额不足拒绝预留"],
    ]);
    expect(plans[0].scenarios.every((item) => item.sourceVersionId === 94)).toBe(true);
  });

  it("skips scenarios whose evidence files no longer exist", () => {
    const { plans, skippedMissingFiles } = planRestores(current, baselines, (path) => path !== "lib/auth.ts");
    expect(plans).toHaveLength(0);
    expect(skippedMissingFiles).toBe(2);
  });

  it("renumbers restored references that collide with surviving ones", () => {
    const conflicting = [feature("规格导出", [scenario("HP-1", "现行为：导出 Gherkin")])];
    const baseline = new Map([
      [94, [feature("规格导出", [scenario("HP-1", "旧行为：导出 Markdown 已下线"), scenario("HP-2", "导出 Explainer 页面")])]],
    ]);
    const { plans } = planRestores(conflicting, baseline, () => true);
    expect(plans[0].scenarios.map((item) => item.reference)).toEqual(["HP-2", "HP-3"]);
  });

  it("is idempotent: nothing to restore when the latest version already has everything", () => {
    const full = [feature("额度账务核心", [scenario("HP-1", "预留成功后扣减钱包额度"), scenario("HP-2", "心跳续期预留窗口"), scenario("HP-3", "余额不足拒绝预留")])];
    const { plans } = planRestores(full, baselines, () => true);
    expect(plans).toHaveLength(0);
  });

  it("ignores features whose baseline is not richer than current", () => {
    const { plans } = planRestores([feature("新增功能", [scenario("HP-1", "全新行为")])], new Map([[94, [feature("其他功能", [scenario("HP-1", "别的行为")])]]]), () => true);
    expect(plans).toHaveLength(0);
  });
});

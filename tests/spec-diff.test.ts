import { describe, expect, it } from "vitest";
import { diffSpec, mergeSpecSources, normalizeSpecText, specFeatureKey, specScenarioKey, specTextEquivalent, type SpecFeature } from "../lib/spec-diff";

const authentication: SpecFeature = {
  name: "Authentication",
  summary: "Sign in and account recovery",
  scenarios: [{
    reference: "HP-1",
    context: "Visitor",
    action: "Signs in with valid credentials",
    outcome: "Opens the dashboard",
    category: "happy",
    evidence: [{ path: "app/auth/login.tsx", startLine: 1 }],
  }],
};

describe("spec behavior diff", () => {
  it("does not turn the first analysis into a release full of additions", () => {
    expect(diffSpec(null, [authentication])).toEqual([]);
  });

  it("reports added and removed features without duplicating every nested scenario", () => {
    const added = diffSpec([], [authentication]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "added", entityType: "feature", featureName: "Authentication", scenarioReference: null, summary: "新增功能「Authentication」" });
    expect(added[0].before).toBeNull();
    expect(added[0].after).toEqual(authentication);

    const removed = diffSpec([authentication], []);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ kind: "removed", entityType: "feature", featureName: "Authentication" });
    expect(removed[0].after).toBeNull();
    expect(removed[0].before).toEqual(authentication);
  });

  it("detects scenario behavior changes but ignores evidence-only line movements", () => {
    const evidenceOnly = structuredClone(authentication);
    evidenceOnly.scenarios[0].evidence = [{ path: "app/auth/login.tsx", startLine: 99 }];
    expect(diffSpec([authentication], [evidenceOnly])).toEqual([]);

    const changed = structuredClone(authentication);
    changed.scenarios[0].outcome = "Opens onboarding";
    const result = diffSpec([authentication], [changed]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "changed", entityType: "scenario", featureName: "Authentication", scenarioReference: "HP-1", summary: "「Authentication」更新场景 HP-1" });
    expect(result[0].before).toMatchObject({ outcome: "Opens the dashboard" });
    expect(result[0].after).toMatchObject({ outcome: "Opens onboarding" });
  });

  it("detects each scenario behavior field independently", () => {
    for (const [field, value] of [["context", "Signed in"], ["action", "Uses OAuth"], ["category", "error"]] as const) {
      const changed = structuredClone(authentication);
      Object.assign(changed.scenarios[0], { [field]: value });
      expect(diffSpec([authentication], [changed])).toHaveLength(1);
    }
  });

  it("reports feature summary changes and scenario additions/removals", () => {
    const changed = structuredClone(authentication);
    changed.summary = "OAuth identity";
    changed.scenarios.push({ ...authentication.scenarios[0], reference: "ER-1", category: "error", outcome: "Rejected" });
    const result = diffSpec([authentication], [changed]);
    expect(result.map((change) => `${change.kind}:${change.entityType}`)).toEqual(["changed:feature", "added:scenario"]);

    const removedScenario = diffSpec([changed], [authentication]);
    expect(removedScenario.map((change) => `${change.kind}:${change.entityType}`)).toEqual(["changed:feature", "removed:scenario"]);
  });
});

describe("spec wording equivalence (P0 noise collapse)", () => {
  it("collapses same-meaning rewording of a scenario without emitting a change", () => {
    const reworded = structuredClone(authentication);
    reworded.scenarios[0].context = "提交的任务不属于当前产品";
    const current = structuredClone(authentication);
    current.scenarios[0].context = "提交的任务不属于该产品";
    expect(diffSpec([reworded], [current])).toEqual([]);
  });

  it("treats whitespace, punctuation-width and full/half-width variants as unchanged", () => {
    expect(specTextEquivalent("返回 404。", "返回404")).toBe(true);
    expect(specTextEquivalent("（未登录）时拒绝", "(未登录)时拒绝")).toBe(true);
    expect(normalizeSpecText("４０４　错误")).toBe("404 错误");
  });

  it("never collapses changes that flip digits or latin tokens", () => {
    expect(specTextEquivalent("返回 404", "返回 400")).toBe(false);
    expect(specTextEquivalent("仅接受 admin@example.com 的邀请", "仅接受 user@example.com 的邀请")).toBe(false);
    expect(specTextEquivalent("Opens the dashboard", "Opens onboarding")).toBe(false);
  });

  it("keeps semantic Chinese flips detectable even at high character overlap", () => {
    expect(specTextEquivalent("邀请成功", "邀请失败")).toBe(false);
    expect(specTextEquivalent("允许访问", "禁止访问")).toBe(false);
    expect(specTextEquivalent("可以重试", "不可以重试")).toBe(false);
    expect(specTextEquivalent("返回空列表", "返回 404")).toBe(false);
  });

  it("does not collapse against empty text", () => {
    expect(specTextEquivalent("", "返回 404")).toBe(false);
    expect(specTextEquivalent("返回 404", "")).toBe(false);
  });

  it("collapses a feature summary rewording but keeps name and parent changes", () => {
    const before = structuredClone(authentication);
    before.summary = "登录与账号找回";
    const after = structuredClone(authentication);
    after.summary = "登录和账号找回";
    expect(diffSpec([before], [after])).toEqual([]);

    const renamed = structuredClone(authentication);
    renamed.name = "Auth";
    expect(diffSpec([authentication], [renamed])).toHaveLength(2);
  });

  it("still reports category flips as behavior changes", () => {
    const changed = structuredClone(authentication);
    changed.scenarios[0].category = "error";
    expect(diffSpec([authentication], [changed])).toHaveLength(1);
  });

  it("collapses a renumbered scenario whose behavior fields are all equivalent", () => {
    const before = structuredClone(authentication);
    before.scenarios.push({ reference: "HP-2", context: "提交的任务不属于当前产品", action: "查询任务详情", outcome: "返回 404。", category: "error", evidence: [] });
    const after = structuredClone(authentication);
    after.scenarios.push({ reference: "HP-6", context: "提交的任务不属于该产品", action: "查询任务详情", outcome: "返回 404", category: "error", evidence: [] });
    expect(diffSpec([before], [after])).toEqual([]);
  });

  it("keeps removed/added pairs when the behavior really differs", () => {
    const before = structuredClone(authentication);
    before.scenarios.push({ reference: "HP-2", context: "任务不存在", action: "查询任务详情", outcome: "返回 404", category: "error", evidence: [] });
    const after = structuredClone(authentication);
    after.scenarios.push({ reference: "HP-6", context: "任务已被删除", action: "恢复任务", outcome: "恢复成功并通知成员", category: "happy", evidence: [] });
    expect(diffSpec([before], [after]).map((change) => change.kind)).toEqual(["removed", "added"]);
  });

  it("pairs renumbered scenarios greedily without reusing the same added row", () => {
    const before = structuredClone(authentication);
    before.scenarios.push(
      { reference: "HP-2", context: "任务不存在", action: "查询详情", outcome: "返回 404", category: "error", evidence: [] },
      { reference: "HP-3", context: "任务不存在", action: "查询列表", outcome: "返回 404", category: "error", evidence: [] },
    );
    const after = structuredClone(authentication);
    after.scenarios.push(
      { reference: "HP-5", context: "任务不存在", action: "查询列表", outcome: "返回 404", category: "error", evidence: [] },
      { reference: "HP-6", context: "任务不存在", action: "查询详情", outcome: "返回 404", category: "error", evidence: [] },
    );
    expect(diffSpec([before], [after])).toEqual([]);
  });
});

describe("spec source merging", () => {
  it("keeps manual features and lets manual content override generated content by stable key", () => {
    const generated = structuredClone(authentication);
    generated.summary = "AI summary";
    generated.scenarios.push({ ...authentication.scenarios[0], reference: "HP-2" });
    const manual = structuredClone(authentication);
    manual.summary = "Curated summary";
    manual.scenarios[0].outcome = "Curated outcome";
    const manualOnly: SpecFeature = { name: "Team notes", summary: "Manual only", scenarios: [] };

    const merged = mergeSpecSources([generated], [manual, manualOnly]);
    expect(merged).toHaveLength(2);
    const auth = merged.find((feature) => feature.name === "Authentication");
    expect(auth?.summary).toBe("Curated summary");
    expect(auth?.scenarios.map((scenario) => scenario.reference).sort()).toEqual(["HP-1", "HP-2"]);
    expect(auth?.scenarios.find((scenario) => scenario.reference === "HP-1")?.outcome).toBe("Curated outcome");
    expect(merged.some((feature) => feature.name === "Team notes")).toBe(true);
  });

  it("keeps fresh generated fields when a generated parent is retained for hierarchy", () => {
    const generated = { ...structuredClone(authentication), summary: "Fresh AI summary" };
    const retained = { ...structuredClone(authentication), summary: "Stale stored summary", source: "generated" as const };
    retained.scenarios.push({ ...retained.scenarios[0], reference: "HP-9", source: "manual" });
    const merged = mergeSpecSources([generated], [retained]);
    expect(merged[0].summary).toBe("Fresh AI summary");
    expect(merged[0].scenarios.map((scenario) => scenario.reference).sort()).toEqual(["HP-1", "HP-9"]);
  });

  it("suppresses generated features and scenarios deleted through the editor", () => {
    const team: SpecFeature = { name: "Team notes", summary: "Generated again", scenarios: [] };
    const merged = mergeSpecSources([structuredClone(authentication), team], [], {
      featureKeys: new Set([specFeatureKey("Team notes")]),
      scenarioKeys: new Set([specScenarioKey("Authentication", "HP-1")]),
    });
    expect(merged.map((feature) => feature.name)).toEqual(["Authentication"]);
    expect(merged[0].scenarios).toEqual([]);
  });
});

describe("mergeSpecSources with carried features (M9)", () => {
  const carried: SpecFeature[] = [
    { name: "Legacy", summary: "Carried", parentKey: null, source: "generated", scenarios: [{ reference: "HP-1", context: "C", action: "A", outcome: "O", category: "happy", evidence: [], source: "generated" }] },
  ];

  it("seeds carried features, then lets generated override the same key", () => {
    const merged = mergeSpecSources([{ name: "Legacy", summary: "Fresh", scenarios: [] }], [], undefined, carried);
    expect(merged).toHaveLength(1);
    expect(merged[0].summary).toBe("Fresh");
    expect(merged[0].scenarios).toEqual([]);
  });

  it("carries features absent from generated output", () => {
    const merged = mergeSpecSources([], [], undefined, carried);
    expect(merged.map((feature) => feature.name)).toEqual(["Legacy"]);
    expect(merged[0].scenarios[0].reference).toBe("HP-1");
  });

  it("lets manual content win over carried and skips tombstoned carried keys", () => {
    const merged = mergeSpecSources([], [{ name: "Legacy", summary: "Manual", source: "manual", scenarios: [] }], undefined, carried);
    expect(merged[0].summary).toBe("Manual");
    expect(merged[0].source).toBe("manual");
    const tombstoned = mergeSpecSources([], [], { featureKeys: new Set(["legacy"]), scenarioKeys: new Set() }, carried);
    expect(tombstoned).toEqual([]);
  });
});

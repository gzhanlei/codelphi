import { describe, expect, it } from "vitest";
import { buildProductOverview } from "../lib/product-overview";
import type { ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "../lib/types";

const features: FeatureRow[] = [
  { id: 3, name: "发布", summary: "Releases", parentId: null, source: "generated" },
  { id: 1, name: "登录", summary: "OAuth", parentId: null, source: "generated" },
  { id: 2, name: "规格", summary: "Specs", parentId: null, source: "manual" },
];
const scenarios: ScenarioRow[] = [
  { id: 1, featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: [{ path: "app/auth.ts" }] },
  { id: 2, featureId: 1, reference: "ER-1", context: "Invalid", action: "Retries", outcome: "Rejected", category: "error", source: "manual", evidence: [{ path: "app/auth.ts" }, { path: "lib/oauth.ts" }] },
  { id: 3, featureId: 2, reference: "HP-1", context: "User", action: "Reads", outcome: "Specs", category: "happy", source: "manual", evidence: [] },
];
const releases: ReleaseRow[] = [{ id: 8, title: "Specs", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 }];

describe("product overview", () => {
  it("builds linked capabilities, recent behavior changes and trust stats", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "产品知识中心" },
      features,
      scenarios,
      releases,
      behaviorChanges: [
        { id: 1, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "规格", scenarioReference: "HP-1", summary: "场景结果变化", before: {}, after: {} },
        { id: 2, releaseId: 7, kind: "added", entityType: "feature", featureName: "旧版本", scenarioReference: "", summary: "不应显示", before: null, after: {} },
      ],
      latestRun: { status: "succeeded" },
    });
    expect(overview.headline).toBe("产品知识中心");
    expect(overview.freshness).toBe("Spec v8 · abcdef1 · 更新 11-01 00:00 UTC");
    expect(overview.analysisLabel).toBe("最近分析成功");
    expect(overview.capabilities[0]).toMatchObject({ id: 1, name: "登录", scenarioCount: 2, href: "/products/default/radar?view=spec&feature=1" });
    expect(overview.capabilities.map((feature) => feature.id)).toEqual([1, 2, 3]);
    expect(overview.changes.map((change) => change.summary)).toEqual(["场景结果变化"]);
    expect(overview.trust).toMatchObject({ featureCount: 3, scenarioCount: 3, manualFeatureCount: 1, manualScenarioCount: 2, evidencePathCount: 2, specVersionId: 8 });
    expect(overview).not.toHaveProperty("architecture");
  });

  it("uses the release version and handles unknown analysis states", () => {
    const overview = buildProductOverview({ productBase: "/products/default/radar", product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases, behaviorChanges: [], latestRun: { status: "degraded" } });
    expect(overview.freshness).toBe("Spec v8 · abcdef1 · 更新 11-01 00:00 UTC");
    expect(overview.trust.specVersionId).toBe(8);
    expect(overview.analysisLabel).toBe("分析状态：degraded");
  });

  it("reports when no spec version exists", () => {
    const overview = buildProductOverview({ productBase: "/products/default/radar", product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: undefined });
    expect(overview.freshness).toBe("尚未生成规格");
    expect(overview.trust.specVersionId).toBeNull();
    expect(overview.changes).toEqual([]);
    expect(overview.changeGroups).toEqual([]);
  });

  it("aggregates the latest release changes per feature, largest first", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [{ ...releases[0], id: 12 }],
      behaviorChanges: [
        { id: 1, releaseId: 12, kind: "added", entityType: "scenario", featureName: "规格", scenarioReference: "HP-2", summary: "", before: null, after: {} },
        { id: 2, releaseId: 12, kind: "added", entityType: "scenario", featureName: "规格", scenarioReference: "HP-3", summary: "", before: null, after: {} },
        { id: 3, releaseId: 12, kind: "removed", entityType: "scenario", featureName: "规格", scenarioReference: "ER-2", summary: "", before: {}, after: null },
        { id: 4, releaseId: 12, kind: "changed", entityType: "feature", featureName: "登录", scenarioReference: "", summary: "", before: {}, after: {} },
        { id: 5, releaseId: 7, kind: "added", entityType: "feature", featureName: "旧版本", scenarioReference: "", summary: "", before: null, after: {} },
      ],
      latestRun: { status: "succeeded" },
    });
    expect(overview.changeGroups).toEqual([
      { featureName: "规格", added: 2, removed: 1, changed: 0 },
      { featureName: "登录", added: 0, removed: 0, changed: 1 },
    ]);
  });

  it("exposes generated description provenance and evidence", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识中心", descriptionSource: "generated", descriptionEvidence: [{ path: "lib/analysis.ts", startLine: 185 }] },
      features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "succeeded" },
    });
    expect(overview.headline).toBe("代码驱动的产品知识中心");
    expect(overview.headlineSource).toBe("generated");
    expect(overview.headlineEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
  });
});

describe("product overview user impact projection", () => {
  const release = (id: number, days: number): ReleaseRow => ({ id, title: `发布${id}`, summary: "Summary", sha: `sha${id}abcdef`, url: "", committedAt: new Date(`2026-11-${String(days).padStart(2, "0")}`), specVersionId: id });
  const impact = (id: number, releaseId: number, featureName: string, userImpact: string): ChangeRow => ({ id, releaseId, featureName, kind: "changed", description: "", userImpact, evidence: [] });

  it("uses only the latest release impacts, filters blanks, caps at 3 and keeps original order", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [release(12, 10), release(8, 1)],
      behaviorChanges: [],
      changes: [
        impact(1, 8, "旧功能", "更早发布的影响不应入选"),
        impact(2, 12, "甲", "影响一"),
        impact(3, 12, "乙", "  "),
        impact(4, 12, "丙", "影响二"),
        impact(5, 12, "丁", "影响三"),
        impact(6, 12, "戊", "影响四"),
      ],
      latestRun: { status: "succeeded" },
    });
    expect(overview.userImpact.state).toBe("impacts");
    expect(overview.userImpact.items).toEqual([
      { releaseId: 12, featureName: "甲", userImpact: "影响一" },
      { releaseId: 12, featureName: "丙", userImpact: "影响二" },
      { releaseId: 12, featureName: "丁", userImpact: "影响三" },
    ]);
  });

  it("falls back to deterministic change stats when the latest release has no user impacts", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [release(12, 10)],
      behaviorChanges: [
        { id: 1, releaseId: 12, kind: "added", entityType: "feature", featureName: "甲", scenarioReference: "", summary: "", before: null, after: {} },
        { id: 2, releaseId: 12, kind: "changed", entityType: "scenario", featureName: "乙", scenarioReference: "HP-1", summary: "", before: {}, after: {} },
      ],
      changes: [impact(9, 12, "甲", "   ")],
      latestRun: { status: "succeeded" },
    });
    expect(overview.userImpact.state).toBe("changes");
    expect(overview.userImpact.items).toEqual([]);
    expect(overview.userImpact.changeStats).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(overview.userImpact.releaseId).toBe(12);
  });

  it("reports a quiet release and never borrows impacts from earlier releases", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [release(12, 10), release(8, 1)],
      behaviorChanges: [{ id: 1, releaseId: 8, kind: "added", entityType: "feature", featureName: "旧功能", scenarioReference: "", summary: "", before: null, after: {} }],
      changes: [impact(1, 8, "旧功能", "更早发布的影响")],
      latestRun: { status: "succeeded" },
    });
    expect(overview.userImpact.state).toBe("quiet");
    expect(overview.userImpact.items).toEqual([]);
    expect(overview.userImpact.releaseId).toBe(12);
  });

  it("points at the most recent earlier release with behavior changes, labeled explicitly", () => {
    const overview = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [release(12, 10), release(9, 5), release(8, 1)],
      behaviorChanges: [
        { id: 1, releaseId: 8, kind: "added", entityType: "feature", featureName: "旧一", scenarioReference: "", summary: "", before: null, after: {} },
        { id: 2, releaseId: 9, kind: "changed", entityType: "scenario", featureName: "旧二", scenarioReference: "HP-1", summary: "", before: {}, after: {} },
      ],
      latestRun: { status: "succeeded" },
    });
    expect(overview.userImpact.state).toBe("quiet");
    expect(overview.userImpact.priorBehavioralRelease).toMatchObject({ id: 9, title: "发布9" });
    expect(overview.userImpact.priorBehavioralRelease?.dateLabel).toContain("11月5日");
  });

  it("handles no release and missing change rows without crashing", () => {
    const empty = buildProductOverview({ productBase: "/products/default/radar", product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "succeeded" } });
    expect(empty.userImpact.state).toBe("none");
    expect(empty.userImpact.items).toEqual([]);
    expect(empty.userImpact.priorBehavioralRelease).toBeNull();
    const legacy = buildProductOverview({ productBase: "/products/default/radar", product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [release(8, 1)], behaviorChanges: [], latestRun: { status: "succeeded" } });
    expect(legacy.userImpact.state).toBe("quiet");
  });
});

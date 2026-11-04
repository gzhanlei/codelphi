import { describe, expect, it } from "vitest";
import { buildProductOverview } from "../lib/product-overview";
import type { FeatureRow, ReleaseRow, ScenarioRow } from "../lib/types";

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
      product: { id: 1, slug: "radar", name: "Radar", description: "产品知识中心" },
      features,
      scenarios,
      releases,
      behaviorChanges: [
        { id: 1, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "规格", scenarioReference: "HP-1", summary: "场景结果变化", before: {}, after: {} },
        { id: 2, releaseId: 7, kind: "added", entityType: "feature", featureName: "旧版本", scenarioReference: "", summary: "不应显示", before: null, after: {} },
      ],
      latestRun: { status: "succeeded" },
      architecture: { id: 5, specVersionId: 8, revision: "abcdef123456", status: "accepted", errorMessage: null },
    });
    expect(overview.headline).toBe("产品知识中心");
    expect(overview.freshness).toBe("Spec v8 · abcdef1");
    expect(overview.analysisLabel).toBe("最近分析成功");
    expect(overview.capabilities[0]).toMatchObject({ id: 1, name: "登录", scenarioCount: 2, href: "/products/radar?view=spec&feature=1" });
    expect(overview.capabilities.map((feature) => feature.id)).toEqual([1, 2, 3]);
    expect(overview.changes.map((change) => change.summary)).toEqual(["场景结果变化"]);
    expect(overview.trust).toMatchObject({ featureCount: 3, scenarioCount: 3, manualFeatureCount: 1, manualScenarioCount: 2, evidencePathCount: 2, specVersionId: 8 });
    expect(overview.architecture).toMatchObject({ id: 5, status: "accepted", href: "/products/radar/architecture/5" });
  });

  it("falls back to the release version and handles unknown analysis states", () => {
    const overview = buildProductOverview({ product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases, behaviorChanges: [], latestRun: { status: "degraded" }, architecture: undefined });
    expect(overview.freshness).toBe("Spec v8 · abcdef1");
    expect(overview.trust.specVersionId).toBe(8);
    expect(overview.analysisLabel).toBe("分析状态：degraded");
    expect(overview.architecture).toBeUndefined();
  });

  it("reports when no spec version exists", () => {
    const overview = buildProductOverview({ product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: undefined, architecture: undefined });
    expect(overview.freshness).toBe("尚未生成规格");
    expect(overview.trust.specVersionId).toBeNull();
  });

  it("exposes generated description provenance and evidence", () => {
    const overview = buildProductOverview({
      product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识中心", descriptionSource: "generated", descriptionEvidence: [{ path: "lib/analysis.ts", startLine: 185 }] },
      features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "succeeded" }, architecture: undefined,
    });
    expect(overview.headline).toBe("代码驱动的产品知识中心");
    expect(overview.headlineSource).toBe("generated");
    expect(overview.headlineEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
  });

  it("does not invent an architecture link or a spec version", () => {
    const overview = buildProductOverview({ product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: undefined, architecture: { id: 6, specVersionId: 9, revision: "deadbeef", status: "failed", errorMessage: "Layout failed" } });
    expect(overview.headline).toBe("产品概览");
    expect(overview.freshness).toBe("Spec v9 · deadbee");
    expect(overview.architecture).toMatchObject({ status: "failed", errorMessage: "Layout failed" });
    expect(overview.architecture?.href).toBeUndefined();
    expect(overview.changes).toEqual([]);
  });
});

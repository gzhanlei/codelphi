import { describe, expect, it } from "vitest";
import { renderProductExplainerHtml } from "../lib/product-explainer";
import type { ProductOverviewData } from "../lib/product-overview";

const overview = {
  slug: "radar",
  productBase: "/products/default/radar",
  description: "产品知识中心",
  headline: "产品知识中心",
  headlineSource: "generated",
  headlineEvidence: [{ path: "lib/analysis.ts", startLine: 185 }],
  freshness: "Spec v8 · abcdef1",
  analysisLabel: "最近分析成功",
  capabilities: [{ id: 1, name: "登录|统一认证", summary: "OAuth", source: "generated" as const, scenarioCount: 3, href: "/products/radar?view=spec&feature=1" }],
  changes: [{ id: 1, releaseId: 8, kind: "changed" as const, entityType: "scenario" as const, featureName: "规格", scenarioReference: "HP-1", summary: "结果更明确", before: {}, after: {} }],
  changeStats: { added: 0, removed: 0, changed: 1 },
  latestRelease: { id: 8, title: "规格改进", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 },
  trust: { featureCount: 4, scenarioCount: 12, manualFeatureCount: 1, manualScenarioCount: 2, evidencePathCount: 5, specVersionId: 8 },
} as ProductOverviewData;

describe("renderProductExplainerHtml", () => {
  it("renders the one-pager with CoDelphi branding and all content sections", () => {
    const html = renderProductExplainerHtml(overview);
    expect(html).toContain("<title>产品知识中心 · CoDelphi</title>");
    expect(html).toContain("当前核心能力");
    expect(html).toContain("最近改变了什么");
    expect(html).toContain("证据覆盖率");
    expect(html).toContain("结果更明确");
    expect(html).toContain("人工维护 1 个功能和 2 个场景");
    expect(html).toContain("读懂每一次产品变化。");
    expect(html).toContain("规格版本 v8");
    expect(html).not.toContain("Archify");
    expect(html).not.toContain("tt-a1i");
  });

  it("escapes user-controlled text and links capabilities to their spec pages", () => {
    const html = renderProductExplainerHtml(overview);
    expect(html).toContain("登录|统一认证");
    expect(html).toContain('href="/products/radar?view=spec&amp;feature=1"');
  });

  it("states an empty change section instead of an empty table", () => {
    const html = renderProductExplainerHtml({ ...overview, changes: [] });
    expect(html).toContain("本次分析未发现规格行为变化。");
  });
});

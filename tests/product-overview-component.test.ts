import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductOverview } from "../components/product-overview";
import { buildProductOverview } from "../lib/product-overview";

function completeOverview() {
  return buildProductOverview({
    product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识中心", descriptionSource: "generated", descriptionEvidence: [{ path: "lib/analysis.ts", startLine: 185 }] },
    features: [{ id: 1, name: "产品分析", summary: "从代码生成规格", parentId: null, source: "generated" }],
    scenarios: [{ id: 2, featureId: 1, reference: "HP-1", context: "用户", action: "分析", outcome: "规格", category: "happy", source: "generated", evidence: [] }],
    releases: [{ id: 8, title: "首版", summary: "Summary", sha: "abcdef123456", url: "", committedAt: new Date("2026-11-01"), specVersionId: 8 }],
    behaviorChanges: [{ id: 3, releaseId: 8, kind: "added", entityType: "feature", featureName: "产品分析", scenarioReference: "", summary: "新增分析能力", before: null, after: {} }],
    latestRun: { status: "succeeded" },
    architecture: { id: 5, specVersionId: 8, revision: "fedcba123456", status: "accepted", errorMessage: null },
  });
}

describe("product overview rendering", () => {
  it("renders capabilities, changes, architecture and generated provenance", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: completeOverview() }));
    expect(html).toContain("代码驱动的产品知识中心");
    expect(html).toContain("代码生成 · 1 个证据文件");
    expect(html).toContain("查看交互式架构图");
    expect(html).toContain("产品分析");
    expect(html).toContain("新增分析能力");
    expect(html).toContain("查看交互式架构图 <span>Spec v8 · fedcba1");
  });

  it("renders empty history and a rendered architecture error", () => {
    const data = buildProductOverview({
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "running" },
      architecture: { id: 6, specVersionId: 9, revision: "deadbeef123456", status: "rendered", errorMessage: "Browser unavailable" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("产品概览");
    expect(html).toContain("尚无功能规格");
    expect(html).toContain("尚无发布记录");
    expect(html).toContain("Browser unavailable");
    expect(html).toContain("已生成，待视觉验收");
  });

  it("renders unknown architecture states, manual capabilities and a zero version defensively", () => {
    const data = completeOverview();
    data.architecture!.status = "degraded";
    data.architecture!.href = undefined;
    data.architecture!.errorMessage = null;
    data.capabilities[0].source = "manual";
    data.trust.specVersionId = 0;
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("degraded");
    expect(html).toContain("人工维护");
    expect(html).toContain("<dd>0</dd>");
  });

  it("renders the missing architecture state", () => {
    const data = buildProductOverview({ product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: undefined, architecture: undefined });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("尚未生成架构文档");
    expect(html).toContain("<dt>规格版本</dt><dd>未生成</dd>");
  });
});

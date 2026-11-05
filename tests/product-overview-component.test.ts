import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductOverview } from "../components/product-overview";
import { buildProductOverview } from "../lib/product-overview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function completeOverview() {
  return buildProductOverview({
    product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识中心", descriptionSource: "generated", descriptionEvidence: [{ path: "lib/analysis.ts", startLine: 185 }] },
    features: [{ id: 1, name: "产品分析", summary: "从代码生成规格", parentId: null, source: "generated" }],
    scenarios: [{ id: 2, featureId: 1, reference: "HP-1", context: "用户", action: "分析", outcome: "规格", category: "happy", source: "generated", evidence: [] }],
    releases: [{ id: 8, title: "首版", summary: "Summary", sha: "abcdef123456", url: "", committedAt: new Date("2026-11-01"), specVersionId: 8 }],
    behaviorChanges: [{ id: 3, releaseId: 8, kind: "added", entityType: "feature", featureName: "产品分析", scenarioReference: "", summary: "新增分析能力", before: null, after: {} }],
    latestRun: { status: "succeeded" },
  });
}

describe("product overview rendering", () => {
  it("renders capabilities, changes and generated provenance without architecture content", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: completeOverview() }));
    expect(html).toContain("代码驱动的产品知识中心");
    expect(html).toContain("代码生成 · 1 个证据文件");
    expect(html).toContain("产品分析");
    expect(html).toContain("新增分析能力");
    expect(html).not.toContain("架构");
    expect(html).not.toContain("/architecture/");
  });

  it("renders empty history without an architecture placeholder", () => {
    const data = buildProductOverview({
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "running" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("产品概览");
    expect(html).toContain("尚无功能规格");
    expect(html).toContain("尚无发布记录");
    expect(html).not.toContain("尚未生成架构文档");
    expect(html).toContain("<dt>规格版本</dt><dd>未生成</dd>");
  });

  it("renders the latest release title and summary when it has no behavior diff", () => {
    const data = buildProductOverview({
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [{ id: 9, title: "多提交 push 分析纳入全部提交标题", summary: "一次推送中的全部提交都会进入发布说明。", sha: "809a5b5ffff", url: "", committedAt: new Date("2026-11-06"), specVersionId: 8 }],
      behaviorChanges: [{ id: 4, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "旧发布", scenarioReference: "HP-1", summary: "挂在旧版本上的变化，不应显示", before: {}, after: {} }],
      latestRun: { status: "succeeded" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("多提交 push 分析纳入全部提交标题");
    expect(html).toContain("一次推送中的全部提交都会进入发布说明。");
    expect(html).toContain("本次发布没有规格行为 Diff");
    expect(html).not.toContain("不应显示");
  });

  it("renders manual capabilities and a zero version defensively", () => {
    const data = completeOverview();
    data.capabilities[0].source = "manual";
    data.trust.specVersionId = 0;
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("人工维护");
    expect(html).toContain("<dd>0</dd>");
  });

  it("renders the overview edit pencil only for editors", () => {
    const data = completeOverview();
    expect(renderToStaticMarkup(createElement(ProductOverview, { data, canEdit: false }))).not.toContain("编辑产品概况");
    const editable = renderToStaticMarkup(createElement(ProductOverview, { data, canEdit: true }));
    expect(editable).toContain("编辑产品概况");
    expect(editable).toContain("description-dialog");
  });
});

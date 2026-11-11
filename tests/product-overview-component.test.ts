import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductOverview } from "../components/product-overview";
import { buildProductOverview } from "../lib/product-overview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function completeOverview() {
  return buildProductOverview({
    productBase: "/products/default/radar",
    product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识中心", descriptionSource: "generated", descriptionEvidence: [{ path: "lib/analysis.ts", startLine: 185 }] },
    features: [{ id: 1, name: "产品分析", summary: "从代码生成规格", parentId: null, source: "generated" }],
    scenarios: [{ id: 2, featureId: 1, reference: "HP-1", context: "用户", action: "分析", outcome: "规格", category: "happy", source: "generated", evidence: [] }],
    releases: [{ id: 8, title: "首版", summary: "Summary", sha: "abcdef123456", url: "", committedAt: new Date("2026-11-01"), specVersionId: 8 }],
    behaviorChanges: [{ id: 3, releaseId: 8, kind: "added", entityType: "feature", featureName: "产品分析", scenarioReference: "", summary: "新增分析能力", before: null, after: {} }],
    latestRun: { status: "succeeded" },
    releaseNotes: [{ releaseId: 8, status: "published", headline: "首个公开版本" }],
    coverage: { coverageRatio: 0.421, implFilesAssembled: 12, implFilesTotal: 28, partitionsCapped: false },
  });
}

describe("product overview rendering (Specsight 原则版式)", () => {
  it("renders ask box, release timeline, capabilities and trust line without architecture content", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: completeOverview() }));
    // 简介与 ✎ 编辑移到页头（单头部整合）；总览从提问框开始
    expect(html).toContain("代码生成 · 1 个证据文件");
    // 建议问法从产品能力名生成（检索必命中自己）
    expect(html).toContain("产品分析 是怎么工作的？");
    expect(html).toContain("发布时间线");
    expect(html).toContain('href="?view=changes#release-8"');
    expect(html).toContain("产品分析");
    // 发布时间线标题优先用合成 headline，commit 标题仅作回退
    expect(html).toContain("首个公开版本");
    expect(html).not.toContain(">首版</a>");
    expect(html).toContain("overview-trust-line");
    expect(html).toContain("42.1%");
    expect(html).not.toContain("架构");
    expect(html).not.toContain("/architecture/");
  });

  it("timeline shows one line per release and never dumps per-scenario entries (合并发布)", () => {
    const data = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [{ id: 1, name: "A", summary: "", parentId: null, source: "generated" }],
      scenarios: [],
      releases: [{ id: 8, title: "首版", summary: "一次推送中的全部提交都会进入发布说明。", sha: "abcdef123456", url: "", committedAt: new Date("2026-11-01"), specVersionId: 8 }],
      behaviorChanges: [
        { id: 1, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "A", scenarioReference: "HP-1", summary: "场景更新一", before: {}, after: {} },
        { id: 2, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "A", scenarioReference: "HP-2", summary: "场景更新二", before: {}, after: {} },
      ],
      latestRun: { status: "succeeded" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    const timeline = html.slice(html.indexOf("overview-timeline"), html.indexOf("当前核心能力"));
    expect(timeline).toContain("一次推送中的全部提交都会进入发布说明。");
    // 时间线是一句话投影：不逐条罗列场景级变化
    expect(timeline).not.toContain("场景更新一");
    expect(html).not.toContain("不应显示");
  });

  it("renders an empty product without crash", () => {
    const data = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [], releases: [], behaviorChanges: [], latestRun: { status: "running" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("尚无功能规格");
    expect(html).not.toContain("尚未生成架构文档");
    expect(html).toContain("证据覆盖率 —");
  });

  it("renders quiet releases in the timeline (release happened, nothing changed)", () => {
    const data = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [{ id: 9, title: "多提交 push 分析纳入全部提交标题", summary: "一次推送中的全部提交都会进入发布说明。", sha: "809a5b5ffff", url: "", committedAt: new Date("2026-11-06"), specVersionId: 8 }],
      behaviorChanges: [{ id: 4, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "旧发布", scenarioReference: "HP-1", summary: "挂在旧版本上的变化，不应显示", before: {}, after: {} }],
      latestRun: { status: "succeeded" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("多提交 push 分析纳入全部提交标题");
    expect(html).not.toContain("不应显示");
  });

  it("renders manual capabilities and a zero version defensively", () => {
    const data = completeOverview();
    data.capabilities[0].source = "manual";
    data.trust.specVersionId = 0;
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("人工维护");
    expect(html).toContain("Spec v0");
  });

  it("aggregates latest-release changes per feature in the overview data (供发布产品对话框勾选)", () => {
    const data = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [{ id: 10, title: "v2", summary: "", sha: "1234567890ab", url: "", committedAt: new Date("2026-11-07"), specVersionId: 10 }],
      behaviorChanges: [
        { id: 1, releaseId: 10, kind: "changed", entityType: "feature", featureName: "甲功能", scenarioReference: "", summary: "更早记录的更新", before: {}, after: {} },
        { id: 2, releaseId: 10, kind: "added", entityType: "feature", featureName: "乙功能", scenarioReference: "", summary: "新增能力", before: null, after: {} },
        { id: 3, releaseId: 10, kind: "removed", entityType: "feature", featureName: "丙功能", scenarioReference: "", summary: "移除能力", before: {}, after: null },
        { id: 4, releaseId: 10, kind: "changed", entityType: "scenario", featureName: "丁功能", scenarioReference: "HP-1", summary: "场景更新", before: {}, after: {} },
      ],
      latestRun: { status: "succeeded" },
    });
    expect(data.changes.map((change) => change.id)).toEqual([2, 3, 1]);
    expect(data.changeStats).toEqual({ added: 1, removed: 1, changed: 2 });
    // 发布产品对话框按功能勾选：changeGroups 供 feature 级复选框
    expect(data.changeGroups).toHaveLength(4);
    expect(Object.fromEntries(data.changeGroups.map((group) => [group.featureName, { added: group.added, changed: group.changed, removed: group.removed }]))).toMatchObject({
      "甲功能": { added: 0, changed: 1, removed: 0 },
      "乙功能": { added: 1, changed: 0, removed: 0 },
      "丙功能": { added: 0, changed: 0, removed: 1 },
      "丁功能": { added: 0, changed: 1, removed: 0 },
    });
  });
});

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
    // 覆盖率统一字节口径（设计 §9.1）：字节比例与文件数量是两个并排事实，不合成第二个百分比
    expect(html).toContain("源码装配覆盖率（按文件字节）42.1%");
    expect(html).toContain("已装配实现文件 12/28 个");
    expect(html).toContain("证据文件");
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
    expect(html).toContain("源码装配覆盖率 —");
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

  it("collapses consecutive quiet releases with a truthful label and keeps each release expandable (审计语义)", () => {
    const quiet = (id: number, title: string) => ({ id, title, summary: `${title}的摘要。`, sha: `sha${id}abcdef`, url: "", committedAt: new Date("2026-11-10"), specVersionId: 8 });
    const data = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [quiet(12, "文档更新"), quiet(11, "依赖升级"), { id: 10, title: "行为版本", summary: "有行为变化的发布。", sha: "sha10abcde", url: "", committedAt: new Date("2026-11-08"), specVersionId: 8 }],
      behaviorChanges: [{ id: 4, releaseId: 10, kind: "changed", entityType: "scenario", featureName: "A", scenarioReference: "HP-1", summary: "场景更新", before: {}, after: {} }],
      latestRun: { status: "succeeded" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data }));
    expect(html).toContain("2 次提交均未发现规格行为变化 · 展开提交记录");
    // 展开后每条原始发布完整保留（标题 + 深链），不做字符串匹配折叠
    expect(html).toContain("文档更新");
    expect(html).toContain("依赖升级");
    expect(html).toContain('href="?view=changes#release-12"');
    expect(html).toContain('href="?view=changes#release-10"');
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

describe("product overview task-oriented panels (设计 §4-§7)", () => {
  const quiet = buildProductOverview({
    productBase: "/products/default/radar",
    product: { id: 1, slug: "radar", name: "Radar", description: "" },
    features: [], scenarios: [],
    releases: [
      { id: 12, title: "文档与依赖整理", summary: "本次发布只包含文档与依赖整理。", sha: "sha12abcde", url: "", committedAt: new Date("2026-11-10"), specVersionId: 8 },
      { id: 9, title: "导出功能增强", summary: "导出格式支持自定义字段。", sha: "sha9abcde1", url: "", committedAt: new Date("2026-11-05"), specVersionId: 8 },
    ],
    behaviorChanges: [{ id: 4, releaseId: 9, kind: "changed", entityType: "scenario", featureName: "导出", scenarioReference: "HP-1", summary: "导出字段扩展", before: {}, after: {} }],
    changes: [{ id: 20, releaseId: 9, featureName: "导出", kind: "changed", description: "", userImpact: "导出文件新增可选字段，旧脚本不受影响。", evidence: [] }],
    latestRun: { status: "succeeded" },
  });

  it("renders latest-release user impacts with the release identity and deep links", () => {
    const impacts = buildProductOverview({
      productBase: "/products/default/radar",
      product: { id: 1, slug: "radar", name: "Radar", description: "" },
      features: [], scenarios: [],
      releases: [{ id: 12, title: "导出功能增强", summary: "导出格式支持自定义字段。", sha: "sha12abcde", url: "", committedAt: new Date("2026-11-10"), specVersionId: 8 }],
      behaviorChanges: [],
      changes: [{ id: 30, releaseId: 12, featureName: "导出", kind: "changed", description: "", userImpact: "导出文件新增可选字段，旧脚本不受影响。", evidence: [] }],
      latestRun: { status: "succeeded" },
    });
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: impacts }));
    expect(html).toContain("本次发布对用户的影响");
    expect(html).toContain("导出功能增强");
    expect(html).toContain("导出文件新增可选字段，旧脚本不受影响。");
    expect(html).toContain('href="?view=changes#release-12"');
  });

  it("renders the deterministic fallback for a quiet release and never borrows earlier impacts", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: quiet }));
    expect(html).toContain("本次未发现规格行为变化");
    expect(html).not.toContain("导出文件新增可选字段");
    // 历史发布导航必须显式带日期与发布身份，不与「本次发布」混称
    expect(html).toContain("最近一次有行为变化的发布");
    expect(html).toContain("导出功能增强");
    expect(html).toContain("11月5日");
    expect(html).toContain('href="?view=changes#release-9"');
  });

  it("renders task entries with real links and honest disabled states", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: quiet }));
    expect(html).toContain("这个产品现在能做什么？");
    expect(html).toContain("这次发布改变了什么？");
    expect(html).toContain('href="/products/default/radar?view=changes#release-12"');
    // 无回归任务 → 真实禁用原因，不是死链
    expect(html).toContain("最新发布暂无回归建议");
    expect(html).not.toContain("这次建议重新验证什么？</a>");
  });

  it("orders user impact before ask and timeline (设计 §4 信息顺序)", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: quiet }));
    const impactAt = html.indexOf("本次发布");
    const askAt = html.indexOf("规格问答");
    const timelineAt = html.indexOf("发布时间线");
    expect(impactAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(impactAt);
    expect(timelineAt).toBeGreaterThan(askAt);
  });
});

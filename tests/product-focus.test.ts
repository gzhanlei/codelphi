import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildProductFocus } from "../lib/product-focus";
import { ProductFocus } from "../components/product-focus";

const base = {
  productBase: "/products/default/radar",
  product: { id: 1, slug: "radar", name: "Radar", description: "" },
  releases: [{ id: 8, title: "v1", summary: "release", sha: "abc", url: "", committedAt: new Date("2026-11-08"), specVersionId: 8 }],
  latestRun: { status: "succeeded" },
};

function feature(id: number, name: string, options: Record<string, unknown> = {}) {
  return { id, name, summary: `${name}说明`, parentId: null, source: "generated" as const, ...options };
}

describe("product focus projection", () => {
  it("separates substantive attention from routine confirmation", () => {
    const result = buildProductFocus({
      ...base,
      features: [
        feature(1, "支付权限", { source: "manual", staleSince: new Date("2026-11-01"), verifiedAt: new Date("2026-10-01") }),
        feature(2, "普通描述"),
        feature(3, "功能三"),
        feature(4, "功能四"),
      ],
      scenarios: [{ id: 20, featureId: 2, reference: "HP-1", context: "用户", action: "使用", outcome: "完成", category: "happy", source: "generated", evidence: [] }],
      behaviorChanges: [],
    });
    expect(result.attention.map((item) => item.featureName)).toEqual(["支付权限"]);
    expect(result.confirmations.map((item) => item.featureName)).toEqual(["普通描述", "功能三", "功能四"]);
    expect(result.emptyAttention).toBe(false);
  });

  it("uses canonical names for risk filtering while rendering curated names", () => {
    const result = buildProductFocus({
      ...base,
      features: [feature(1, "组织隔离与权限", { displayName: "团队空间", staleSince: new Date("2026-11-01") })],
      scenarios: [],
      behaviorChanges: [],
    });
    expect(result.attention.map((item) => item.featureName)).toEqual(["团队空间"]);
  });

  it("limits important changes and preserves evidence for progressive disclosure", () => {
    const result = buildProductFocus({
      ...base,
      features: [feature(1, "功能")],
      scenarios: [],
      changes: [{ id: 30, releaseId: 8, featureName: "功能", kind: "changed", description: "", userImpact: "新的导出方式", evidence: [{ path: "lib/export.ts", startLine: 9 }] }],
      behaviorChanges: [{ id: 31, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "功能", scenarioReference: "HP-1", summary: "更新导出", before: {}, after: { evidence: [{ path: "lib/export.ts", startLine: 9 }] } }],
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].summary).toBe("新的导出方式");
    expect(result.changes[0].evidencePaths).toEqual(["lib/export.ts"]);
  });

  it("groups scenario changes into one card per feature without losing their summaries or evidence", () => {
    const result = buildProductFocus({
      ...base,
      features: [feature(1, "导出"), feature(2, "搜索")],
      scenarios: [],
      behaviorChanges: [
        { id: 31, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "导出", scenarioReference: "HP-1", summary: "更新导出", before: {}, after: { evidence: [{ path: "lib/export.ts", startLine: 9 }] } },
        { id: 32, releaseId: 8, kind: "added", entityType: "scenario", featureName: "导出", scenarioReference: "HP-2", summary: "新增批量导出", before: null, after: { evidence: [{ path: "lib/export.ts", startLine: 9 }, { path: "lib/batch.ts", startLine: 12 }] } },
        { id: 33, releaseId: 8, kind: "added", entityType: "scenario", featureName: "搜索", scenarioReference: "HP-1", summary: "新增搜索", before: null, after: { evidence: [{ path: "lib/search.ts", startLine: 4 }] } },
      ],
    });
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({
      featureName: "导出",
      groupLabel: "新增 1 · 更新 1",
      summaries: ["更新导出", "新增批量导出"],
      evidencePaths: ["lib/export.ts", "lib/batch.ts"],
    });
    expect(result.changes[1].featureName).toBe("搜索");
  });

  it("groups a batch of manual copy edits into one item so release changes remain visible", () => {
    const result = buildProductFocus({
      ...base,
      features: [
        feature(1, "功能甲", { displayName: "能力甲", lastEditedAt: new Date("2026-11-09") }),
        feature(2, "功能乙", { displayName: "能力乙", lastEditedAt: new Date("2026-11-09") }),
        feature(3, "功能丙"),
      ],
      scenarios: [],
      behaviorChanges: [{ id: 31, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "功能丙", scenarioReference: "HP-1", summary: "更新功能丙", before: {}, after: { evidence: [] } }],
    });
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({ featureName: "2 项产品知识维护", summaries: ["能力甲：功能甲说明", "能力乙：功能乙说明"] });
    expect(result.changes[1].featureName).toBe("功能丙");
  });

  it("uses an honest empty state when there is no substantive attention", () => {
    const result = buildProductFocus({ ...base, features: [feature(1, "普通功能")], scenarios: [], behaviorChanges: [] });
    expect(result.attention).toEqual([]);
    expect(result.emptyAttention).toBe(true);
  });

  it("uses curated display names without changing analysis identities", () => {
    const result = buildProductFocus({
      ...base,
      features: [feature(1, "technical_name", { displayName: "最近 30 天产品进展", summary: "查看产品最近新增和改变的能力。" })],
      scenarios: [],
      behaviorChanges: [{ id: 31, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "technical_name", scenarioReference: "HP-1", summary: "更新产品进展", before: {}, after: { evidence: [] } }],
    });
    expect(result.changes[0].featureName).toBe("最近 30 天产品进展");
    expect(result.confirmations[0].featureName).toBe("最近 30 天产品进展");
  });
});

describe("product focus rendering", () => {
  it("uses native details for progressive evidence and leaves core capabilities to the shared card panel", () => {
    const result = buildProductFocus({
      ...base,
      features: [feature(1, "普通功能")],
      scenarios: [],
      behaviorChanges: [{ id: 31, releaseId: 8, kind: "changed", entityType: "feature", featureName: "普通功能", scenarioReference: "", summary: "更新普通功能", before: {}, after: { evidence: [] } }],
    });
    const html = renderToStaticMarkup(createElement(ProductFocus, { data: result }));
    expect(html).toContain("<details");
    expect(html).toContain("当前没有需要重点关注的变化");
    expect(html).toContain("含 AI 提取的候选变化；全部内容需人工确认");
    expect(html).not.toContain("部分产品能力");
    expect(html).not.toContain("当前核心能力");
    expect(html).toContain("查看全部产品信息");
  });
});

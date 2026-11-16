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
  it("limits the default map and separates substantive attention from routine confirmation", () => {
    const result = buildProductFocus({
      ...base,
      features: [
        feature(1, "支付权限", { source: "manual", staleSince: new Date("2026-11-01"), verifiedAt: new Date("2026-10-01") }),
        feature(2, "普通描述"),
        feature(3, "功能三"),
        feature(4, "功能四"),
        feature(5, "功能五"),
        feature(6, "功能六"),
      ],
      scenarios: [{ id: 20, featureId: 2, reference: "HP-1", context: "用户", action: "使用", outcome: "完成", category: "happy", source: "generated", evidence: [] }],
      behaviorChanges: [],
    });
    expect(result.map).toHaveLength(5);
    expect(result.map[0].name).toBe("支付权限");
    expect(result.attention.map((item) => item.featureName)).toEqual(["支付权限"]);
    expect(result.confirmations.map((item) => item.featureName)).toEqual(["普通描述", "功能三", "功能四"]);
    expect(result.emptyAttention).toBe(false);
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

  it("uses an honest empty state when there is no substantive attention", () => {
    const result = buildProductFocus({ ...base, features: [feature(1, "普通功能")], scenarios: [], behaviorChanges: [] });
    expect(result.attention).toEqual([]);
    expect(result.emptyAttention).toBe(true);
  });
});

describe("product focus rendering", () => {
  it("uses native details for progressive evidence and shows the empty attention state", () => {
    const result = buildProductFocus({ ...base, features: [feature(1, "普通功能")], scenarios: [], behaviorChanges: [] });
    const html = renderToStaticMarkup(createElement(ProductFocus, { data: result }));
    expect(html).toContain("<details");
    expect(html).toContain("当前没有需要重点关注的变化");
    expect(html).toContain("查看全部产品信息");
  });
});

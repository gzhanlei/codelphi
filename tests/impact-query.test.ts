import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImpactResult, type ImpactFeatureImpact } from "../components/impact-query";

const affected: ImpactFeatureImpact[] = [
  {
    featureId: 400,
    feature: "AI 规格分析与发布变化",
    scenarios: [
      { reference: "EC-1", evidencePath: "instrumentation.ts", context: "服务重启导致分析中断", action: "应用启动", outcome: "恢复在途 running run 并重新排队派发" },
      { reference: "HP-2", evidencePath: "lib/ai.ts", context: null, action: null, outcome: null },
    ],
  },
  { featureId: 231, feature: "产品总览与产品页", scenarios: [{ reference: null, evidencePath: "app/globals.css", context: null, action: null, outcome: null }] },
  { featureId: null, feature: "已退役功能", scenarios: [{ reference: "HP-1", evidencePath: "lib/gone.ts", context: null, action: null, outcome: null }] },
];

describe("ImpactResult", () => {
  it("renders scenario behavior in readable form instead of bare references", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("EC-1");
    expect(html).toContain("服务重启导致分析中断 → 应用启动 → 恢复在途 running run 并重新排队派发");
    expect(html).toContain("证据 instrumentation.ts");
    expect(html).toContain("HP-2");
  });

  it("links features by their live spec page id", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("/products/codelphi?view=spec&amp;feature=400");
    expect(html).toContain("/products/codelphi?view=spec&amp;feature=231");
  });

  it("shows retired features without a link", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).not.toContain("feature=null");
    expect(html).toContain("已退役功能");
  });

  it("shows scenario-less features without a fake reference", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("整功能受影响");
    expect(html).toContain("证据 app/globals.css");
  });

  it("falls back to the evidence path when the scenario has no recorded behavior", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("lib/gone.ts");
  });

  it("states when no spec entry matches the given files", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected: [] }));
    expect(html).toContain("这些文件没有命中任何规格场景");
  });
});

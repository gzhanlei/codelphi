import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImpactResult, type ImpactFeatureImpact } from "../components/impact-query";

const affected: ImpactFeatureImpact[] = [
  { featureId: 400, feature: "QA 回归清单", scenarios: [
    { reference: "HP-2", evidencePath: "components/release-card.tsx" },
    { reference: "HP-1", evidencePath: "components/product-changes.tsx" },
  ] },
  { featureId: 231, feature: "产品总览与产品页", scenarios: [{ reference: null, evidencePath: "app/globals.css" }] },
];

describe("ImpactResult", () => {
  it("lists affected features with clickable scenario links", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("QA 回归清单");
    expect(html).toContain("/products/codelphi?view=spec&amp;feature=400");
    expect(html).toContain("HP-2");
    expect(html).toContain("HP-1");
    expect(html).toContain("产品总览与产品页");
  });

  it("shows scenario-less features without a fake reference", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected }));
    expect(html).toContain("整功能受影响（证据路径命中）");
  });

  it("states when no spec entry matches the given files", () => {
    const html = renderToStaticMarkup(createElement(ImpactResult, { slug: "codelphi", affected: [] }));
    expect(html).toContain("这些文件没有命中任何规格场景");
  });
});

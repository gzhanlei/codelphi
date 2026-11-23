import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PresentationSettings } from "../components/presentation-settings";
import type { ProductPresentationRow } from "../lib/product-presentation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** 设置页「理解层」卡片：只展示落库状态，编辑者才有「重新生成」入口。 */

function row(overrides: Partial<ProductPresentationRow> = {}): ProductPresentationRow {
  return {
    productId: 4,
    specVersionId: 8,
    language: "zh-CN",
    status: "generated",
    source: "generated",
    capabilities: [],
    journeys: [{ id: "journey-1", name: "登录后查看规格", tier: "headline", capabilityName: null, steps: [] }],
    coverage: { featuresTotal: 30, featuresInJourneys: 12, scenariosInJourneys: 9 },
    fingerprint: "f".repeat(64),
    pending: false,
    refreshing: false,
    modelName: null,
    passes: 4,
    lastError: null,
    generatedAt: new Date("2026-11-23T02:00:00Z"),
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof PresentationSettings>[0]> = {}) {
  return renderToStaticMarkup(createElement(PresentationSettings, { slug: "radar", presentation: null, hasFeatures: true, canEdit: false, ...props }));
}

describe("presentation settings card", () => {
  it("offers regeneration to editors only when the product has a spec", () => {
    expect(render({ canEdit: true })).toContain("重新生成");
    expect(render({ canEdit: true, presentation: row() })).toContain("重新生成");
    expect(render({ canEdit: false, presentation: row() })).not.toContain("重新生成");
    expect(render({ canEdit: true, hasFeatures: false })).not.toContain("重新生成");
  });

  it("reports the stored facts without inventing any", () => {
    const html = render({ presentation: row() });
    expect(html).toContain("理解层");
    expect(html).toContain("已生成");
    expect(html).toContain("12/30");
    expect(html).not.toContain("最近错误");
  });

  it("names each state a maintainer can act on", () => {
    expect(render({ presentation: null })).toContain("尚未生成");
    expect(render({ presentation: row({ refreshing: true }) })).toContain("正在生成");
    expect(render({ presentation: row({ pending: true }) })).toContain("规格已变化，等待刷新");
    expect(render({ presentation: row({ status: "partial" }) })).toContain("已生成（不完整）");
    // 生成失败时保留技术原文供排查（设置页是维护者面）
    const failed = render({ presentation: row({ status: "failed", lastError: "AI gateway returned HTTP 502" }) });
    expect(failed).toContain("生成失败");
    expect(failed).toContain("最近错误");
    expect(failed).toContain("AI gateway returned HTTP 502");
  });

  it("renders in English without leaking Chinese in the en locale", () => {
    const html = render({ presentation: row({ journeys: [] }), canEdit: true, locale: "en" });
    expect(html).toContain("Understanding layer");
    expect(html).toContain("Regenerate");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    expect(render({ presentation: row({ status: "failed", lastError: "boom", journeys: [] }), locale: "en" })).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

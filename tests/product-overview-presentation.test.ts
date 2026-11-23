import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProductOverview } from "../components/product-overview";
import { buildProductOverview } from "../lib/product-overview";
import type { PresentationJourney, ProductPresentationRow } from "../lib/product-presentation";
import type { FeatureRow, ScenarioRow } from "../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/** 产品理解层落到总览页（migration 083）：能力卡取值链、典型使用场景精简卡。 */

const base = "/products/default/radar";
const leafFeatures: FeatureRow[] = [
  { id: 1, name: "登录", displayName: "", summary: "OAuth 登录", parentId: null, source: "generated" },
  { id: 2, name: "规格", summary: "功能规格", parentId: null, source: "manual" },
  { id: 3, name: "发布", summary: "发布说明", parentId: null, source: "generated" },
];
const happyScenarios: ScenarioRow[] = [
  { id: 11, featureId: 1, reference: "HP-1", context: "访客打开登录页", action: "扫码授权", outcome: "进入工作台", category: "happy", source: "generated", evidence: [{ path: "app/login.ts", startLine: 20 }] },
  { id: 21, featureId: 2, reference: "HP-1", context: "在工作台里", action: "打开产品规格", outcome: "看到功能清单", category: "happy", source: "manual", evidence: [{ path: "app/spec.ts", startLine: 5 }] },
  { id: 31, featureId: 3, reference: "HP-1", context: "有新发布", action: "打开发布稿", outcome: "看到本次变化", category: "happy", source: "generated", evidence: [{ path: "app/notes.ts", startLine: 9 }] },
];

function journey(order: number, name: string, tier: PresentationJourney["tier"], refs: Array<[string, string]>, capabilityName: string | null = null): PresentationJourney {
  return { id: `journey-${order}`, name, tier, capabilityName, steps: refs.map(([featureName, reference]) => ({ featureName, reference })) };
}

function presentationRow(journeys: PresentationJourney[], capabilities: ProductPresentationRow["capabilities"] = [{ id: "capability-1", name: "账户与规格", summary: "登录后查看产品规格", featureNames: ["登录", "规格"] }]): ProductPresentationRow {
  return {
    productId: 1,
    specVersionId: 8,
    language: "zh-CN",
    status: "generated",
    source: "generated",
    capabilities,
    journeys,
    coverage: { featuresTotal: 3, featuresInJourneys: 2, scenariosInJourneys: 2 },
    fingerprint: "f".repeat(64),
    pending: false,
    refreshing: false,
    modelName: null,
    passes: 3,
    lastError: null,
    generatedAt: new Date("2026-11-23T02:00:00Z"),
  };
}

function build(overrides: Partial<Parameters<typeof buildProductOverview>[0]> = {}, locale: "zh-CN" | "en" = "zh-CN") {
  return buildProductOverview({ productBase: base, product: { id: 1, slug: "radar", name: "Radar", description: "产品知识中心" }, features: leafFeatures, scenarios: happyScenarios, releases: [], behaviorChanges: [], latestRun: { status: "succeeded" }, ...overrides }, locale);
}

describe("overview capability sourcing chain", () => {
  it("keeps flat feature cards when the product has no presentation", () => {
    const overview = build();
    expect(overview.presentation).toBeNull();
    expect(overview.capabilities.map((card) => card.origin)).toEqual(["flat", "flat", "flat"]);
    expect(overview.capabilities.map((card) => card.name).sort()).toEqual(["发布", "登录", "规格"].sort());
    expect(overview.journeyHighlights).toEqual([]);
    expect(overview.journeyTotal).toBe(0);
  });

  it("shows AI-summarized capability groups for products without human business domains", () => {
    const overview = build({ presentation: presentationRow([journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]])]) });
    expect(overview.capabilities).toHaveLength(1);
    expect(overview.capabilities[0]).toMatchObject({ origin: "ai", name: "账户与规格", summary: "登录后查看产品规格", scenarioCount: 2, featureCount: 2, href: `${base}?view=journeys#capability-1` });
    expect(overview.capabilities[0].members?.map((member) => [member.id, member.displayName])).toEqual([[1, "登录"], [2, "规格"]]);
    // 使用场景视图与总览共用同一次投影
    expect(overview.presentation?.capabilities[0].id).toBe("capability-1");
    expect(overview.presentation?.intactJourneys.map((item) => item.name)).toEqual(["登录后查看规格"]);
  });

  it("prefers human business domains over AI groups even when a presentation exists", () => {
    const grouped: FeatureRow[] = [
      { id: 20, name: "客户沟通", displayName: "沟通域", summary: "沟通域简介", parentId: null, source: "manual" },
      { id: 1, name: "登录", summary: "OAuth 登录", parentId: 20, source: "generated" },
      { id: 2, name: "规格", summary: "功能规格", parentId: 20, source: "manual" },
    ];
    const overview = build({ features: grouped, presentation: presentationRow([journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]])]) });
    expect(overview.capabilities.map((card) => [card.name, card.origin])).toEqual([["沟通域", "domains"]]);
    // 能力卡用人工业务域，使用场景照常展示
    expect(overview.journeyHighlights.map((item) => item.name)).toEqual(["登录后查看规格"]);
  });

  it("drops AI groups whose members no longer resolve and falls back to flat cards when none survive", () => {
    const vanished = presentationRow([], [{ id: "capability-1", name: "已失效分组", summary: "成员都没了", featureNames: ["已被删除的功能"] }]);
    const overview = build({ presentation: vanished });
    expect(overview.capabilities.map((card) => card.origin)).toEqual(["flat", "flat", "flat"]);
    const partial = build({ presentation: presentationRow([], [
      { id: "capability-1", name: "只剩一个成员", summary: "s", featureNames: ["已被删除的功能", "发布"] },
      { id: "capability-2", name: "空壳", summary: "s", featureNames: ["也没有了"] },
    ]) });
    expect(partial.capabilities.map((card) => [card.name, card.members?.map((member) => member.name)])).toEqual([["只剩一个成员", ["发布"]]]);
  });
});

describe("overview journey highlights", () => {
  it("puts the headline journey first, caps at three and links each card to its full view", () => {
    const journeys = [
      journey(1, "深挖旅程甲", "capability", [["登录", "HP-1"], ["发布", "HP-1"]], "账户与规格"),
      journey(2, "全局典型", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
      journey(3, "深挖旅程乙", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], "账户与规格"),
      journey(4, "深挖旅程丙", "capability", [["登录", "HP-1"], ["发布", "HP-1"]], "其他"),
    ];
    const overview = build({ presentation: presentationRow(journeys) });
    expect(overview.journeyHighlights.map((item) => [item.id, item.name])).toEqual([["journey-2", "全局典型"], ["journey-1", "深挖旅程甲"], ["journey-3", "深挖旅程乙"]]);
    expect(overview.journeyHighlights[0]).toMatchObject({ startingPoint: "访客打开登录页", finalOutcome: "看到功能清单", stepCount: 2, featureCount: 2, href: `${base}?view=journeys#journey-2` });
    expect(overview.journeyTotal).toBe(4);
  });

  it("never highlights a journey whose referenced scenarios changed", () => {
    const stale = [journey(1, "引用已失效", "headline", [["登录", "HP-1"], ["已被删除的功能", "HP-1"]]), journey(2, "完好旅程", "headline", [["登录", "HP-1"], ["规格", "HP-1"]])];
    const overview = build({ presentation: presentationRow(stale) });
    expect(overview.journeyHighlights.map((item) => item.name)).toEqual(["完好旅程"]);
    expect(overview.journeyTotal).toBe(1);
    expect(overview.presentation?.staleJourneys).toHaveLength(1);
  });
});

describe("overview rendering with the understanding layer", () => {
  const withJourneys = () => build({ presentation: presentationRow([
    journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
    journey(2, "从规格到发布", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], "账户与规格"),
  ]) });

  it("renders AI capability cards with their source label and member features", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: withJourneys() }));
    expect(html).toContain("账户与规格");
    expect(html).toContain("AI 归纳");
    expect(html).toContain("尚未经人工确认");
    expect(html).toContain(`${base}?view=journeys#capability-1`);
    expect(html).toContain("查看成员功能");
    // 静态标记里 & 转义为 &amp;
    expect(html).toContain(`${base}?view=spec&amp;feature=1`);
    expect(html).toContain("2 个功能 · 2 个场景");
  });

  it("inserts the journeys panel between capabilities and recent changes", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: withJourneys() }));
    const capabilitiesAt = html.indexOf("当前核心能力");
    const journeysAt = html.indexOf("典型使用场景");
    const focusAt = html.indexOf("最近重要变化");
    expect(capabilitiesAt).toBeGreaterThan(-1);
    expect(journeysAt).toBeGreaterThan(capabilitiesAt);
    expect(focusAt).toBeGreaterThan(journeysAt);
    // 既有版式约束不回归：能力标题只出现一次；任务入口在规格问答之前（时间线顺序由带发布的既有用例覆盖）
    expect(html.match(/当前核心能力/g)).toHaveLength(1);
    expect(html.indexOf("你想了解什么？")).toBeLessThan(html.indexOf("规格问答"));
    // 精简卡：起点 → 终点 + 步数，不放完整步骤
    expect(html).toContain("起点");
    expect(html).toContain("访客打开登录页");
    expect(html).toContain("看到功能清单");
    expect(html).toContain("2 步");
    expect(html).toContain("全部使用场景（2）→");
    expect(html).toContain(`${base}?view=journeys#journey-1`);
    expect(html).not.toContain("查看场景：");
  });

  it("omits the journeys panel entirely when there is no intact journey", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: build({ presentation: presentationRow([]) }) }));
    expect(html).not.toContain("典型使用场景");
    expect(html).not.toContain("data-overview-journeys");
  });

  it("renders the new chrome in English without leaking Chinese in the en locale", () => {
    const html = renderToStaticMarkup(createElement(ProductOverview, { data: build({ presentation: presentationRow([
      journey(1, "Sign in and read the spec", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
    ]) }, "en"), locale: "en" }));
    expect(html).toContain("Current capabilities");
    expect(html).toContain("Typical ways to use it");
    expect(html).toContain("AI-summarized");
    expect(html).toContain("Starting point");
    expect(html).toContain("All use cases (1)");
    for (const leaked of ["当前核心能力", "典型使用场景", "起点", "终点", "AI 归纳", "完整能力（规格）", "全部使用场景", "查看成员功能", "尚未经人工确认"]) {
      expect(html, leaked).not.toContain(leaked);
    }
  });
});

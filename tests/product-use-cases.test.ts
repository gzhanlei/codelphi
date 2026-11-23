import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductUseCases } from "../components/product-use-cases";
import { buildProductOverview } from "../lib/product-overview";
import type { PresentationJourney, PresentationJourneyTier, ProductPresentationRow } from "../lib/product-presentation";
import type { FeatureRow, ScenarioRow } from "../lib/types";

/** 使用场景视图（?view=journeys）：旅程叙事、分组锚点、失效披露与真实空态。 */

const base = "/products/default/radar";
const features: FeatureRow[] = [
  { id: 1, name: "登录", summary: "OAuth 登录", parentId: null, source: "generated" },
  { id: 2, name: "规格", summary: "功能规格", parentId: null, source: "manual" },
  { id: 3, name: "发布", summary: "发布说明", parentId: null, source: "generated" },
];
const scenarios: ScenarioRow[] = [
  { id: 11, featureId: 1, reference: "HP-1", context: "访客打开登录页", action: "扫码授权", outcome: "进入工作台", category: "happy", source: "generated", evidence: [{ path: "app/login.ts", startLine: 20, url: "https://github.com/o/r/blob/sha/app/login.ts#L20" }] },
  { id: 21, featureId: 2, reference: "HP-1", context: "在工作台里", action: "打开产品规格", outcome: "看到功能清单", category: "happy", source: "manual", evidence: [{ path: "app/spec.ts", startLine: 5 }] },
  { id: 31, featureId: 3, reference: "HP-1", context: "有新发布", action: "打开发布稿", outcome: "看到本次变化", category: "happy", source: "generated", evidence: [] },
];

function journey(order: number, name: string, tier: PresentationJourneyTier, refs: Array<[string, string]>, capabilityName: string | null = null): PresentationJourney {
  return { id: `journey-${order}`, name, tier, capabilityName, steps: refs.map(([featureName, reference]) => ({ featureName, reference })) };
}

function row(journeys: PresentationJourney[], overrides: Partial<ProductPresentationRow> = {}): ProductPresentationRow {
  return {
    productId: 1,
    specVersionId: 8,
    language: "zh-CN",
    status: "generated",
    source: "generated",
    capabilities: [{ id: "capability-1", name: "账户与规格", summary: "登录后查看产品规格", featureNames: ["登录", "规格"] }],
    journeys,
    coverage: { featuresTotal: 3, featuresInJourneys: 2, scenariosInJourneys: 2 },
    fingerprint: "f".repeat(64),
    pending: false,
    refreshing: false,
    modelName: null,
    passes: 3,
    lastError: null,
    generatedAt: new Date("2026-11-23T02:00:00Z"),
    ...overrides,
  };
}

function view(journeys: PresentationJourney[], overrides: Partial<ProductPresentationRow> = {}, featureRows: FeatureRow[] = features) {
  return buildProductOverview({ productBase: base, product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: featureRows, scenarios, releases: [], behaviorChanges: [], presentation: row(journeys, overrides) }).presentation;
}

function render(props: Partial<Parameters<typeof ProductUseCases>[0]> = {}) {
  return renderToStaticMarkup(createElement(ProductUseCases, { presentation: null, hasFeatures: true, canEdit: false, ...props }));
}

const full = [
  journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
  journey(2, "从规格到发布", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], "账户与规格"),
];

describe("use cases view", () => {
  it("tells each journey as a story from starting point to final outcome with deep links back to the spec", () => {
    const html = render({ presentation: view(full) });
    expect(html).toContain("典型使用场景");
    expect(html).toContain("2 条使用场景 · 覆盖 3/3 个功能");
    expect(html).toContain("AI 归纳 · 只重组已有场景，不新增事实");
    // 起点 → 终点：叙事文字全部来自被引用的场景
    expect(html).toContain("起点");
    expect(html).toContain("访客打开登录页");
    expect(html).toContain("终点");
    expect(html).toContain("看到功能清单");
    // 步骤：序号 + 结果为标题 + 情境/操作，深链落到规格工作台的具体场景（匿名演示访客可走的形态）
    expect(html).toContain("第 1 步");
    expect(html).toContain("进入工作台");
    expect(html).toContain("扫码授权");
    // 静态标记里 & 转义为 &amp;
    expect(html).toContain('href="/products/default/radar?view=spec&amp;feature=1#scenario-HP-1"');
    expect(html).toContain("查看场景：登录 HP-1");
    expect(html).toContain("查看场景：规格 HP-1");
    // 每一步带场景自己的源码证据
    expect(html).toContain('href="https://github.com/o/r/blob/sha/app/login.ts#L20"');
    expect(html).toContain("app/spec.ts");
  });

  it("groups journeys under stable anchors that the overview cards link to", () => {
    const html = render({ presentation: view(full) });
    expect(html).toContain('id="headline"');
    expect(html).toContain("全局典型场景");
    expect(html).toContain('id="capability-1"');
    expect(html).toContain("账户与规格");
    expect(html).toContain('href="#capability-1"');
    // 分组默认展开：深链要直接落到可见的旅程上
    expect(html).toMatch(/<details[^>]*id="capability-1"[^>]*open/);
    expect(html).toContain('id="journey-1"');
    expect(html).toContain('id="journey-2"');
  });

  it("hides the group navigation when there is only one group", () => {
    const html = render({ presentation: view([full[0]]) });
    expect(html).not.toContain("use-cases-nav");
  });

  it("keeps journeys whose scenarios changed in a collapsed refresh group and discloses the hidden ones", () => {
    const html = render({ presentation: view([
      journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
      journey(2, "引用部分失效", "capability", [["登录", "HP-1"], ["已被删除的功能", "HP-1"]], "账户与规格"),
      journey(3, "引用全部失效", "capability", [["没了", "HP-1"], ["也没了", "HP-1"]], "账户与规格"),
    ], { pending: true }) });
    expect(html).toContain("待更新（引用的场景已变更）");
    expect(html).toContain("有 1 步引用的场景在当前规格里已找不到");
    expect(html).toContain("引用的场景已不存在");
    expect(html).toContain("另有 1 条使用场景的引用已全部失效，暂不展示。");
    expect(html).toContain("规格在上次生成后有过变化，使用场景等待刷新。");
    // 失效组默认折叠
    expect(html).toContain('<details class="overview-panel use-case-group use-case-group-stale">');
    expect(html).not.toMatch(/use-case-group-stale" open/);
    // 摘要只计完好的旅程
    expect(html).toContain("1 条使用场景 · 覆盖 2/3 个功能");
  });

  it("labels journeys imported from a Radar snapshot as not independently analyzed", () => {
    expect(render({ presentation: view(full, { source: "ai_snapshot_import" }) })).toContain("来自导入的 Radar 快照，未经服务端独立分析。");
    expect(render({ presentation: view(full) })).not.toContain("Radar 快照");
  });

  it("explains an empty view by its real cause and only offers editors a way out", () => {
    const noSpec = render({ presentation: null, hasFeatures: false, canEdit: true });
    expect(noSpec).toContain("尚无功能规格。生成一次分析后");
    expect(noSpec).not.toContain("?view=settings");

    const notGenerated = render({ presentation: null, canEdit: true });
    expect(notGenerated).toContain("典型使用场景尚未生成：首次分析完成后会自动生成。");
    expect(notGenerated).toContain('href="?view=settings#presentation-settings"');
    expect(render({ presentation: null, canEdit: false })).not.toContain("?view=settings");

    expect(render({ presentation: view([], { status: "failed", refreshing: true }) })).toContain("正在生成典型使用场景");
    expect(render({ presentation: view([], { status: "failed", lastError: "AI gateway returned HTTP 502" }) })).toContain("典型使用场景生成失败：模型服务暂时不可用。");
    expect(render({ presentation: view([], { status: "failed", lastError: "Presentation must cover every existing feature" }) })).toContain("典型使用场景生成失败：原因未记录。");
    expect(render({ presentation: view([], { status: "partial" }) })).toContain("现有场景不足以组成跨功能的使用场景。");
    // 失败的技术原文留在设置页，不直接甩给读者
    expect(render({ presentation: view([], { status: "failed", lastError: "AI gateway returned HTTP 502" }) })).not.toContain("HTTP 502");
  });

  it("renders in English without leaking Chinese chrome in the en locale", () => {
    // 全 ASCII 夹具：页面上出现的任何中文都只能来自界面文案
    const englishFeatures: FeatureRow[] = [
      { id: 1, name: "Sign in", summary: "OAuth sign in", parentId: null, source: "generated" },
      { id: 2, name: "Spec", summary: "Feature spec", parentId: null, source: "manual" },
    ];
    const englishScenarios: ScenarioRow[] = [
      { id: 11, featureId: 1, reference: "HP-1", context: "A visitor opens the sign-in page", action: "Scans the QR code", outcome: "Lands on the dashboard", category: "happy", source: "generated", evidence: [{ path: "app/login.ts", startLine: 20 }] },
      { id: 21, featureId: 2, reference: "HP-1", context: "On the dashboard", action: "Opens the spec", outcome: "Sees the feature list", category: "happy", source: "manual", evidence: [] },
    ];
    const presentation = buildProductOverview({ productBase: base, product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: englishFeatures, scenarios: englishScenarios, releases: [], behaviorChanges: [], presentation: row([journey(1, "Sign in and read the spec", "headline", [["Sign in", "HP-1"], ["Spec", "HP-1"]])], { capabilities: [] }) }, "en").presentation;
    const html = render({ presentation, locale: "en" });
    expect(html).toContain("Typical ways to use it");
    expect(html).toContain("Typical across the product");
    expect(html).toContain("Starting point");
    expect(html).toContain("Final outcome");
    expect(html).toContain("Step 1");
    expect(html).toContain("Open scenario:");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    const empty = render({ presentation: null, canEdit: true, locale: "en" });
    expect(empty).toContain("have not been generated yet");
    expect(empty).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

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

function journey(order: number, name: string, tier: PresentationJourneyTier, refs: Array<[string, string]>, capabilityNames: string[] = []): PresentationJourney {
  return { id: `journey-${order}`, name, tier, capabilityNames, steps: refs.map(([featureName, reference]) => ({ featureName, reference })) };
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
  journey(2, "从规格到发布", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], ["账户与规格"]),
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

  it("renders each journey once and cross-links it from the other groups instead of repeating the card", () => {
    const html = render({ presentation: view([
      // 典型场景经过「账户与规格」里的登录功能：只在全局组完整展示
      journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]], ["账户与规格"]),
      journey(2, "从规格到发布", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], ["账户与规格"]),
    ]) });
    // 生产实测（2026-11-24）：一条多标签旅程在每个相关分组各画一张完整卡，20 条旅程在页面上成了 32 张卡
    expect(html.match(/<details class="journey" id="journey-1"(?: open="")?>/g)).toHaveLength(1);
    expect(html.match(/<details class="journey" id="journey-2"(?: open="")?>/g)).toHaveLength(1);
    expect(html).toContain("2 条使用场景");
    // 途经的能力分组里给的是链接，落点就是那张卡；全局组排在能力组之前
    expect(html).toContain('href="#journey-1"');
    expect(html).toContain("途经这项能力、在别处展示的场景：");
    expect(html.indexOf('id="headline"')).toBeLessThan(html.indexOf('id="capability-1"'));
  });

  it("expands only the first journey on the page and collapses the rest into cards", () => {
    const html = render({ presentation: view([
      journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
      journey(2, "从规格到发布", "capability", [["规格", "HP-1"], ["发布", "HP-1"]], ["账户与规格"]),
      journey(3, "发布后回到登录", "capability", [["发布", "HP-1"], ["登录", "HP-1"]], ["账户与规格"]),
    ]) });
    // 每条使用场景是一个原生 details：页面上第一条默认展开，其余折叠成卡片、点击展开（无 JS 也能用）
    expect(html).toContain('<details class="journey" id="journey-1" open="">');
    expect(html).toContain('<details class="journey" id="journey-2">');
    expect(html).toContain('<details class="journey" id="journey-3">');
    expect(html.match(/class="journey" id="journey-\d+" open/g)).toHaveLength(1);
  });

  it("keeps the name and the start → outcome on a collapsed card so the reader can tell whether to open it", () => {
    const html = render({ presentation: view(full) });
    const collapsed = html.slice(html.indexOf('<details class="journey" id="journey-2">'), html.indexOf("</summary>", html.indexOf('id="journey-2"')));
    expect(collapsed).toContain("<h4>从规格到发布</h4>");
    expect(collapsed).toContain("起点");
    expect(collapsed).toContain("在工作台里");
    expect(collapsed).toContain("终点");
    expect(collapsed).toContain("看到本次变化");
    // 展开状态由 details 自己维护：两段切换文案都在标记里，按 [open] 由 CSS 决定显示哪一段
    expect(collapsed).toContain(">展开<");
    expect(collapsed).toContain(">收起<");
    // 步骤仍在标记里（折叠只是不显示）：链接照样可以被抓取、打印和用键盘到达
    expect(html).toContain('href="/products/default/radar?view=spec&amp;feature=3#scenario-HP-1"');
  });

  it("expands the first journey that is actually rendered, even when it is not a headline one", () => {
    expect(render({ presentation: view([full[1]]) })).toContain('<details class="journey" id="journey-2" open="">');
  });

  it("collapses the journeys kept in the refresh group as well", () => {
    const html = render({ presentation: view([
      full[0],
      journey(2, "引用部分失效", "capability", [["登录", "HP-1"], ["已被删除的功能", "HP-1"]], ["账户与规格"]),
    ]) });
    expect(html).toContain('<details class="journey" id="journey-1" open="">');
    expect(html).toContain('<details class="journey" id="journey-2">');
    expect(html).not.toMatch(/<details class="journey" id="journey-2" open/);
  });

  it("keeps a capability group with only cross-linked journeys reachable from its anchor", () => {
    // 没有任何场景从这项能力出发、只有典型场景途经它：总览能力卡链进来仍要看到落点
    const html = render({ presentation: view([journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]], ["账户与规格"])]) });
    expect(html).toContain('id="capability-1"');
    expect(html).toMatch(/<details[^>]*id="capability-1"[^>]*open/);
    expect(html).toContain('href="#journey-1"');
    // 没有完整卡片时不显示「0 条」
    expect(html).not.toContain(">0<");
  });

  it("folds journeys that only repeat the feature combination of a shown journey and says why", () => {
    const html = render({ presentation: view([
      journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
      // 同一对功能倒着走：读者眼里是同一条
      journey(2, "倒着走的同一走法", "capability", [["规格", "HP-1"], ["登录", "HP-1"]]),
    ]) });
    expect(html).toContain("1 条使用场景");
    expect(html).not.toContain('id="journey-2"');
    // 不静默消失：折叠列出并说明原因
    expect(html).toContain("未展示的场景（较早的生成规则）");
    expect(html).toContain("倒着走的同一走法");
    expect(html).toContain("把同一功能的多条场景首尾相接");
    expect(html).toContain('<details class="overview-panel use-case-group use-case-group-folded">');
    expect(html).not.toMatch(/use-case-group-folded" open/);
  });

  it("keeps journeys whose scenarios changed in a collapsed refresh group and discloses the hidden ones", () => {
    const html = render({ presentation: view([
      journey(1, "登录后查看规格", "headline", [["登录", "HP-1"], ["规格", "HP-1"]]),
      journey(2, "引用部分失效", "capability", [["登录", "HP-1"], ["已被删除的功能", "HP-1"]], ["账户与规格"]),
      journey(3, "引用全部失效", "capability", [["没了", "HP-1"], ["也没了", "HP-1"]], ["账户与规格"]),
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
    // 全 ASCII 夹具：页面上出现的任何中文都只能来自界面文案。带上一条途经能力的典型场景和一条落库数据里的重复条目，
    // 让「链接引用」与「未重复展示」两种新文案的英文都走到。
    const englishFeatures: FeatureRow[] = [
      { id: 1, name: "Sign in", summary: "OAuth sign in", parentId: null, source: "generated" },
      { id: 2, name: "Spec", summary: "Feature spec", parentId: null, source: "manual" },
    ];
    const englishScenarios: ScenarioRow[] = [
      { id: 11, featureId: 1, reference: "HP-1", context: "A visitor opens the sign-in page", action: "Scans the QR code", outcome: "Lands on the dashboard", category: "happy", source: "generated", evidence: [{ path: "app/login.ts", startLine: 20 }] },
      { id: 21, featureId: 2, reference: "HP-1", context: "On the dashboard", action: "Opens the spec", outcome: "Sees the feature list", category: "happy", source: "manual", evidence: [] },
    ];
    const presentation = buildProductOverview({ productBase: base, product: { id: 1, slug: "radar", name: "Radar", description: "" }, features: englishFeatures, scenarios: englishScenarios, releases: [], behaviorChanges: [], presentation: row([
      journey(1, "Sign in and read the spec", "headline", [["Sign in", "HP-1"], ["Spec", "HP-1"]], ["Account"]),
      journey(2, "Read the spec after signing in", "capability", [["Spec", "HP-1"], ["Sign in", "HP-1"]], ["Account"]),
    ], { capabilities: [{ id: "capability-1", name: "Account", summary: "Sign in", featureNames: ["Sign in"] }] }) }, "en").presentation;
    const html = render({ presentation, locale: "en" });
    expect(html).toContain("Typical ways to use it");
    expect(html).toContain("Typical across the product");
    expect(html).toContain("1 use case");
    expect(html).toContain("Also passing through this capability (shown elsewhere):");
    expect(html).toContain("Not shown (from an earlier rule)");
    expect(html).toContain(">Expand<");
    expect(html).toContain(">Collapse<");
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

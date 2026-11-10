import { describe, expect, it } from "vitest";
import {
  buildIntroFactPack,
  buildIntroPrompt,
  parseIntroMaterial,
  renderIntroMaterialHtml,
  renderIntroMaterialMarkdown,
  toConfirmedOutline,
  validateIntroDraft,
  type IntroFactPack,
  type IntroMaterialDraft,
} from "../lib/intro-material";

const factPack: IntroFactPack = {
  productName: "随行智拍",
  description: "面向景区的写真生成小程序",
  descriptionSource: "generated",
  features: [
    { id: 2, name: "订单管理", summary: "下单与支付", scenarioCount: 3, source: "manual" },
    { id: 1, name: "写真生成", summary: "上传自拍生成写真", scenarioCount: 5, source: "generated" },
  ],
  highlights: [{ id: 9, releaseId: 5, featureName: "写真生成", summary: "新增国风模板", highlightType: "News" }],
  latestRelease: { id: 5, title: "国风模板上线", summary: "新增 3 套模板" },
  trust: { featureCount: 2, scenarioCount: 8, manualFeatureCount: 1, manualScenarioCount: 0, evidencePathCount: 6 },
  coverageNote: "证据覆盖率 42.1%（装配 12/28 个实现文件，3 趟提取）",
  positioning: { audience: "景区商户", differentiation: "现场出片快", tone: "克制" },
};

const validDraft: IntroMaterialDraft = {
  specVersionId: 42,
  slides: [
    { slideType: "COVER", section: "", title: "随行智拍：景区现场写真", keyPoints: [], notes: "开场页讲稿。", anchors: [] },
    { slideType: "CONTENT", section: "能力", title: "写真生成", keyPoints: ["上传自拍生成写真"], notes: "能力页讲稿。", anchors: [{ kind: "feature", id: 1 }] },
    { slideType: "BACK_COVER", section: "可信度", title: "来源与口径", keyPoints: ["证据覆盖率 42.1%"], notes: "收尾讲稿。", anchors: [{ kind: "manual", id: 0 }] },
  ],
};

describe("intro material pure core", () => {
  it("builds fact pack: features sorted by scenario count, highlights merged and deduped", () => {
    const pack = buildIntroFactPack({
      product: { name: "随行智拍", description: "面向景区的写真生成小程序", positioning: factPack.positioning },
      features: [
        { id: 1, name: "写真生成", summary: "上传自拍生成写真", source: "generated" },
        { id: 2, name: "订单管理", summary: "下单与支付", source: "manual" },
      ],
      scenarios: [
        { featureId: 1, source: "generated", evidence: [{ path: "a.ts" }] },
        { featureId: 1, source: "generated", evidence: [{ path: "a.ts" }, { path: "b.ts" }] },
        { featureId: 2, source: "manual", evidence: [] },
      ],
      behaviorChanges: [
        { id: 9, releaseId: 5, featureName: "写真生成", summary: "新增国风模板", highlightType: "News", kind: "added" },
        { id: 10, releaseId: 5, featureName: "订单管理", summary: "支付页改版", highlightType: null, kind: "added" },
      ],
      releases: [{ id: 5, title: "国风模板上线", summary: "新增 3 套模板" }],
      coverage: { coverageRatio: 0.421, implFilesAssembled: 12, implFilesTotal: 28, partitionsUsed: 3 },
    });
    expect(pack.features[0].id).toBe(1);
    expect(pack.features[0].scenarioCount).toBe(2);
    expect(pack.highlights.map((change) => change.id)).toEqual([9, 10]);
    expect(pack.trust.manualScenarioCount).toBe(1);
    expect(pack.trust.evidencePathCount).toBe(2);
    expect(pack.coverageNote).toContain("42.1%");
    expect(pack.positioning?.audience).toBe("景区商户");
  });

  it("prompt carries facts, positioning, and hard rules; skip note when positioning missing", () => {
    const prompt = buildIntroPrompt(factPack);
    expect(prompt).toContain("【事实清单】");
    expect(prompt).toContain("景区商户");
    expect(prompt).toContain("只返回 JSON");
    const without = buildIntroPrompt({ ...factPack, positioning: null });
    expect(without).toContain("未提供：跳过差异化页");
  });

  it("parses fenced AI JSON into a draft", () => {
    const content = "```json\n" + JSON.stringify({ slides: validDraft.slides }) + "\n```";
    const draft = parseIntroMaterial(content);
    expect(draft.slides).toHaveLength(3);
    expect(draft.slides[1].anchors).toEqual([{ kind: "feature", id: 1 }]);
  });

  it("validates anchors and PPTCreator hard rules", () => {
    expect(validateIntroDraft(validDraft, factPack).ok).toBe(true);
    const dangling = { ...validDraft, slides: validDraft.slides.map((slide, index) => (index === 1 ? { ...slide, anchors: [{ kind: "feature" as const, id: 999 }] } : slide)) };
    const failed = validateIntroDraft(dangling, factPack);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain("#999");
    const noNotes = { ...validDraft, slides: validDraft.slides.map((slide) => ({ ...slide, notes: "" })) };
    expect(validateIntroDraft(noNotes, factPack).ok).toBe(false);
    const noPoints = { ...validDraft, slides: validDraft.slides.map((slide, index) => (index === 1 ? { ...slide, keyPoints: [], anchors: [{ kind: "feature" as const, id: 1 }] } : slide)) };
    expect(validateIntroDraft(noPoints, factPack).ok).toBe(false);
    const noAnchors = { ...validDraft, slides: validDraft.slides.map((slide, index) => (index === 1 ? { ...slide, anchors: [] } : slide)) };
    expect(validateIntroDraft(noAnchors, factPack).ok).toBe(false);
    const wrongCover = { ...validDraft, slides: [validDraft.slides[1], validDraft.slides[0], validDraft.slides[2]] };
    expect(validateIntroDraft(wrongCover, factPack).ok).toBe(false);
  });

  it("maps to confirmed outline and renders markdown/html exports", () => {
    const outline = toConfirmedOutline(validDraft);
    expect(outline).toEqual([
      { order: 1, type: "COVER", title: "随行智拍：景区现场写真", keyPoints: [], notes: "开场页讲稿。" },
      { order: 2, type: "CONTENT", chapter: "能力", title: "写真生成", keyPoints: ["上传自拍生成写真"], notes: "能力页讲稿。", anchors: undefined },
      { order: 3, type: "BACK_COVER", chapter: "可信度", title: "来源与口径", keyPoints: ["证据覆盖率 42.1%"], notes: "收尾讲稿。", anchors: undefined },
    ].map((slide) => expect.objectContaining({ order: slide.order, type: slide.type, title: slide.title, notes: slide.notes })));
    const markdown = renderIntroMaterialMarkdown({ productName: "随行智拍", draft: validDraft, coverageNote: factPack.coverageNote });
    expect(markdown).toContain("# 随行智拍 介绍大纲");
    expect(markdown).toContain("锚点：feature#1");
    expect(markdown).toContain("42.1%");
    const html = renderIntroMaterialHtml({ productName: "随行智拍", draft: validDraft, coverageNote: factPack.coverageNote });
    expect(html).toContain("<h1>随行智拍 介绍材料</h1>");
    expect(html).toContain("人工核实");
  });
});

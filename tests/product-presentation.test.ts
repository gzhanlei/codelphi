import { describe, expect, it, vi } from "vitest";
import {
  buildPresentationCapabilities,
  buildProductPresentationView,
  loadProductPresentation,
  parsePresentationPayload,
  presentationFingerprint,
  type PresentationJourney,
  type ProductPresentationRow,
} from "../lib/product-presentation";
import type { FeatureRow, ScenarioRow } from "../lib/types";

const features: FeatureRow[] = [
  { id: 1, name: "录音采集", displayName: "录音", summary: "采集面谈录音", parentId: null, source: "generated" },
  { id: 2, name: "转写", summary: "把录音转成文字", parentId: null, source: "generated" },
  { id: 3, name: "AI 复盘", summary: "生成复盘要点", parentId: null, source: "generated" },
  { id: 10, name: "客户沟通", displayName: "沟通域", summary: "与客户沟通相关的功能", parentId: null, source: "manual" },
  { id: 11, name: "速记", summary: "快速记录", parentId: 10, source: "generated" },
];

function scenario(featureId: number, reference: string, category: ScenarioRow["category"] = "happy"): ScenarioRow {
  return { id: featureId * 100 + Number(reference.split("-")[1]), featureId, reference, context: `情境 ${reference}`, action: `操作 ${reference}`, outcome: `结果 ${reference}`, category, source: "generated", evidence: [{ path: "lib/x.ts", startLine: 1 }] };
}

const scenarios: ScenarioRow[] = [scenario(1, "HP-1"), scenario(1, "HP-2"), scenario(2, "HP-1"), scenario(2, "EC-1", "edge"), scenario(3, "HP-1"), scenario(11, "HP-1")];

function row(journeys: Array<Pick<PresentationJourney, "name" | "tier" | "capabilityNames" | "steps">>): ProductPresentationRow {
  return {
    productId: 1,
    specVersionId: 7,
    language: "zh-CN",
    status: "generated",
    source: "generated",
    capabilities: [{ id: "capability-1", name: "沟通域", summary: "", featureNames: ["速记"] }],
    journeys: journeys.map((journey, index) => ({ id: `journey-${index + 1}`, ...journey })),
    coverage: { featuresTotal: 4, featuresInJourneys: 0, scenariosInJourneys: 0 },
    fingerprint: "abc",
    pending: false,
    refreshing: false,
    modelName: null,
    passes: 3,
    lastError: null,
    generatedAt: new Date("2026-11-23T00:00:00Z"),
  };
}

describe("product presentation fingerprint", () => {
  const base = { features: [{ id: 1, name: "A", parentId: null }, { id: 2, name: "B", parentId: 1 }], scenarios: [{ featureId: 1, reference: "HP-1", category: "happy" }], language: "zh-CN" as const };

  it("tracks structure only: names, grouping, scenario identity and language", () => {
    const fingerprint = presentationFingerprint(base);
    // 功能顺序与 id 无关
    expect(presentationFingerprint({ ...base, features: [{ id: 9, name: "B", parentId: 4 }, { id: 4, name: "A", parentId: null }], scenarios: [{ featureId: 4, reference: "HP-1", category: "happy" }] })).toBe(fingerprint);
    expect(presentationFingerprint({ ...base, scenarios: [{ featureId: 1, reference: "HP-2", category: "happy" }] })).not.toBe(fingerprint);
    expect(presentationFingerprint({ ...base, scenarios: [{ featureId: 1, reference: "HP-1", category: "edge" }] })).not.toBe(fingerprint);
    expect(presentationFingerprint({ ...base, features: [{ id: 1, name: "A", parentId: null }, { id: 2, name: "B", parentId: null }] })).not.toBe(fingerprint);
    expect(presentationFingerprint({ ...base, language: "en" })).not.toBe(fingerprint);
  });
});

describe("product presentation payload parsing", () => {
  it("drops malformed entries one by one instead of failing the whole payload", () => {
    const parsed = parsePresentationPayload({
      status: "generated",
      capabilities: [{ name: "有效", summary: "s", featureNames: ["A", "B"] }, { name: "空成员", summary: "s", featureNames: [] }, { summary: "缺名称", featureNames: ["A"] }, null],
      journeys: [
        { name: "跨功能", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: "B", reference: "HP-2" }] },
        { name: "坏步骤被剔除", steps: [{ featureName: "A", reference: "HP-1" }, { featureName: 1, reference: "HP-1" }] },
        { name: "没有步骤", steps: [] },
      ],
      coverage: { featuresTotal: "4", featuresInJourneys: 2 },
    });
    expect(parsed.status).toBe("generated");
    expect(parsed.capabilities.map((capability) => capability.name)).toEqual(["有效"]);
    expect(parsed.capabilities[0].id).toBe("capability-1");
    expect(parsed.journeys).toHaveLength(2);
    expect(parsed.journeys[1].id).toBe("journey-2");
    expect(parsed.journeys[1].steps).toHaveLength(1);
    expect(parsed.coverage).toEqual({ featuresTotal: 4, featuresInJourneys: 2, scenariosInJourneys: 0 });
    expect(parsePresentationPayload(null).status).toBe("failed");
  });

  it("loads a row and normalizes database scalars", async () => {
    const execute = vi.fn(async () => [[{
      product_id: "1", spec_version_id: 7, language: "en", status: "partial", source: "ai_snapshot_import", tagline: null,
      capabilities_json: JSON.stringify([{ name: "Cap", summary: "s", featureNames: ["A"] }]), journeys_json: "[]", coverage_json: null,
      fingerprint: "f", pending: 1, model_name: "m", passes: "4", last_error: null, generated_at: new Date("2026-11-23T00:00:00Z"),
    }]]);
    const loaded = await loadProductPresentation(execute, 1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("FROM product_presentations WHERE product_id = ?"), [1]);
    expect(loaded).toMatchObject({ productId: 1, specVersionId: 7, language: "en", status: "partial", source: "ai_snapshot_import", pending: true, passes: 4, fingerprint: "f" });
    expect(loaded!.capabilities).toHaveLength(1);
    expect(loaded!.journeys).toEqual([]);
    expect(await loadProductPresentation(async () => [[]], 2)).toBeNull();
  });
});

describe("product presentation view", () => {
  const base = "/products/default/radar";

  it("resolves every step to the live scenario with a deep link to the spec view", () => {
    const view = buildProductPresentationView({
      row: row([{ name: "从录音到复盘", tier: "headline", capabilityNames: [], steps: [{ featureName: "录音采集", reference: "HP-2" }, { featureName: "转写", reference: "HP-1" }, { featureName: "AI 复盘", reference: "HP-1" }] }]),
      features,
      scenarios,
      productBase: base,
    });
    const journey = view.intactJourneys[0];
    expect(journey.intact).toBe(true);
    expect(journey.startingPoint).toBe("情境 HP-2");
    expect(journey.finalOutcome).toBe("结果 HP-1");
    expect(journey.featureCount).toBe(3);
    expect(journey.href).toBe(`${base}?view=journeys#journey-1`);
    expect(journey.steps[1].href).toBe(`${base}?view=spec&feature=2#scenario-HP-1`);
    expect(journey.steps[0].featureDisplayName).toBe("录音");
    expect(journey.steps[2].evidence).toEqual([{ path: "lib/x.ts", startLine: 1 }]);
    expect(view.staleJourneys).toEqual([]);
    expect(view.brokenJourneys).toBe(0);
    expect(view.groups.map((group) => group.kind)).toEqual(["headline"]);
  });

  it("tolerates whitespace and case drift in feature names when resolving steps", () => {
    const view = buildProductPresentationView({
      row: row([{ name: "容错解析", tier: "capability", capabilityNames: [], steps: [{ featureName: " 转写 ", reference: "HP-1" }, { featureName: "AI 复盘", reference: "HP-1" }] }]),
      features,
      scenarios,
      productBase: base,
    });
    expect(view.intactJourneys[0].steps[0].featureId).toBe(2);
  });

  it("keeps journeys whose scenarios changed as stale instead of dropping them silently", () => {
    const view = buildProductPresentationView({
      row: row([
        { name: "部分失效", tier: "capability", capabilityNames: ["沟通域"], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "已改名功能", reference: "HP-1" }] },
        { name: "全部失效", tier: "capability", capabilityNames: ["沟通域"], steps: [{ featureName: "不存在", reference: "HP-1" }, { featureName: "也不存在", reference: "HP-2" }] },
        { name: "速记流程", tier: "capability", capabilityNames: ["沟通域"], steps: [{ featureName: "速记", reference: "HP-1" }, { featureName: "录音采集", reference: "HP-1" }] },
      ]),
      features,
      scenarios,
      productBase: base,
    });
    expect(view.intactJourneys.map((journey) => journey.name)).toEqual(["速记流程"]);
    expect(view.staleJourneys.map((journey) => journey.name)).toEqual(["部分失效"]);
    expect(view.staleJourneys[0].intact).toBe(false);
    expect(view.staleJourneys[0].resolvedSteps).toBe(1);
    expect(view.staleJourneys[0].steps[1].href).toBeNull();
    expect(view.brokenJourneys).toBe(1);
    // 分组锚点与总览 AI 能力卡一致：能力分组的 key 就是该能力卡的 id
    // 分组里只放完好旅程；失效的那条只在「待更新」里披露
    expect(view.groups).toEqual([{ kind: "capability", key: "capability-1", name: "沟通域", journeys: view.intactJourneys }]);
    expect(view.capabilities.map((capability) => [capability.id, capability.name])).toEqual([["capability-1", "沟通域"]]);
    // 覆盖率只统计完好旅程，分母排除业务域父节点（分组本身不是可被旅程覆盖的功能）
    expect(view.coverage).toEqual({ featuresTotal: 4, featuresInJourneys: 2, scenariosInJourneys: 2 });
  });

  it("groups headline, per-capability and ungrouped journeys in a stable order", () => {
    const view = buildProductPresentationView({
      row: row([
        { name: "深挖二", tier: "capability", capabilityNames: [], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "转写", reference: "HP-1" }] },
        { name: "全局典型", tier: "headline", capabilityNames: [], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "AI 复盘", reference: "HP-1" }] },
        { name: "未登记的能力", tier: "capability", capabilityNames: ["新分组"], steps: [{ featureName: "转写", reference: "HP-1" }, { featureName: "AI 复盘", reference: "HP-1" }] },
      ]),
      features,
      scenarios,
      productBase: base,
    });
    expect(view.groups.map((group) => [group.kind, group.name])).toEqual([["headline", null], ["capability", "新分组"], ["ungrouped", null]]);
  });

  it("files a journey under every capability it touches, so each capability card has a destination", () => {
    const view = buildProductPresentationView({
      row: row([
        // 跨两个能力的场景：同时出现在两个能力的分组下
        { name: "跨域场景", tier: "capability", capabilityNames: ["采集与转写", "复盘分析"], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "AI 复盘", reference: "HP-1" }] },
        // 全局典型场景既在「全局典型」里，也按它触及的能力归组
        { name: "带标签的典型场景", tier: "headline", capabilityNames: ["采集与转写"], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "转写", reference: "HP-1" }] },
        { name: "只碰未归组功能", tier: "capability", capabilityNames: [], steps: [{ featureName: "录音采集", reference: "HP-1" }, { featureName: "转写", reference: "HP-1" }] },
      ]),
      features,
      scenarios,
      productBase: base,
    });
    const byGroup = Object.fromEntries(view.groups.map((group) => [`${group.kind}:${group.name ?? ""}`, group.journeys.map((journey) => journey.name)]));
    expect(byGroup).toEqual({
      "headline:": ["带标签的典型场景"],
      "capability:采集与转写": ["跨域场景", "带标签的典型场景"],
      "capability:复盘分析": ["跨域场景"],
      "ungrouped:": ["只碰未归组功能"],
    });
    // 首版落库的单标签写法仍然读得出来
    const legacy = parsePresentationPayload({ journeys: [{ name: "旧数据", capabilityName: "复盘分析", steps: [{ featureName: "A", reference: "HP-1" }] }] });
    expect(legacy.journeys[0].capabilityNames).toEqual(["复盘分析"]);
  });
});

describe("presentation capabilities view", () => {
  it("drops member names that no longer resolve and sums scenario counts", () => {
    const capabilities = buildPresentationCapabilities({
      capabilities: [
        { id: "capability-1", name: "采集与转写", summary: "s", featureNames: ["录音采集", "转写", "已被删除的功能"] },
        { id: "capability-2", name: "空壳", summary: "s", featureNames: ["不存在"] },
      ],
      features,
      scenarios,
      productBase: "/products/default/radar",
    });
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0].features.map((feature) => [feature.id, feature.displayName])).toEqual([[1, "录音"], [2, "转写"]]);
    expect(capabilities[0].features[0].href).toBe("/products/default/radar?view=spec&feature=1");
    expect(capabilities[0].scenarioCount).toBe(4);
  });
});

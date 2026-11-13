import { describe, expect, it } from "vitest";
import { diffSpecWithFolded, scenarioVariantSimilar, type SpecFeature, type SpecScenario } from "../lib/spec-diff";
import { mergeChunkResults, type ExtractionChunk } from "../lib/extraction-merge";
import type { AnalysisResult } from "../lib/ai";

/**
 * BM-6 变体通道：run 211/212 实证的变体形态作为 fixtures（同行为不同措辞/角色建条）。
 * 判定口径宁漏勿错合——真差异（行为相反、主体互换、数字/否定冲突）必须全部拒绝。
 */

const mergeVariant: [SpecScenario, SpecScenario] = [
  { reference: "EC-5", category: "edge", context: "匿名演示访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
  { reference: "EC-6", category: "edge", context: "匿名 demo 访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
];

const renumberedVariant: [SpecScenario, SpecScenario] = [
  { reference: "HP-2", category: "edge", context: "匿名演示访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
  { reference: "EC-6", category: "edge", context: "匿名 demo 访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
];

const contextRewordedVariant: [SpecScenario, SpecScenario] = [
  { reference: "HP-3", category: "happy", context: "编辑者打开产品总览页", action: "点击「发布产品」并勾选功能后生成草稿", outcome: "生成发布稿草稿并跳转到发布卡校对发布", evidence: [] },
  { reference: "HP-4", category: "happy", context: "工作区编辑者在总览页且存在可发布功能", action: "点击「发布产品」并勾选功能生成草稿", outcome: "生成发布稿草稿并跳转到发布卡校对发布", evidence: [] },
];

const realChangePair: [SpecScenario, SpecScenario] = [
  { reference: "HP-2", category: "happy", context: "匿名访客打开公开演示产品页", action: "渲染头部操作区", outcome: "同一行内先显示只读演示提示，再显示「登录后可分析」链接", evidence: [] },
  { reference: "EC-1", category: "happy", context: "匿名演示访客打开演示产品页", action: "渲染头部操作区", outcome: "不渲染分析按钮、只读提示与登录链接，页面标记 data-can-edit=false", evidence: [] },
];

const skeletonTrap: [SpecScenario, SpecScenario] = [
  { reference: "ER-1", category: "error", context: "保存简介失败", action: "点击保存", outcome: "跳转 dashboard", evidence: [] },
  { reference: "ER-2", category: "error", context: "保存失败", action: "点击保存", outcome: "锁定账户", evidence: [] },
];

const digitConflict: [SpecScenario, SpecScenario] = [
  { reference: "ER-1", category: "error", context: "请求失败", action: "提交表单", outcome: "返回 404 错误页", evidence: [] },
  { reference: "ER-2", category: "error", context: "请求失败", action: "提交表单", outcome: "返回 400 错误页", evidence: [] },
];

const negationConflict: [SpecScenario, SpecScenario] = [
  { reference: "EC-1", category: "edge", context: "配额不足", action: "点击重试", outcome: "提示可以重试", evidence: [] },
  { reference: "EC-2", category: "edge", context: "配额不足", action: "点击重试", outcome: "提示不可以重试", evidence: [] },
];

const categoryConflict: [SpecScenario, SpecScenario] = [
  { reference: "HP-1", category: "happy", context: "匿名演示访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
  { reference: "EC-5", category: "edge", context: "匿名 demo 访客查看总览页", action: "渲染发布入口", outcome: "不渲染任何发布入口，登录引导集中在顶栏", evidence: [] },
];

describe("scenarioVariantSimilar (BM-6 变体通道)", () => {
  it("folds real variant pairs from run 211/212", () => {
    expect(scenarioVariantSimilar(...mergeVariant)).toBe(true);
    expect(scenarioVariantSimilar(...renumberedVariant)).toBe(true);
    expect(scenarioVariantSimilar(...contextRewordedVariant)).toBe(true);
  });

  it("rejects real behavior changes and classic traps", () => {
    expect(scenarioVariantSimilar(...realChangePair)).toBe(false);
    expect(scenarioVariantSimilar(...skeletonTrap)).toBe(false);
    expect(scenarioVariantSimilar(...digitConflict)).toBe(false);
    expect(scenarioVariantSimilar(...negationConflict)).toBe(false);
    expect(scenarioVariantSimilar(...categoryConflict)).toBe(false);
  });
});

describe("spec-diff variant folding (removed↔added renumbered variants)", () => {
  function featureWith(scenarios: SpecScenario[]): SpecFeature {
    return { name: "产品发布入口", summary: "总览页发布入口", scenarios };
  }

  it("folds a removed↔added renumbered variant pair with reason variant", () => {
    const before = featureWith([
      renumberedVariant[0],
      { reference: "HP-1", category: "happy", context: "编辑者打开产品总览页", action: "点击发布", outcome: "打开发布对话框", evidence: [] },
    ]);
    const after = featureWith([
      { reference: "HP-1", category: "happy", context: "编辑者打开产品总览页", action: "点击发布", outcome: "打开发布对话框", evidence: [] },
      renumberedVariant[1],
    ]);
    const outcome = diffSpecWithFolded([before], [after]);
    expect(outcome.changes).toEqual([]);
    expect(outcome.folded).toHaveLength(1);
    expect(outcome.folded[0]).toMatchObject({ reason: "variant", scenarioReference: "EC-6" });
  });

  it("keeps genuine behavior changes unfoldable", () => {
    const before = featureWith([realChangePair[0]]);
    const after = featureWith([realChangePair[1]]);
    const outcome = diffSpecWithFolded([before], [after]);
    expect(outcome.changes).toHaveLength(2);
    expect(outcome.folded).toEqual([]);
  });
});

describe("extraction-merge variant collapse (single-chunk within-output variants)", () => {
  function resultWith(scenarios: SpecScenario[]): ExtractionChunk {
    const result: AnalysisResult = {
      product: { name: "P", description: "d", evidence: [] },
      release: { title: "t", summary: "s" },
      features: [{ name: "产品发布入口", summary: "总览页发布入口", scenarios }],
      changes: [],
    } as unknown as AnalysisResult;
    return { result };
  }

  it("collapses within-output variants that never pass through cross-chunk merge", () => {
    const merged = mergeChunkResults([resultWith([mergeVariant[0], mergeVariant[1], contextRewordedVariant[0]])]);
    const feature = merged.features.find((candidate) => candidate.name === "产品发布入口");
    // EC-5/EC-6 同行为变体折为一条；HP-3（发布草稿流）与渲染入口是不同行为，保留。
    expect(feature?.scenarios).toHaveLength(2);
    expect(feature?.scenarios.map((scenario) => scenario.reference)).toEqual(["EC-5", "HP-3"]);
    expect(merged.changes).toEqual([]);
  });

  it("keeps genuinely different scenarios in the same feature", () => {
    const merged = mergeChunkResults([resultWith([mergeVariant[0], realChangePair[0]])]);
    const feature = merged.features.find((candidate) => candidate.name === "产品发布入口");
    expect(feature?.scenarios).toHaveLength(2);
  });
});

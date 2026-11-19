import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { mergeBehaviorTaskResults, type BehaviorMergedResult } from "../lib/behavior-result-merge";
import type { AnchorScenarioLink } from "../lib/behavior-unit-state";
import { mergeChunkResults, type ExtractionChunk, type MergeFeature } from "../lib/extraction-merge";

/**
 * Task 11 · 合并过程传播 originKeys：mergeBehaviorTaskResults 在 mergeChunkResults
 * 之上返回 AnalysisResult + 锚点关联（anchor links）。originKeys 只随合并传播，
 * 绝不进入 prompt、展示文本或行为等价/变体判定。
 */

const scenario = (reference: string, outcome: string, originKeys?: string[], category: AnalysisResult["features"][number]["scenarios"][number]["category"] = "happy") => ({
  reference,
  context: "访客打开登录页",
  action: "提交邮箱密码",
  outcome,
  category,
  evidence: [{ path: "lib/auth.ts", startLine: 10 }],
  ...(originKeys ? { originKeys } : {}),
});

const link = (anchorKey: string, localScenarioKey: string, unitKey = "unit|file|[\"lib/auth.ts\"]"): AnchorScenarioLink => ({
  runId: 7,
  unitKey,
  anchorKey,
  localScenarioKey,
});

const chunk = (features: MergeFeature[], anchorLinks?: AnchorScenarioLink[]): ExtractionChunk => ({
  result: {
    product: { description: "代码驱动的产品知识库。", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
    release: { title: "v1", summary: "summary" },
    changes: [],
    features,
  },
  ...(anchorLinks ? { anchorLinks } : {}),
});

const KEY_A1 = "scenario|[\"u1\",\"a1\",\"001\"]";
const KEY_A2 = "scenario|[\"u1\",\"a1\",\"002\"]";
const KEY_B1 = "scenario|[\"u2\",\"b1\",\"001\"]";

describe("mergeBehaviorTaskResults", () => {
  it("returns the merged AnalysisResult plus anchor links and merge stats", () => {
    const merged: BehaviorMergedResult = mergeBehaviorTaskResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard", [KEY_A1])] }], [link("anchor|a", KEY_A1)]),
    ]);
    expect(merged.result.features).toHaveLength(1);
    expect(merged.result.features[0].scenarios[0].originKeys).toEqual([KEY_A1]);
    expect(merged.anchorLinks).toEqual([link("anchor|a", KEY_A1)]);
    expect(merged.stats).toEqual({ changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 });
  });

  it("preserves every linkedAnchorKey, not just the ordinal-owning anchor (many anchors share one scenario)", () => {
    // Task 10 的归属锚点只是 ordinal 分配场所：a1 持有 ordinal，但 anchor|b 也支撑同一场景。
    const merged = mergeBehaviorTaskResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard", [KEY_A1])] }], [
        link("anchor|a", KEY_A1),
        link("anchor|b", KEY_A1),
      ]),
    ]);
    expect(merged.result.features[0].scenarios).toHaveLength(1);
    expect(merged.anchorLinks).toEqual([link("anchor|a", KEY_A1), link("anchor|b", KEY_A1)]);
  });

  it("preserves many scenarios per anchor", () => {
    const merged = mergeBehaviorTaskResults([
      chunk([{
        name: "统一登录", summary: "s",
        scenarios: [
          scenario("HP-1", "登录成功跳转 dashboard", [KEY_A1]),
          scenario("EC-1", "密码错误锁定账户", [KEY_A2], "error"),
        ],
      }], [link("anchor|a", KEY_A1), link("anchor|a", KEY_A2)]),
    ]);
    expect(merged.result.features[0].scenarios).toHaveLength(2);
    expect(merged.anchorLinks).toEqual([link("anchor|a", KEY_A1), link("anchor|a", KEY_A2)]);
  });

  it("unions originKeys through dedup while links from both chunks survive", () => {
    const merged = mergeBehaviorTaskResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard", [KEY_A1])] }], [link("anchor|a", KEY_A1)]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard", [KEY_B1])] }], [link("anchor|b", KEY_B1)]),
    ]);
    expect(merged.result.features[0].scenarios).toHaveLength(1);
    expect(merged.result.features[0].scenarios[0].originKeys).toEqual([KEY_A1, KEY_B1]);
    expect(merged.anchorLinks).toEqual([link("anchor|a", KEY_A1), link("anchor|b", KEY_B1)]);
    expect(merged.stats.scenariosDeduped).toBe(1);
  });

  it("dedupes identical link rows and sorts deterministically regardless of input order", () => {
    const features = (): MergeFeature[] => [{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard", [KEY_A1])] }];
    const first = mergeBehaviorTaskResults([
      chunk(features(), [link("anchor|b", KEY_A1), link("anchor|a", KEY_A1)]),
      chunk(features(), [link("anchor|a", KEY_A1)]),
    ]);
    const second = mergeBehaviorTaskResults([
      chunk(features(), [link("anchor|a", KEY_A1)]),
      chunk(features(), [link("anchor|b", KEY_A1), link("anchor|a", KEY_A1)]),
    ]);
    expect(first.anchorLinks).toEqual([link("anchor|a", KEY_A1), link("anchor|b", KEY_A1)]);
    expect(second.anchorLinks).toEqual(first.anchorLinks);
  });

  it("stays field-identical to mergeChunkResults for origin-less legacy chunks", () => {
    const legacyChunks: ExtractionChunk[] = [
      chunk([{ name: "统一登录", summary: "A 版摘要", scenarios: [scenario("HP-1", "登录成功跳转 dashboard")] }]),
      chunk([{ name: "统一登录", summary: "B 版摘要（更长覆盖）", scenarios: [scenario("HP-1", "登录成功跳转 dashboard"), scenario("EC-1", "密码错误锁定账户", undefined, "error")] }]),
    ];
    const merged = mergeBehaviorTaskResults(legacyChunks);
    expect(merged.anchorLinks).toEqual([]);
    expect(merged.result).toEqual(mergeChunkResults(legacyChunks));
    for (const feature of merged.result.features) {
      for (const item of feature.scenarios) {
        expect("originKeys" in item).toBe(false);
      }
    }
  });
});

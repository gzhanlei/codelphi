import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { mergeChunkResults, nextReference } from "../lib/extraction-merge";

const scenario = (reference: string, outcome: string, category: AnalysisResult["features"][number]["scenarios"][number]["category"] = "happy") => ({
  reference,
  context: "访客打开登录页",
  action: "提交邮箱密码",
  outcome,
  category,
  evidence: [{ path: "lib/auth.ts", startLine: 10 }],
});

const chunk = (features: AnalysisResult["features"], changes: AnalysisResult["changes"] = []): { result: AnalysisResult } => ({
  result: {
    product: { description: "代码驱动的产品知识库。", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
    release: { title: "v1", summary: "summary" },
    changes,
    features,
  },
});

describe("nextReference", () => {
  it("takes the max suffix per prefix and increments", () => {
    expect(nextReference(["HP-1", "HP-5"], "HP-3")).toBe("HP-6");
    expect(nextReference(["EC-1"], "EC-2")).toBe("EC-2");
    expect(nextReference([], "HP-1")).toBe("HP-1");
  });
});

describe("mergeChunkResults", () => {
  it("unions scenarios across chunks, deduping behavior-equivalent ones", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "A 版摘要", scenarios: [scenario("HP-1", "登录成功跳转 dashboard")] }]),
      chunk([{ name: "统一登录", summary: "B 版摘要（更长覆盖）", scenarios: [scenario("HP-1", "登录成功跳转 dashboard"), scenario("HP-1", "密码错误锁定账户", "error")] }]),
    ]);
    expect(merged.features).toHaveLength(1);
    const feature = merged.features[0];
    // 两趟重复提取的同一行为被去重；新行为（锁定账户）保留
    expect(feature.scenarios).toHaveLength(2);
    expect(feature.scenarios.map((item) => item.reference)).toEqual(["HP-1", "HP-2"]);
    // 摘要归属：场景数最多的趟（第二趟 2 条 > 第一趟 1 条）
    expect(feature.summary).toBe("B 版摘要（更长覆盖）");
  });

  it("renumbers colliding references for behavior-distinct scenarios", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "规格导出", summary: "s", scenarios: [scenario("HP-1", "导出 Markdown 附件")] }]),
      chunk([{ name: "规格导出", summary: "s", scenarios: [scenario("HP-1", "导出 Explainer HTML 页面")] }]),
    ]);
    const references = merged.features[0].scenarios.map((item) => item.reference);
    expect(references).toEqual(["HP-1", "HP-2"]);
  });

  it("merges features across chunks and sorts by name", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "规格导出", summary: "s", scenarios: [scenario("HP-1", "导出 Markdown")] }]),
      chunk([
        { name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功")] },
        { name: "额度账务核心", summary: "s", scenarios: [scenario("HP-1", "预留扣减")] },
      ]),
    ]);
    expect(merged.features.map((feature) => feature.name)).toEqual(["统一登录", "规格导出", "额度账务核心"]);
  });

  it("dedupes changes by feature+kind+description and takes product/release from the first chunk", () => {
    const merged = mergeChunkResults([
      chunk([], [{ featureName: "规格导出", kind: "added" as const, description: "新增 Gherkin 导出", userImpact: "", evidence: [] }]),
      chunk([], [{ featureName: "规格导出", kind: "added" as const, description: "新增 Gherkin 导出", userImpact: "", evidence: [] }]),
      chunk([], [{ featureName: "规格导出", kind: "added" as const, description: "新增 Explainer 渲染", userImpact: "", evidence: [] }]),
    ]);
    expect(merged.changes).toHaveLength(2);
    expect(merged.product.description).toBe("代码驱动的产品知识库。");
    expect(merged.release.title).toBe("v1");
  });

  it("merges beyond the per-chunk feature cap without dropping chunks", () => {
    const featureAt = (index: number) => ({ name: `功能${index}`, summary: "s", scenarios: [scenario("HP-1", `行为${index}`)] });
    const merged = mergeChunkResults([
      chunk(Array.from({ length: 40 }, (_, index) => featureAt(index))),
      chunk(Array.from({ length: 40 }, (_, index) => featureAt(index + 40))),
    ]);
    expect(merged.features).toHaveLength(80);
  });

  it("dedupes identical behavior across category labels and keeps genuinely different outcomes (BM-5)", () => {
    // BM-5：category 是呈现标签，同触发/操作/结果即同一行为（run 64：ER-1=error 与
    // EC-5=edge 逐字同文并存的重复实例）；结果不同仍是两个行为。
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "返回结果页")] }]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "返回结果页", "edge")] }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(1);
    const distinct = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "返回结果页")] }]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "拒绝并返回 401", "edge")] }]),
    ]);
    expect(distinct.features[0].scenarios).toHaveLength(2);
  });

  it("truncates changes to the schema cap of 150 after dedupe", () => {
    // 先去重再截断：两趟重复的 20 条去重后只算 20 条，不挤占 150 的额度
    const repeated: AnalysisResult["changes"] = Array.from({ length: 20 }, (_, index) => ({
      featureName: "规格导出", kind: "added" as const, description: `变更${index}`, userImpact: "", evidence: [],
    }));
    const unique: AnalysisResult["changes"] = Array.from({ length: 140 }, (_, index) => ({
      featureName: "规格导出", kind: "changed" as const, description: `独立变更${index}`, userImpact: "", evidence: [],
    }));
    const merged = mergeChunkResults([chunk([], repeated), chunk([], unique), chunk([], repeated)]);
    expect(merged.changes).toHaveLength(150);
    // 去重在前：重复的 20 条全部保留，被截掉的是排在其后的独立变更
    expect(merged.changes.filter((change) => change.kind === "added")).toHaveLength(20);
  });

  it("logs when truncation drops changes instead of discarding silently (W0-4)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const changes: AnalysisResult["changes"] = Array.from({ length: 160 }, (_, index) => ({
        featureName: "规格导出", kind: "added" as const, description: `变更${index}`, userImpact: "", evidence: [],
      }));
      const merged = mergeChunkResults([chunk([], changes)]);
      expect(merged.changes).toHaveLength(150);
      const logged = logSpy.mock.calls
        .map((call) => call.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" "))
        .join("\n");
      expect(logged).toContain("truncat");
      expect(logged).toContain("160");
      expect(logged).toContain("150");
    } finally {
      logSpy.mockRestore();
    }
  });
});

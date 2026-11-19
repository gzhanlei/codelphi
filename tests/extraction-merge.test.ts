import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { mergeChunkResults, nextReference, type MergeFeature } from "../lib/extraction-merge";

const scenario = (reference: string, outcome: string, category: AnalysisResult["features"][number]["scenarios"][number]["category"] = "happy") => ({
  reference,
  context: "访客打开登录页",
  action: "提交邮箱密码",
  outcome,
  category,
  evidence: [{ path: "lib/auth.ts", startLine: 10 }],
});

const chunk = (features: MergeFeature[], changes: AnalysisResult["changes"] = []): { result: AnalysisResult } => ({
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
    // 行为等价去重（情境/操作/结果同义）硬折叠；骨架变体保留但打 variantOf 标记（可审计，成文层合并）
    // 骨架通道撤出合并决策（fixture 实证误合真差异）——行为等价去重恢复原语义
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
    const scenarios = merged.features[0].scenarios as Array<{ reference: string; variantOf?: string }>;
    // 真差异（不同导出格式）不被骨架误折：两条都保留且无 variantOf 标记
    expect(scenarios.map((item) => item.reference)).toEqual(["HP-1", "HP-2"]);
    expect(scenarios.every((item) => !item.variantOf)).toBe(true);
  });

  it("merges features across chunks and sorts by name", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "规格导出", summary: "导出 Markdown 与 JSON 规格", scenarios: [scenario("HP-1", "导出 Markdown")] }]),
      chunk([
        { name: "统一登录", summary: "邮箱密码与 OAuth 统一登录", scenarios: [scenario("HP-1", "登录成功")] },
        { name: "额度账务核心", summary: "SAU 额度预留与扣减", scenarios: [scenario("HP-1", "预留扣减")] },
      ]),
    ]);
    expect(merged.features.map((feature) => feature.name)).toEqual(["统一登录", "规格导出", "额度账务核心"]);
  });

  it("keeps only exactly duplicated reviewed audit candidates and takes product/release from the first chunk", () => {
    const merged = mergeChunkResults([
      chunk([], [{ featureName: "规格导出", kind: "reviewed" as const, description: "内部实现已检查", userImpact: "", evidence: [] }]),
      chunk([], [{ featureName: "规格导出", kind: "reviewed" as const, description: "内部实现已检查", userImpact: "", evidence: [] }]),
      chunk([], [{ featureName: "规格导出", kind: "added" as const, description: "新增 Explainer 渲染", userImpact: "", evidence: [] }]),
    ]);
    expect(merged.changes).toHaveLength(1);
    expect(merged.changes[0].kind).toBe("reviewed");
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
      featureName: "规格导出", kind: "reviewed" as const, description: `变更${index}`, userImpact: "", evidence: [],
    }));
    const unique: AnalysisResult["changes"] = Array.from({ length: 140 }, (_, index) => ({
      featureName: "规格导出", kind: "reviewed" as const, description: `独立变更${index}`, userImpact: "", evidence: [],
    }));
    const merged = mergeChunkResults([chunk([], repeated), chunk([], unique), chunk([], repeated)]);
    expect(merged.changes).toHaveLength(150);
    // 去重在前：重复的 20 条全部保留，被截掉的是排在其后的独立变更
    expect(merged.changes.filter((change) => change.description.startsWith("变更"))).toHaveLength(20);
  });

  it("logs when truncation drops changes instead of discarding silently (W0-4)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const changes: AnalysisResult["changes"] = Array.from({ length: 160 }, (_, index) => ({
        featureName: "规格导出", kind: "reviewed" as const, description: `变更${index}`, userImpact: "", evidence: [],
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

describe("mergeChunkResults cross-group variant folding (BM-11)", () => {
  it("folds differently-named features of the same component into the first-seen keeper (release 220 ×4 pattern)", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "管理端支付台账", summary: "超管支付操作面板", scenarios: [scenario("HP-1", "创建测试单并展示扫码支付入口"), scenario("HP-2", "表格显示空态文案", "edge")] }]),
      chunk([{ name: "管理端支付订单台账", summary: "超管支付页的联调测试单与订单台账面板", scenarios: [scenario("HP-1", "创建测试单并展示扫码收银台与跳转链接"), scenario("HP-2", "显示空订单提示行", "edge")] }]),
      chunk([{ name: "管理端支付台账面板", summary: "超管后台支付面板", scenarios: [scenario("HP-1", "创建测试单并展示支付入口"), scenario("HP-2", "空订单提示行渲染", "edge")] }]),
    ]);
    expect(merged.features).toHaveLength(1);
    expect(merged.features[0].name).toBe("管理端支付台账");
    // 变体场景并入 keeper 时按行为去重，同行为不再重复建条
    expect(merged.features[0].scenarios).toHaveLength(2);
  });

  it("keeps genuinely different features that only share generic name words", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "管理端支付台账", summary: "超管支付操作面板", scenarios: [scenario("HP-1", "创建测试单并展示支付入口")] }]),
      chunk([{ name: "管理端退款流水", summary: "超管退款流水视图", scenarios: [scenario("HP-1", "按订单维度展示退款请求与退款态")] }]),
    ]);
    expect(merged.features).toHaveLength(2);
  });

  it("reports featuresFolded in stats (BM-11 mergeIntegrity)", () => {
    const onStats = vi.fn();
    mergeChunkResults([
      chunk([{ name: "无壳页面语言切换", summary: "s", scenarios: [scenario("HP-1", "登录页按新语言整页刷新")] }]),
      chunk([{ name: "无外壳页面语言切换", summary: "s", scenarios: [scenario("HP-1", "登录页按新语言整页刷新")] }]),
    ], onStats);
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ featuresFolded: 1 }));
  });
});

describe("mergeChunkResults reviewed-only audit boundary", () => {
  it("discards every partition-generated user-facing changelog variant", () => {
    const variants = [
      "散文中的「≥1 对」「5 个」等数字噪声不再阻断变体折叠，而「变更0」与「独立变更0」这类短标题不再被误折。",
      "散文里的个位数计数不再阻止同一行为的措辞变体折叠；「变更0」与「独立变更0」这类短标题不再被误折；404 与 400 等多位错误码仍被守护。",
      "散文里的个位数计数不再导致同一变化被误判为不同条目；「变更0」与「独立变更0」这类短标题不再被误折。",
    ];
    const merged = mergeChunkResults(variants.map((description) => chunk([], [
      { featureName: "变化条目措辞变体判定", kind: "changed" as const, description, userImpact: description, evidence: [{ path: "lib/spec-diff.ts", startLine: 305 }] },
    ])));

    expect(merged.changes).toEqual([]);
  });

});

describe("mergeChunkResults origin propagation (Task 11)", () => {
  const originScenario = (reference: string, outcome: string, originKeys: string[], category: AnalysisResult["features"][number]["scenarios"][number]["category"] = "happy") => ({
    ...scenario(reference, outcome, category),
    originKeys,
  });

  it("unions originKeys when behavior-equivalent duplicates merge (keeper text wins, origins survive)", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [originScenario("HP-1", "登录成功跳转 dashboard", ["scenario|[\"u1\",\"a1\",\"001\"]"])] }]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [originScenario("HP-1", "登录成功跳转 dashboard", ["scenario|[\"u2\",\"a2\",\"001\"]"], "edge")] }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(1);
    expect(merged.features[0].scenarios[0].originKeys).toEqual(["scenario|[\"u1\",\"a1\",\"001\"]", "scenario|[\"u2\",\"a2\",\"001\"]"]);
  });

  it("unions originKeys on the BM-6 variant fold path within a group", () => {
    const merged = mergeChunkResults([
      chunk([{
        name: "产品发布入口", summary: "s",
        scenarios: [
          { ...originScenario("EC-5", "不渲染任何发布入口，登录引导集中在顶栏", ["scenario|[\"u1\",\"a1\",\"001\"]"], "edge"), context: "匿名演示访客查看总览页", action: "渲染发布入口" },
          { ...originScenario("EC-6", "不渲染任何发布入口，登录引导集中在顶栏", ["scenario|[\"u1\",\"a1\",\"002\"]"], "edge"), context: "匿名 demo 访客查看总览页", action: "渲染发布入口" },
        ],
      }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(1);
    expect(merged.features[0].scenarios[0].originKeys).toEqual(["scenario|[\"u1\",\"a1\",\"001\"]", "scenario|[\"u1\",\"a1\",\"002\"]"]);
  });

  it("unions originKeys when the cross-group BM-11 feature fold merges scenarios", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "管理端支付台账", summary: "超管支付操作面板", scenarios: [originScenario("HP-1", "创建测试单并展示扫码支付入口", ["scenario|[\"u1\",\"a1\",\"001\"]"])] }]),
      chunk([{ name: "管理端支付订单台账", summary: "超管支付页的联调测试单与订单台账面板", scenarios: [originScenario("HP-1", "创建测试单并展示扫码支付入口", ["scenario|[\"u2\",\"a2\",\"001\"]"])] }]),
    ]);
    expect(merged.features).toHaveLength(1);
    expect(merged.features[0].name).toBe("管理端支付台账");
    expect(merged.features[0].scenarios).toHaveLength(1);
    expect(merged.features[0].scenarios[0].originKeys).toEqual(["scenario|[\"u1\",\"a1\",\"001\"]", "scenario|[\"u2\",\"a2\",\"001\"]"]);
  });

  it("keeps originKeys when a reference collision renumbers the scenario", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "规格导出", summary: "s", scenarios: [originScenario("HP-1", "导出 Markdown 附件", ["scenario|[\"u1\",\"a1\",\"001\"]"])] }]),
      chunk([{ name: "规格导出", summary: "s", scenarios: [originScenario("HP-1", "导出 Explainer HTML 页面", ["scenario|[\"u2\",\"a2\",\"001\"]"])] }]),
    ]);
    const scenarios = merged.features[0].scenarios;
    expect(scenarios.map((item) => item.reference)).toEqual(["HP-1", "HP-2"]);
    expect(scenarios[0].originKeys).toEqual(["scenario|[\"u1\",\"a1\",\"001\"]"]);
    expect(scenarios[1].originKeys).toEqual(["scenario|[\"u2\",\"a2\",\"001\"]"]);
  });

  it("never lets origins influence behavior equality: same origin with different behavior stays two scenarios", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [originScenario("HP-1", "返回结果页", ["scenario|[\"u1\",\"a1\",\"001\"]"])] }]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [originScenario("HP-1", "拒绝并返回 401", ["scenario|[\"u1\",\"a1\",\"001\"]"], "edge")] }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(2);
  });

  it("keeps keeper origins when the incoming duplicate carries none", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "s", scenarios: [originScenario("HP-1", "登录成功跳转 dashboard", ["scenario|[\"u1\",\"a1\",\"001\"]"])] }]),
      chunk([{ name: "统一登录", summary: "s", scenarios: [scenario("HP-1", "登录成功跳转 dashboard")] }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(1);
    expect(merged.features[0].scenarios[0].originKeys).toEqual(["scenario|[\"u1\",\"a1\",\"001\"]"]);
  });

  it("never fabricates originKeys for origin-less chunks (old partition output stays field-identical)", () => {
    const merged = mergeChunkResults([
      chunk([{ name: "统一登录", summary: "A 版摘要", scenarios: [scenario("HP-1", "登录成功跳转 dashboard")] }]),
      chunk([{ name: "统一登录", summary: "B 版摘要（更长覆盖）", scenarios: [scenario("HP-1", "登录成功跳转 dashboard"), scenario("HP-1", "密码错误锁定账户", "error")] }]),
    ]);
    expect(merged.features[0].scenarios).toHaveLength(2);
    for (const feature of merged.features) {
      for (const item of feature.scenarios) {
        expect("originKeys" in item).toBe(false);
      }
    }
  });
});

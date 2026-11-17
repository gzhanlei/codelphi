import { describe, expect, it, vi } from "vitest";
import { buildDomainCandidatePrompt, generateDomainCandidates, parseDomainCandidates } from "../lib/business-domain-candidates";
import type { FeatureRow, ScenarioRow } from "../lib/types";

const feature = (id: number, name: string, parentId: number | null = null): FeatureRow => ({ id, name, summary: `${name}概述`, parentId, source: "generated" });
const scenario = (id: number, featureId: number, evidence: unknown = []): ScenarioRow => ({ id, featureId, reference: `HP-${id}`, context: "情境", action: "操作", outcome: "结果", category: "happy", source: "generated", evidence });

// 两个不同产品的输入：只共享受控字段（说明/功能/场景文本），不共享任何分类常量。
const recordingProduct = {
  name: "SalesBuddy",
  description: "销售助理",
  features: [feature(1, "录音笔管理"), feature(2, "转写与复盘"), feature(3, "备份归档")],
  scenarios: [scenario(1, 1, [{ path: "app/recorder.ts" }]), scenario(2, 2, [{ path: "app/asr.ts" }])],
};
const publishingProduct = {
  name: "PubPress",
  description: "内容发布平台",
  features: [feature(1, "稿件编排"), feature(2, "多渠道分发")],
  scenarios: [scenario(1, 1, [{ path: "app/editor.ts" }])],
};

const validContent = JSON.stringify([
  { name: "客户沟通", summary: "汇总沟通来源", featureIds: [1] },
  { name: "客户认知", summary: "转写与复盘", featureIds: [2] },
  { name: "运维保障", summary: "备份与归档", featureIds: [3] },
]);
const filler = JSON.stringify([{ name: "兜底域", summary: "凑足 3 个", featureIds: [2] }]);

describe("business domain candidates (Task 0)", () => {
  it("builds product-specific prompts: two products get different prompts with no shared classification template", () => {
    const a = buildDomainCandidatePrompt(recordingProduct);
    const b = buildDomainCandidatePrompt(publishingProduct);
    expect(a).not.toEqual(b);
    expect(JSON.stringify(a)).toContain("录音笔管理");
    expect(JSON.stringify(b)).toContain("稿件编排");
    // 不把其他项目的分类当作模板：prompt 不出现 SalesBuddy 专属域名
    expect(JSON.stringify(b)).not.toContain("客户沟通");
  });

  it("parses AI output into candidates referencing only existing feature IDs, with evidence paths", () => {
    const candidates = parseDomainCandidates(validContent, recordingProduct.features, recordingProduct.scenarios);
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ name: "客户沟通", summary: "汇总沟通来源", featureIds: [1], source: "generated" });
    expect(candidates[0].evidencePaths).toEqual(["app/recorder.ts"]);
    // 候选不标记已核实：没有 verified 字段
    expect(candidates[0]).not.toHaveProperty("verified");
  });

  it("reports unknown feature IDs as unknowns instead of silently dropping or activating them", () => {
    const content = JSON.stringify([
      { name: "幽灵域", summary: "引用不存在功能", featureIds: [999] },
      { name: "部分有效", summary: "一个有效一个无效", featureIds: [1, 998] },
      ...JSON.parse(filler),
    ]);
    const candidates = parseDomainCandidates(content, recordingProduct.features, recordingProduct.scenarios);
    expect(candidates[0].featureIds).toEqual([]);
    // 只引用未知 ID = 无有效归属：同时报告未知 ID 与空归属两个信号
    expect(candidates[0].unknowns).toEqual([999, "empty"]);
    expect(candidates[1].featureIds).toEqual([1]);
    expect(candidates[1].unknowns).toEqual([998]);
  });

  it("reports evidence-missing and empty candidates via unknowns, never activating a group", () => {
    const content = JSON.stringify([
      { name: "无证据域", summary: "引用的功能没有证据", featureIds: [3] },
      { name: "空域", summary: "没有引用任何功能", featureIds: [] },
      ...JSON.parse(filler),
    ]);
    const candidates = parseDomainCandidates(content, recordingProduct.features, recordingProduct.scenarios);
    expect(candidates).toHaveLength(3);
    expect(candidates[0].unknowns).toContain("evidence-missing");
    expect(candidates[1].featureIds).toEqual([]);
    expect(candidates[1].unknowns).toContain("empty");
  });

  it("returns an error result without throwing when AI output is unparseable", async () => {
    const completion = vi.fn().mockResolvedValue("这不是 JSON");
    const result = await generateDomainCandidates(recordingProduct, { requestCompletion: completion });
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("returns an error result when the completion call fails, leaving database and overview untouched", async () => {
    const completion = vi.fn().mockRejectedValue(new Error("AI 网关超时"));
    const result = await generateDomainCandidates(recordingProduct, { requestCompletion: completion });
    expect(result.candidates).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("imposes no count budget: accepts any non-empty candidate list, tolerates string IDs (Chandler 实测)", () => {
    const one = JSON.stringify([{ name: "唯一域", summary: "", featureIds: [1] }]);
    const parsedOne = parseDomainCandidates(one, recordingProduct.features, recordingProduct.scenarios);
    expect(parsedOne).toHaveLength(1);
    // 空数组仍是无效输出
    expect(parseDomainCandidates("[]", recordingProduct.features, recordingProduct.scenarios)).toEqual([]);
    // 数字字符串 ID 容错（模型键漂移防御在解析层）
    const stringIds = JSON.stringify([{ name: "域A", summary: "", featureIds: ["1", 2] }, { name: "域B", summary: "", featureIds: [3] }]);
    const parsedStrings = parseDomainCandidates(stringIds, recordingProduct.features, recordingProduct.scenarios);
    expect(parsedStrings[0].featureIds).toEqual([1, 2]);
    expect(parsedStrings[0].unknowns).toEqual([]);
  });
});

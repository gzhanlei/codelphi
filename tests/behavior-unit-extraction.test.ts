import { describe, expect, it, vi } from "vitest";
import { AiOutputTruncatedError, type LlmBillingContext } from "../lib/ai";
import type { TaskSource } from "../lib/behavior-inventory/planner";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import { describeBehaviorTaskPrompt, judgeBehaviorTaskPrompt, type BehaviorRegionDescription } from "../lib/behavior-unit-ai";
import { extractBehaviorTask, type ExtractBehaviorTaskInput } from "../lib/behavior-unit-extraction";

const task: BehaviorExecutionTask = {
  taskKey: 'task|["unit|http:src/foo.ts",1]',
  unitKey: "unit|http:src/foo.ts",
  anchorFragments: [
    { anchorKey: "anchor|behavior:foo:1-5", anchorFragmentKey: "fragment|a:1", ranges: [{ startLine: 1, endLine: 5 }] },
    { anchorKey: "anchor|implicit:foo:6-10", anchorFragmentKey: "fragment|b:1", ranges: [{ startLine: 6, endLine: 10 }] },
  ],
};

const sources: TaskSource[] = [
  { path: "src/foo.ts", content: ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n"), startLine: 1, endLine: 10, role: "primary" },
  { path: "src/shared.ts", content: ["s40", "s41"].join("\n"), startLine: 40, endLine: 41, role: "context" },
];

const descriptions: BehaviorRegionDescription[] = [
  { id: "R1", facts: "校验请求并写入订单", inputs: "请求体", controlFlow: "顺序执行", externalEffects: "写数据库" },
  { id: "R2", facts: "格式化日志行", inputs: "字符串", controlFlow: "顺序执行", externalEffects: "未观察到外部效果" },
];

function describeResponse(): string {
  return JSON.stringify({ regions: descriptions });
}

type RegionJson = Record<string, unknown>;

function judgeResponse(regions: RegionJson[], features: unknown[] = []): string {
  return JSON.stringify({ regions, features });
}

function extractedRegion(id: string, refs: string[] = ["HP-1"]): RegionJson {
  return { id, disposition: "extracted", reason: "外部可见", evidence: [{ path: "src/foo.ts", startLine: 3 }], scenarioRefs: refs };
}

function internalRegion(id: string, internalKind: string, extra: RegionJson = {}): RegionJson {
  return { id, disposition: "reviewed_internal", internalKind, reason: "无独立外部效果", evidence: [{ path: "src/foo.ts", startLine: 8 }], scenarioRefs: [], ...extra };
}

const feature = {
  name: "订单",
  summary: "下单",
  scenarios: [
    { reference: "HP-1", context: "用户已登录", action: "提交订单", outcome: "订单写入数据库", category: "happy", evidence: [{ path: "src/foo.ts", startLine: 3 }] },
  ],
};

type Completion = (messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext) => Promise<string>;

function completionMock(...steps: Array<string | Error>) {
  const fn = vi.fn<Completion>();
  for (const step of steps) {
    if (step instanceof Error) fn.mockRejectedValueOnce(step);
    else fn.mockResolvedValueOnce(step);
  }
  return fn;
}

function input(overrides: Partial<ExtractBehaviorTaskInput> = {}): ExtractBehaviorTaskInput {
  return { task, sources, ...overrides };
}

describe("behavior task prompts", () => {
  it("describe prompt restates each region's facts without judgment or scenario caps", () => {
    const prompt = describeBehaviorTaskPrompt(task, sources);
    expect(prompt).toContain("R1");
    expect(prompt).toContain("R2");
    expect(prompt).toContain("1-5");
    expect(prompt).toContain("6-10");
    // 带行号的实际读取内容（primary 与 context 分区呈现）
    expect(prompt).toContain("1: l1");
    expect(prompt).toContain("10: l10");
    expect(prompt).toContain("40: s40");
    // 复述步只描述事实，禁止显著性判断与数量帽
    expect(prompt).toContain("不要判断");
    expect(prompt).not.toMatch(/1-5 个|最关键的|只保留|most important/i);
  });

  it("judge prompt carries internal-implementation guardrails and no significance caps", () => {
    const prompt = judgeBehaviorTaskPrompt({ task, sources, descriptions });
    expect(prompt).toContain("pure_technical");
    expect(prompt).toContain("covered_elsewhere");
    expect(prompt).toContain("data_transform");
    expect(prompt).toContain("other_evidence_backed");
    // 共享副作用红线：不能仅因被调用就判内部实现
    expect(prompt).toContain("被其他单元调用");
    expect(prompt).toMatch(/数据库写入|数据库读写/);
    expect(prompt).toContain("事件发布");
    // covered_elsewhere 必须给关联；结论必须有证据；拿不准计入
    expect(prompt).toContain("relatedUnitKeys");
    expect(prompt).toContain("relatedScenarioRefs");
    expect(prompt).toContain("宁可多写一条");
    expect(prompt).not.toMatch(/1-5 个|最关键的|只保留|most important/i);
    // 复述内容进入判定 prompt（先事实后判定）
    expect(prompt).toContain("校验请求并写入订单");
  });
});

describe("extractBehaviorTask", () => {
  it("extracts scenarios and classifies every fragment (happy path)", async () => {
    const requestCompletion = completionMock(describeResponse(), judgeResponse([extractedRegion("R1"), internalRegion("R2", "data_transform")], [feature]));
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("extracted");
    expect(result.scenarioCount).toBe(1);
    expect(result.reviewedCount).toBe(1);
    expect(result.unresolvedAnchorCount).toBe(0);
    expect(result.anchorReceipts).toHaveLength(2);
    const [first, second] = result.anchorReceipts;
    expect(first).toMatchObject({ anchorKey: task.anchorFragments[0].anchorKey, anchorFragmentKey: "fragment|a:1", disposition: "extracted", scenarioRefs: ["HP-1"] });
    expect(first.evidence).toEqual([{ path: "src/foo.ts", startLine: 3 }]);
    expect(second).toMatchObject({ disposition: "reviewed_internal", internalKind: "data_transform", scenarioRefs: [] });
    expect(second.evidence.length).toBeGreaterThan(0);
    expect(result.features).toHaveLength(1);
  });

  it("returns no_behavior only when every fragment has an evidence-backed internal conclusion", async () => {
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([internalRegion("R1", "pure_technical"), internalRegion("R2", "data_transform")]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("no_behavior");
    expect(result.scenarioCount).toBe(0);
    expect(result.reviewedCount).toBe(2);
    expect(result.unresolvedAnchorCount).toBe(0);
    expect(result.features).toHaveLength(0);
  });

  it("accepts covered_elsewhere only with related unit keys or scenario refs", async () => {
    const withRelation = completionMock(
      describeResponse(),
      judgeResponse([internalRegion("R1", "covered_elsewhere", { relatedUnitKeys: ["unit|http:src/orders.ts"] }), internalRegion("R2", "data_transform")]),
    );
    const accepted = await extractBehaviorTask(input({ requestCompletion: withRelation }));
    expect(accepted.outcome).toBe("no_behavior");
    expect(accepted.anchorReceipts[0]).toMatchObject({ disposition: "reviewed_internal", internalKind: "covered_elsewhere", relatedUnitKeys: ["unit|http:src/orders.ts"] });

    const withoutRelation = completionMock(
      describeResponse(),
      judgeResponse([internalRegion("R1", "covered_elsewhere"), internalRegion("R2", "data_transform")]),
    );
    const rejected = await extractBehaviorTask(input({ requestCompletion: withoutRelation }));
    expect(rejected.outcome).toBe("unresolved");
    expect(rejected.anchorReceipts[0]).toMatchObject({ disposition: "unresolved", reason: "covered_elsewhere_without_relation" });
  });

  it("keeps reviewed_internal without evidence unresolved", async () => {
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([internalRegion("R1", "pure_technical", { evidence: [] }), internalRegion("R2", "data_transform")]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.anchorReceipts[0]).toMatchObject({ disposition: "unresolved", reason: "reviewed_internal_without_evidence" });
    expect(result.anchorReceipts[1].disposition).toBe("reviewed_internal");
  });

  it("rejects reviewed_internal conclusions that occupy scenarioRefs", async () => {
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([internalRegion("R1", "pure_technical", { scenarioRefs: ["HP-1"] }), internalRegion("R2", "data_transform")], [feature]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.anchorReceipts[0]).toMatchObject({ disposition: "unresolved", reason: "reviewed_internal_with_scenario_refs" });
  });

  it("keeps empty model answers unresolved instead of no_behavior", async () => {
    const requestCompletion = completionMock(describeResponse(), judgeResponse([], []));
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.scenarioCount).toBe(0);
    expect(result.unresolvedAnchorCount).toBe(2);
    for (const receipt of result.anchorReceipts) {
      expect(receipt).toMatchObject({ disposition: "unresolved", reason: "missing_disposition" });
    }
  });

  it("keeps a task unresolved when any fragment lacks a disposition", async () => {
    const requestCompletion = completionMock(describeResponse(), judgeResponse([extractedRegion("R1")], [feature]));
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.anchorReceipts[0].disposition).toBe("extracted");
    expect(result.anchorReceipts[1]).toMatchObject({ disposition: "unresolved", reason: "missing_disposition" });
  });

  it("keeps all-candidates-rejected unresolved instead of no_behavior", async () => {
    const ghostFeature = {
      ...feature,
      scenarios: [{ ...feature.scenarios[0], evidence: [{ path: "src/ghost.ts", startLine: 3 }] }],
    };
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([extractedRegion("R1"), internalRegion("R2", "data_transform")], [ghostFeature]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.sanitize.allCandidatesRejected).toBe(true);
    expect(result.anchorReceipts[0]).toMatchObject({ disposition: "unresolved", reason: "extracted_without_surviving_scenarios" });
    expect(result.anchorReceipts[1].disposition).toBe("reviewed_internal");
  });

  it("sanitizes evidence against the actually-read allow set and keeps valid claims", async () => {
    const mixedFeature = {
      ...feature,
      scenarios: [{ ...feature.scenarios[0], evidence: [{ path: "src/ghost.ts", startLine: 1 }, { path: "src/foo.ts", startLine: 3 }] }],
    };
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([extractedRegion("R1"), internalRegion("R2", "data_transform")], [mixedFeature]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("extracted");
    // 不可溯源证据路径被剔除，场景本身保留（droppedClaims 计被剔除的场景数）
    expect(result.sanitize.droppedClaims).toBe(0);
    expect(result.features[0].scenarios[0].evidence).toEqual([{ path: "src/foo.ts", startLine: 3 }]);
  });

  it("keeps extracted dispositions unresolved when their scenario references were dropped", async () => {
    const requestCompletion = completionMock(
      describeResponse(),
      judgeResponse([extractedRegion("R1", ["HP-9"]), internalRegion("R2", "data_transform")], [feature]),
    );
    const result = await extractBehaviorTask(input({ requestCompletion }));
    expect(result.outcome).toBe("unresolved");
    expect(result.anchorReceipts[0]).toMatchObject({ disposition: "unresolved", reason: "extracted_without_surviving_scenarios" });
  });

  it("keeps truncated output unresolved at either call stage", async () => {
    const truncatedAtDescribe = completionMock(new AiOutputTruncatedError());
    const first = await extractBehaviorTask(input({ requestCompletion: truncatedAtDescribe }));
    expect(first.outcome).toBe("unresolved");
    expect(first.unresolvedAnchorCount).toBe(2);
    for (const receipt of first.anchorReceipts) expect(receipt.reason).toBe("output_truncated");
    expect(truncatedAtDescribe).toHaveBeenCalledTimes(1);

    const truncatedAtJudge = completionMock(describeResponse(), new AiOutputTruncatedError());
    const second = await extractBehaviorTask(input({ requestCompletion: truncatedAtJudge }));
    expect(second.outcome).toBe("unresolved");
    expect(truncatedAtJudge).toHaveBeenCalledTimes(2);
  });

  it("propagates hard failures for the caller retry path", async () => {
    const requestCompletion = completionMock(new Error("AI gateway 500: boom"));
    await expect(extractBehaviorTask(input({ requestCompletion }))).rejects.toThrow("AI gateway 500");
  });

  it("stamps describe and judge billing stages with task and attempt identity", async () => {
    const requestCompletion = completionMock(describeResponse(), judgeResponse([extractedRegion("R1"), internalRegion("R2", "data_transform")], [feature]));
    const billing: LlmBillingContext = {
      runId: 7,
      accountId: 3,
      chargeComponent: "main",
      taskKey: task.taskKey,
      unitKey: task.unitKey,
      attemptId: "attempt-1",
    };
    await extractBehaviorTask(input({ requestCompletion, billing }));
    expect(requestCompletion).toHaveBeenCalledTimes(2);
    const describeBilling = requestCompletion.mock.calls[0][1];
    const judgeBilling = requestCompletion.mock.calls[1][1];
    expect(describeBilling).toMatchObject({ runId: 7, taskKey: task.taskKey, unitKey: task.unitKey, attemptId: "attempt-1", callStage: "describe" });
    expect(judgeBilling).toMatchObject({ runId: 7, taskKey: task.taskKey, unitKey: task.unitKey, attemptId: "attempt-1", callStage: "judge" });
  });

  it("validates boundary inputs before any AI call", async () => {
    const requestCompletion = completionMock(describeResponse());
    await expect(extractBehaviorTask({ task, sources: [], requestCompletion })).rejects.toThrow(/source/i);
    await expect(extractBehaviorTask({ task: { ...task, anchorFragments: [] }, sources, requestCompletion })).rejects.toThrow(/fragment/i);
    expect(requestCompletion).not.toHaveBeenCalled();
  });
});

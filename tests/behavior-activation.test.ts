import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetReservation } from "../lib/behavior-run-budget";
import { evaluateBehaviorActivationGate, resolveProductDescription, type ActivationGateInput, type ProductDescriptionInput } from "../lib/behavior-activation";

const budgetMocks = vi.hoisted(() => ({
  settleBehaviorBudget: vi.fn(),
  releaseUnusedBehaviorBudget: vi.fn(),
  reserveProductSummaryBudget: vi.fn(),
}));

vi.mock("../lib/behavior-run-budget", () => ({
  PRODUCT_SUMMARY_ATTEMPT_ID: "product_summary",
  settleBehaviorBudget: budgetMocks.settleBehaviorBudget,
  releaseUnusedBehaviorBudget: budgetMocks.releaseUnusedBehaviorBudget,
  reserveProductSummaryBudget: budgetMocks.reserveProductSummaryBudget,
  BehaviorBudgetError: class BehaviorBudgetError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "BehaviorBudgetError";
      this.code = code;
    }
  },
}));

const greenGateInput = (): ActivationGateInput => ({
  manifestValid: true,
  primaryCoverageComplete: true,
  anchorCoverageComplete: true,
  anchors: [
    // entry 锚点只用于定位：即使 unresolved 也不进入核算（D2/Task 10 deferred 裁决）
    { anchorKey: "anchor|entry", role: "entry", disposition: "unresolved", evidence: [] },
    { anchorKey: "anchor|a", role: "behavior", disposition: "extracted", evidence: [{ path: "src/a.ts" }] },
    { anchorKey: "anchor|b", role: "implicit_review", disposition: "reviewed_internal", internalKind: "pure_technical", evidence: [{ path: "src/b.ts" }] },
  ],
  unitStatuses: ["extracted", "no_behavior"],
  survivingUnitKeys: new Set(["unit|a"]),
  survivingScenarioRefs: new Set(["scenario|k1"]),
  existingEvidenceChecksPassed: true,
  existingMergeChecksPassed: true,
});

describe("evaluateBehaviorActivationGate (D8 独立门禁)", () => {
  it("activates only when every independent check passes; entry anchors are not accounting anchors", () => {
    const outcome = evaluateBehaviorActivationGate(greenGateInput());
    expect(outcome.activate).toBe(true);
    expect(outcome.checks).toEqual({
      inventoryManifestValid: true,
      primaryCoverageComplete: true,
      anchorCoverageComplete: true,
      anchorAccountingComplete: true,
      allUnitsInAllowedTerminalStates: true,
      existingEvidenceChecksPassed: true,
      existingMergeChecksPassed: true,
    });
    expect(outcome.unaccountedAnchorKeys).toEqual([]);
  });

  it("rejects when the manifest is not valid", () => {
    const outcome = evaluateBehaviorActivationGate({ ...greenGateInput(), manifestValid: false });
    expect(outcome.activate).toBe(false);
    expect(outcome.checks.inventoryManifestValid).toBe(false);
  });

  it("rejects primary and anchor coverage omissions independently", () => {
    const primary = evaluateBehaviorActivationGate({ ...greenGateInput(), primaryCoverageComplete: false });
    expect(primary.activate).toBe(false);
    expect(primary.checks.primaryCoverageComplete).toBe(false);
    expect(primary.checks.anchorCoverageComplete).toBe(true);
    const anchor = evaluateBehaviorActivationGate({ ...greenGateInput(), anchorCoverageComplete: false });
    expect(anchor.activate).toBe(false);
    expect(anchor.checks.anchorCoverageComplete).toBe(false);
  });

  it.each(["pending", "running", "failed", "unresolved"] as const)("rejects while any unit is %s", (status) => {
    const outcome = evaluateBehaviorActivationGate({ ...greenGateInput(), unitStatuses: ["extracted", status] });
    expect(outcome.activate).toBe(false);
    expect(outcome.checks.allUnitsInAllowedTerminalStates).toBe(false);
  });

  it("fails closed on an empty unit list", () => {
    const outcome = evaluateBehaviorActivationGate({ ...greenGateInput(), unitStatuses: [] });
    expect(outcome.activate).toBe(false);
    expect(outcome.checks.allUnitsInAllowedTerminalStates).toBe(false);
  });

  it("rejects when an accountable anchor stays unresolved", () => {
    const input = greenGateInput();
    input.anchors = [{ anchorKey: "anchor|x", role: "implicit_review", disposition: "unresolved", evidence: [{ path: "src/x.ts" }] }];
    const outcome = evaluateBehaviorActivationGate(input);
    expect(outcome.activate).toBe(false);
    expect(outcome.checks.anchorAccountingComplete).toBe(false);
    expect(outcome.unaccountedAnchorKeys).toEqual(["anchor|x"]);
  });

  it("rejects reviewed_internal conclusions without kind or evidence", () => {
    const noKind = evaluateBehaviorActivationGate({
      ...greenGateInput(),
      anchors: [{ anchorKey: "anchor|x", role: "behavior", disposition: "reviewed_internal", evidence: [{ path: "src/x.ts" }] }],
    });
    expect(noKind.checks.anchorAccountingComplete).toBe(false);
    const noEvidence = evaluateBehaviorActivationGate({
      ...greenGateInput(),
      anchors: [{ anchorKey: "anchor|x", role: "behavior", disposition: "reviewed_internal", internalKind: "pure_technical", evidence: [] }],
    });
    expect(noEvidence.checks.anchorAccountingComplete).toBe(false);
    expect(noEvidence.unaccountedAnchorKeys).toEqual(["anchor|x"]);
  });

  it("keeps covered_elsewhere accounted only while its relations survive the merge", () => {
    const resolved = evaluateBehaviorActivationGate({
      ...greenGateInput(),
      anchors: [{
        anchorKey: "anchor|x",
        role: "behavior",
        disposition: "reviewed_internal",
        internalKind: "covered_elsewhere",
        evidence: [{ path: "src/x.ts" }],
        relatedUnitKeys: ["unit|a"],
      }],
    });
    expect(resolved.checks.anchorAccountingComplete).toBe(true);
    // 关联在合并后丢失：该锚点回到 unresolved，门禁失败（D4/§7 错误表）
    const lostUnit = evaluateBehaviorActivationGate({
      ...greenGateInput(),
      anchors: [{
        anchorKey: "anchor|x",
        role: "behavior",
        disposition: "reviewed_internal",
        internalKind: "covered_elsewhere",
        evidence: [{ path: "src/x.ts" }],
        relatedUnitKeys: ["unit|gone"],
      }],
    });
    expect(lostUnit.activate).toBe(false);
    expect(lostUnit.checks.anchorAccountingComplete).toBe(false);
    expect(lostUnit.unaccountedAnchorKeys).toEqual(["anchor|x"]);
    const lostScenario = evaluateBehaviorActivationGate({
      ...greenGateInput(),
      anchors: [{
        anchorKey: "anchor|x",
        role: "behavior",
        disposition: "reviewed_internal",
        internalKind: "covered_elsewhere",
        evidence: [{ path: "src/x.ts" }],
        relatedScenarioRefs: ["scenario|lost"],
      }],
    });
    expect(lostScenario.checks.anchorAccountingComplete).toBe(false);
  });

  it("rejects when the existing evidence or merge checks did not pass", () => {
    const evidence = evaluateBehaviorActivationGate({ ...greenGateInput(), existingEvidenceChecksPassed: false });
    expect(evidence.activate).toBe(false);
    expect(evidence.checks.existingEvidenceChecksPassed).toBe(false);
    const merge = evaluateBehaviorActivationGate({ ...greenGateInput(), existingMergeChecksPassed: false });
    expect(merge.activate).toBe(false);
    expect(merge.checks.existingMergeChecksPassed).toBe(false);
  });
});

describe("resolveProductDescription (D10 摘要降级)", () => {
  const mergedFeatures: ProductDescriptionInput["mergedFeatures"] = [
    { name: "统一登录", summary: "OAuth 登录", scenarios: [{ evidence: [{ path: "lib/auth.ts", startLine: 8 }] }] },
    { name: "规格导出", summary: "导出 JSON", scenarios: [{ evidence: [{ path: "lib/export.ts" }] }] },
  ];
  const reservation: BudgetReservation = {
    reservationId: "res-1",
    runId: 7,
    attemptId: "product_summary",
    kind: "product_summary",
    reservedLlmCalls: 1,
    reservedInputTokens: 128_000,
    reservedOutputTokens: 8_192,
    reservedCostAmount: 5,
  };
  const baseInput = (): ProductDescriptionInput => ({
    runId: 7,
    accountId: 3,
    mergedFeatures,
    outputLanguage: "zh-CN",
    reservation,
    previous: null,
    requestCompletion: vi.fn(async () => '{"description":"面向编辑者的产品知识工作台。","evidence":[{"path":"lib/auth.ts","startLine":8}]}'),
  });

  beforeEach(() => {
    budgetMocks.settleBehaviorBudget.mockReset().mockResolvedValue(undefined);
    budgetMocks.releaseUnusedBehaviorBudget.mockReset().mockResolvedValue(undefined);
    budgetMocks.reserveProductSummaryBudget.mockReset().mockResolvedValue(reservation);
  });

  it("generates a summary with in-surface evidence and settles the independent reservation", async () => {
    const input = baseInput();
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("generated");
    expect(outcome.product.description).toBe("面向编辑者的产品知识工作台。");
    expect(outcome.product.evidence).toEqual([{ path: "lib/auth.ts", startLine: 8 }]);
    // 摘要预留独立结算（D9/D10）：settle 恰好一次，绝不走 releaseUnused
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledTimes(1);
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledWith({ reservationId: "res-1" });
    expect(budgetMocks.releaseUnusedBehaviorBudget).not.toHaveBeenCalled();
    // 摘要调用携带 Task 6 计费身份：attemptId/callStage=product_summary
    const request = input.requestCompletion as ReturnType<typeof vi.fn>;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({ runId: 7, accountId: 3, attemptId: "product_summary", callStage: "product_summary" });
  });

  it("drops evidence outside the merged surface and stays generated while some survives", async () => {
    const input = baseInput();
    input.requestCompletion = vi.fn(async () => JSON.stringify({
      description: "面向编辑者的产品知识工作台。",
      evidence: [{ path: "lib/auth.ts", startLine: 8 }, { path: "src/hallucinated.ts", startLine: 1 }],
    }));
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("generated");
    expect(outcome.product.evidence).toEqual([{ path: "lib/auth.ts", startLine: 8 }]);
  });

  it("falls back when every evidence item is outside the merged surface (no new facts)", async () => {
    const input = baseInput();
    input.requestCompletion = vi.fn(async () => '{"description":"虚构能力。","evidence":[{"path":"src/hallucinated.ts"}]}');
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.product).toEqual({ description: "", evidence: [] });
    // 摘要失败也照常结算预留（未知用量按上界入账，不按零）
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledTimes(1);
  });

  it("falls back on malformed JSON or an empty description", async () => {
    const malformed = baseInput();
    malformed.requestCompletion = vi.fn(async () => "not json at all");
    await expect(resolveProductDescription(malformed)).resolves.toMatchObject({ status: "unavailable", product: { description: "", evidence: [] } });
    const empty = baseInput();
    empty.requestCompletion = vi.fn(async () => '{"description":"  ","evidence":[{"path":"lib/auth.ts"}]}');
    await expect(resolveProductDescription(empty)).resolves.toMatchObject({ status: "unavailable" });
  });

  it("preserves the previous description on summary failure when the language did not switch", async () => {
    const input = baseInput();
    input.requestCompletion = vi.fn(async () => {
      throw new Error("gateway timeout");
    });
    input.previous = { description: "既有简介", evidence: [{ path: "lib/auth.ts", startLine: 1 }], language: "zh-CN" };
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("preserved");
    expect(outcome.product).toEqual({ description: "既有简介", evidence: [{ path: "lib/auth.ts", startLine: 1 }] });
  });

  it("never preserves old-language text on a language switch", async () => {
    const input = baseInput();
    input.outputLanguage = "en";
    input.requestCompletion = vi.fn(async () => {
      throw new Error("gateway timeout");
    });
    input.previous = { description: "旧语种简介", evidence: [{ path: "lib/auth.ts" }], language: "zh-CN" };
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.product.description).toBe("");
    expect(outcome.product.description).not.toContain("旧语种简介");
  });

  it("propagates unknown-usage settlement as a D9 hard block even when the summary succeeded", async () => {
    budgetMocks.settleBehaviorBudget.mockRejectedValue(
      new (await import("../lib/behavior-run-budget")).BehaviorBudgetError("behavior_budget_usage_unknown", "unknown usage under a configured hard cap"),
    );
    await expect(resolveProductDescription(baseInput())).rejects.toMatchObject({ code: "behavior_budget_usage_unknown" });
  });

  it("uses the run output language for the summary prompt", async () => {
    const input = baseInput();
    input.outputLanguage = "en";
    const request = vi.fn(async (_messages: Array<{ role: string; content: string }>) => '{"description":"A product knowledge workspace for editors.","evidence":[{"path":"lib/auth.ts","startLine":8}]}');
    input.requestCompletion = request;
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("generated");
    const userContent = String(request.mock.calls[0][0].find((message: { role: string }) => message.role === "user")?.content ?? "");
    expect(userContent).toContain("audience");
    expect(userContent).not.toContain("面向");
  });

  it("skips reserveProductSummaryBudget when a pre-reserved reservation is supplied (Task 13 review fix)", async () => {
    const outcome = await resolveProductDescription(baseInput());
    expect(outcome.status).toBe("generated");
    expect(budgetMocks.reserveProductSummaryBudget).not.toHaveBeenCalled();
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledTimes(1);
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledWith({ reservationId: "res-1" });
  });

  it("reserves the summary budget internally when no reservation is supplied and settles it exactly once", async () => {
    const input = baseInput();
    delete input.reservation;
    budgetMocks.reserveProductSummaryBudget.mockResolvedValue({ ...reservation, reservationId: "res-auto" });
    const outcome = await resolveProductDescription(input);
    expect(outcome.status).toBe("generated");
    expect(budgetMocks.reserveProductSummaryBudget).toHaveBeenCalledTimes(1);
    expect(budgetMocks.reserveProductSummaryBudget).toHaveBeenCalledWith(7);
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledTimes(1);
    expect(budgetMocks.settleBehaviorBudget).toHaveBeenCalledWith({ reservationId: "res-auto" });
  });
});

import { describe, expect, it } from "vitest";
import { parseComparison } from "../scripts/measure-inventory-analysis";

/**
 * Task 15 fix · 离线测量脚本的输入契约（fail closed）：
 *  - outputEvaluation 每仓必填（缺失即输入错误退出 3，绝不静默跳过误报/证据门禁）；
 *  - behaviors 至少 30 条（与 schema minItems 一致；统计层对有效解析但样本不足的
 *    输入仍保留 inconclusive 语义——脚本只管输入校验）；
 *  - 每条冻结行为必须带双路径 hits；processGates 三布尔必须存在。
 */

function validComparison(behaviorCount = 30): Record<string, unknown> {
  return {
    schema: "behavior-inventory-v1",
    repo: "acme/demo",
    revision: { beforeSha: null, afterSha: "c0e1d02" },
    frozenAt: "2026-11-20T00:00:00Z",
    frozenBy: "reviewer-a",
    behaviors: Array.from({ length: behaviorCount }, (_, index) => ({
      behaviorId: `B${index + 1}`,
      sourceLocation: { path: "src/a.ts", startLine: 1, endLine: 10 },
      description: "行为",
      observableOutcome: "结果",
      evidence: [],
      hits: { legacy: true, inventory: true },
    })),
    outputEvaluation: {
      legacy: { evaluatedOutputs: 100, falsePositives: 1, evidenceSupported: 99 },
      inventory: { evaluatedOutputs: 120, falsePositives: 1, evidenceSupported: 119 },
    },
    processGates: { inventoryManifestValid: true, coverageGatesPassed: true, activationGatePassed: true },
  };
}

describe("parseComparison (fail-closed input contract)", () => {
  it("parses a valid comparison and passes the process-gate flag through", () => {
    const { comparison } = parseComparison(validComparison(), "fixture.json");
    expect(comparison.repo).toBe("acme/demo");
    expect(comparison.pairs).toHaveLength(30);
    expect(comparison.processGatesPassed).toBe(true);
    expect(comparison.falsePositives?.legacy.evaluatedOutputs).toBe(100);
    expect(comparison.falsePositives?.inventory.evaluatedOutputs).toBe(120);
  });

  it("rejects a comparison without outputEvaluation (fail closed, never skip the auxiliary gates)", () => {
    const input = validComparison();
    delete input.outputEvaluation;
    expect(() => parseComparison(input, "fixture.json")).toThrow(/outputEvaluation/);
  });

  it("rejects fewer than 30 frozen behaviors with a clear input error", () => {
    expect(() => parseComparison(validComparison(29), "fixture.json")).toThrow(/30/);
  });

  it("rejects a behavior without two-path hits (the frozen set must be fully judged)", () => {
    const input = validComparison();
    (input.behaviors as Array<Record<string, unknown>>)[3].hits = { legacy: true };
    expect(() => parseComparison(input, "fixture.json")).toThrow(/hits/);
  });

  it("rejects a comparison without the three process-gate booleans", () => {
    const input = validComparison();
    input.processGates = { inventoryManifestValid: true, coverageGatesPassed: true };
    expect(() => parseComparison(input, "fixture.json")).toThrow(/processGates/);
  });

  it("marks a repo with a false process gate as gate-failed (stats still computable)", () => {
    const input = validComparison();
    (input.processGates as Record<string, unknown>).activationGatePassed = false;
    const { comparison } = parseComparison(input, "fixture.json");
    expect(comparison.processGatesPassed).toBe(false);
  });
});

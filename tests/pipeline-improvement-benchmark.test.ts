import { describe, expect, it } from "vitest";
import type { RepoComparison } from "../lib/behavior-benchmark";
import {
  evaluatePipelineImprovement,
  type ImprovementRepoInput,
  type PipelineCost,
  type PipelineExperimentIdentity,
  type PipelineOutputFacts,
  type PipelineUsage,
} from "../lib/pipeline-improvement-benchmark";

function comparison(inventoryHits: number, legacyHits = 0): RepoComparison {
  return {
    repo: "gzhanlei/codelphi",
    processGatesPassed: true,
    pairs: Array.from({ length: 30 }, (_, index) => ({
      behaviorId: `B-${index + 1}`,
      legacyHit: index < legacyHits,
      inventoryHit: index < inventoryHits,
    })),
    falsePositives: {
      legacy: { falsePositives: 0, evaluatedOutputs: 100 },
      inventory: { falsePositives: 0, evaluatedOutputs: 100 },
    },
    evidenceSupport: {
      legacy: { supported: 100, evaluatedOutputs: 100 },
      inventory: { supported: 100, evaluatedOutputs: 100 },
    },
  };
}

function identity(): PipelineExperimentIdentity {
  return {
    repo: "gzhanlei/codelphi",
    beforeSha: null,
    afterSha: "2659429e588da466fcb712ba096531343aa75d08",
    benchmarkTruthVersion: "truth-v1",
    model: "deepseek-flash",
    modelConfigHash: "model-v1",
    outputLanguage: "zh-CN",
    budgetConfigHash: "budget-v1",
    pricingConfigHash: "pricing-v1",
    cacheCondition: "cold",
    legacyResult: { runId: 1, outputHash: "legacy-output-v1" },
    baselineCodeSha: "2659429e588da466fcb712ba096531343aa75d08",
    candidateCodeSha: "0a81d7e000000000000000000000000000000000",
    describePromptHash: { baseline: "describe-v1", candidate: "describe-v1" },
    judgePromptBaselineHash: { baseline: "judge-v1", candidate: "judge-v1" },
    repairPromptBaselineHash: { baseline: "repair-v1", candidate: "repair-v1" },
  };
}

function cost(overrides: Partial<PipelineCost> = {}): PipelineCost {
  return {
    llmCalls: 100,
    totalTokens: 10_000,
    costAmount: 1,
    currency: "CNY",
    pricingConfigHash: "pricing-v1",
    ...overrides,
  };
}

function usage(overrides: Partial<PipelineUsage["tasks"][number]> = {}): PipelineUsage {
  return {
    tasks: [{
      taskKey: "task-1",
      total: 2,
      describe: 1,
      judge: 1,
      semanticRepair: 0,
      reusedTerminal: false,
      ...overrides,
    }],
    productSummary: 1,
  };
}

function output(overrides: Partial<PipelineOutputFacts> = {}): PipelineOutputFacts {
  return {
    featureCount: 100,
    scenarioCount: 1_000,
    duplicateClusters: 2,
    factInterpretationErrors: 0,
    activationPassed: true,
    ...overrides,
  };
}

function input(overrides: Partial<ImprovementRepoInput> = {}): ImprovementRepoInput {
  return {
    identity: identity(),
    baseline: comparison(29),
    candidate: comparison(30),
    baselineCost: cost(),
    candidateCost: cost({ llmCalls: 35, totalTokens: 6_000, costAmount: 0.6 }),
    baselineUsage: usage(),
    candidateUsage: usage(),
    baselineLegacyOutputHash: "legacy-output-v1",
    candidateLegacyOutputHash: "legacy-output-v1",
    baselineBenchmarkTruthVersion: "truth-v1",
    candidateBenchmarkTruthVersion: "truth-v1",
    baselineOutput: output(),
    candidateOutput: output(),
    ...overrides,
  };
}

describe("evaluatePipelineImprovement", () => {
  it("passes at the exact call, token, cost and fragmentation limits", () => {
    const result = evaluatePipelineImprovement([input({
      candidateOutput: output({ featureCount: 105, scenarioCount: 1_100 }),
    })]);
    expect(result.status).toBe("passed");
    expect(result.adoptionReady).toBe(true);
  });

  it("passes equal recall without requiring a repaired omission", () => {
    expect(evaluatePipelineImprovement([input({ baseline: comparison(30), candidate: comparison(30) })]).status).toBe("passed");
  });

  it("fails when candidate recall drops", () => {
    const result = evaluatePipelineImprovement([input({ candidate: comparison(28) })]);
    expect(result.status).toBe("failed");
    expect(result.reasons.join("\n")).toContain("召回");
  });

  it("fails above the call, token or actual-cost ratios", () => {
    expect(evaluatePipelineImprovement([input({ candidateCost: cost({ llmCalls: 35.01, totalTokens: 6_000, costAmount: 0.6 }) })]).status).toBe("failed");
    expect(evaluatePipelineImprovement([input({ candidateCost: cost({ llmCalls: 35, totalTokens: 6_001, costAmount: 0.6 }) })]).status).toBe("failed");
    expect(evaluatePipelineImprovement([input({ candidateCost: cost({ llmCalls: 35, totalTokens: 6_000, costAmount: 0.6001 }) })]).status).toBe("failed");
  });

  it("fails above feature or scenario fragmentation limits", () => {
    expect(evaluatePipelineImprovement([input({ candidateOutput: output({ featureCount: 105.01 }) })]).status).toBe("failed");
    expect(evaluatePipelineImprovement([input({ candidateOutput: output({ scenarioCount: 1_100.01 }) })]).status).toBe("failed");
  });

  it("fails when duplicate clusters or fact interpretation errors increase", () => {
    expect(evaluatePipelineImprovement([input({ candidateOutput: output({ duplicateClusters: 3 }) })]).status).toBe("failed");
    expect(evaluatePipelineImprovement([input({ candidateOutput: output({ factInterpretationErrors: 1 }) })]).status).toBe("failed");
  });

  it("fails when a task stage or semantic repair adds a call", () => {
    expect(evaluatePipelineImprovement([input({ candidateUsage: usage({ judge: 2, total: 3 }) })]).status).toBe("failed");
    expect(evaluatePipelineImprovement([input({ candidateUsage: usage({ semanticRepair: 1, total: 3 }) })]).status).toBe("failed");
  });

  it("fails when a reused terminal task receives a new call", () => {
    expect(evaluatePipelineImprovement([input({ candidateUsage: usage({ reusedTerminal: true }) })]).status).toBe("failed");
  });

  it("separates experiment success from activation readiness", () => {
    const result = evaluatePipelineImprovement([input({ candidateOutput: output({ activationPassed: false }) })]);
    expect(result.status).toBe("passed");
    expect(result.adoptionReady).toBe(false);
  });

  it("is inconclusive for mismatched experiment identity and shared legacy results", () => {
    expect(evaluatePipelineImprovement([input({ identity: { ...identity(), repo: "other/repo" } })]).status).toBe("inconclusive");
    expect(evaluatePipelineImprovement([input({ candidateBenchmarkTruthVersion: "truth-v2" })]).status).toBe("inconclusive");
    expect(evaluatePipelineImprovement([input({ candidate: comparison(30, 1) })]).status).toBe("inconclusive");
    expect(evaluatePipelineImprovement([input({ candidateLegacyOutputHash: "another-legacy-run" })]).status).toBe("inconclusive");
  });

  it("is inconclusive for missing or incomparable cost and task measurements", () => {
    expect(evaluatePipelineImprovement([input({ candidateCost: cost({ llmCalls: 35, totalTokens: 6_000, costAmount: 0.6, currency: "USD" }) })]).status).toBe("inconclusive");
    expect(evaluatePipelineImprovement([input({ candidateCost: cost({ llmCalls: 35, totalTokens: 6_000, costAmount: 0.6, pricingConfigHash: "pricing-v2" }) })]).status).toBe("inconclusive");
    expect(evaluatePipelineImprovement([input({ candidateUsage: usage({ taskKey: "task-2" }) })]).status).toBe("inconclusive");
  });

  it("prioritizes a definite failure over an incomparable measurement", () => {
    expect(evaluatePipelineImprovement([input({
      candidate: comparison(28),
      candidateCost: cost({ llmCalls: 35, totalTokens: 6_000, costAmount: 0.6, currency: "USD" }),
    })]).status).toBe("failed");
  });

  it("keeps candidate quality inconclusive when its statistical gate is inconclusive", () => {
    const baseline = comparison(28);
    const candidate = comparison(29);
    baseline.pairs = baseline.pairs.slice(0, 29);
    candidate.pairs = candidate.pairs.slice(0, 29);
    expect(evaluatePipelineImprovement([input({ baseline, candidate })]).status).toBe("inconclusive");
  });
});

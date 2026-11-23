import { describe, expect, it } from "vitest";
import {
  buildExperimentPrompts,
  buildMeasurements,
  executeExperiment,
  ExperimentInputError,
  extractWindowAnchors,
  loadFrozenSources,
  parseUsageTokens,
  summarizeExperiment,
  validateConfig,
  validateTruth,
  type CompletionExecutor,
  type ExperimentConfigFile,
  type ExperimentTruthFile,
  type GitShow,
  type RunJudgment,
} from "../scripts/legacy-guard-anchor-experiment";

const ANALYSIS_SOURCE = [
  "export function assertLatestRun(latestRunId: number, runId: number) {",
  "  if (latestRunId !== runId) throw new Error(\"Analysis superseded\");",
  "  return runId;",
  "}",
].join("\n");

const ENV_SOURCE = "export function analysisConvergenceRounds() { return 1; }\n";

const fakeGitShow: GitShow = (_revision, path) => {
  if (path === "lib/analysis.ts") return ANALYSIS_SOURCE;
  if (path === "lib/env.ts") return ENV_SOURCE;
  throw new Error(`unexpected path ${path}`);
};

const BASE_CONFIG = {
  schemaVersion: 1,
  experiment: "legacy-guard-anchor-v1",
  revision: "2659429e588da466fcb712ba096531343aa75d08",
  sources: [
    { path: "lib/analysis.ts", startLine: 1, endLine: 4 },
    { path: "lib/env.ts", startLine: 1, endLine: 1 },
  ],
  change: {
    message: "test change",
    files: [{ path: "lib/analysis.ts", status: "modified", patch: "@@ -1 +1 @@" }],
  },
  model: "ds-flash",
  parameters: { temperature: 0, maxTokens: 16000, stream: false },
  arms: ["A", "B", "C", "D"],
  repetitionsPerArm: 3,
  outputLanguage: "zh-CN",
  // 结构合法的占位 hash（frozenConfig() 会用真实计算值覆盖），
  // 保证 validateConfig 的 schema 先行通过、arm/repetition/参数校验真正被触达。
  promptSha256: { A: "a".repeat(64), B: "b".repeat(64), C: "c".repeat(64), D: "d".repeat(64) },
} as unknown as ExperimentConfigFile;

const REVIEWED_TRUTH: ExperimentTruthFile = {
  schemaVersion: 1,
  experiment: "legacy-guard-anchor-v1",
  revision: "2659429e588da466fcb712ba096531343aa75d08",
  truths: [
    {
      id: "CB-18",
      kind: "anchor",
      statement: "只有最新 run 可激活规格，旧 run 不覆盖新 run 的结果。",
      evidence: [{ path: "lib/analysis.ts", startLine: 62, endLine: 66 }],
      independentlyReviewed: true,
      reviewer: "reviewer-x",
      reviewedAt: "2026-11-23",
    },
    {
      id: "CB-30",
      kind: "non-anchor",
      statement: "边际场景增益严格 < epsilon 才停止，增益有上限。",
      evidence: [
        { path: "lib/analysis.ts", startLine: 577, endLine: 610 },
        { path: "lib/env.ts", startLine: 47, endLine: 62 },
      ],
      independentlyReviewed: true,
      reviewer: "reviewer-x",
      reviewedAt: "2026-11-23",
    },
  ],
};

const PRICING_RAW = JSON.stringify({ "ds-flash": { input: 2, output: 8, cache: 1, version: "v1" } });

const VALID_CONTENT = JSON.stringify({
  product: { description: "测试产品", evidence: [{ path: "lib/analysis.ts", startLine: 1 }] },
  release: { title: "t", summary: "s" },
  changes: [],
  features: [
    {
      name: "规格激活",
      summary: "s",
      scenarios: [
        {
          reference: "HP-1",
          context: "c",
          action: "a",
          outcome: "o",
          category: "happy",
          evidence: [{ path: "lib/analysis.ts", startLine: 1 }],
        },
      ],
    },
  ],
});

function frozenConfig(): ExperimentConfigFile {
  const sources = loadFrozenSources(BASE_CONFIG, fakeGitShow);
  const anchors = extractWindowAnchors(BASE_CONFIG, fakeGitShow);
  const prompts = buildExperimentPrompts(BASE_CONFIG, sources, anchors);
  return {
    ...BASE_CONFIG,
    promptSha256: { A: prompts.A.sha256, B: prompts.B.sha256, C: prompts.C.sha256, D: prompts.D.sha256 },
  };
}

function countingExecutor(impl: CompletionExecutor): { executor: CompletionExecutor; calls: number } {
  const state = { calls: 0 };
  const executor: CompletionExecutor = async (messages) => {
    state.calls += 1;
    return impl(messages);
  };
  return { executor, calls: state.calls };
}

const okExecutor: CompletionExecutor = async () => ({
  content: VALID_CONTENT,
  usageRaw: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 20 },
  providerRequestId: "req-1",
  finishReason: "stop",
});

function failIfCalled(): CompletionExecutor {
  return async () => {
    throw new Error("executor must not be called");
  };
}

function makeJudgments(overrides: Partial<RunJudgment> = {}): RunJudgment[] {
  const cb18ByArm: Record<string, boolean[]> = { A: [false, false, false], B: [false, false, false], C: [true, true, true], D: [true, true, true] };
  const judgments: RunJudgment[] = [];
  for (const arm of ["A", "B", "C", "D"] as const) {
    for (const repetition of [1, 2, 3] as const) {
      judgments.push({
        arm,
        repetition,
        cb18Hit: cb18ByArm[arm][repetition - 1],
        nonAnchorHits: 1,
        overallHits: arm === "C" || arm === "D" ? 3 : 2,
        falsePositives: 0,
        falseDeltas: 0,
        evidenceAllowSetUnchanged: true,
        manualProtected: true,
        independentlyReviewed: true,
        reviewer: "reviewer-x",
        ...overrides,
      });
    }
  }
  return judgments;
}

describe("validateTruth", () => {
  it("rejects truth that is not independently reviewed", () => {
    const truth = {
      ...REVIEWED_TRUTH,
      truths: REVIEWED_TRUTH.truths.map((entry) => ({ ...entry, independentlyReviewed: false, reviewer: null, reviewedAt: null })),
    };
    expect(() => validateTruth(truth)).toThrowError(ExperimentInputError);
    try {
      validateTruth(truth);
    } catch (error) {
      expect((error as ExperimentInputError).reasons).toContain("truth_not_independently_reviewed:CB-18");
      expect((error as ExperimentInputError).reasons).toContain("truth_not_independently_reviewed:CB-30");
    }
  });

  it("rejects truth files missing CB-18 or CB-30", () => {
    expect(() => validateTruth({ ...REVIEWED_TRUTH, truths: [REVIEWED_TRUTH.truths[0]] })).toThrowError(ExperimentInputError);
  });
});

describe("validateConfig", () => {
  function reasonsOf(config: unknown): string[] {
    try {
      validateConfig(config);
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentInputError);
      return (error as ExperimentInputError).reasons;
    }
    throw new Error("validateConfig should have thrown");
  }

  it("rejects configurations that are not exactly 4 arms x 3 repetitions", () => {
    expect(reasonsOf({ ...BASE_CONFIG, repetitionsPerArm: 2 })).toContain("repetitions_per_arm_must_be_3");
    expect(reasonsOf({ ...BASE_CONFIG, arms: ["A", "B", "C", "C"] })).toContain("arms_must_be_exactly_A_B_C_D");
    // 臂数量不足 4 在 schema 层即失败封闭（zod length(4)），同样不得进入执行。
    expect(reasonsOf({ ...BASE_CONFIG, arms: ["A", "B", "C"] }).some((reason) => reason.startsWith("config_schema_invalid"))).toBe(true);
  });

  it("rejects parameters that do not match the frozen gateway call", () => {
    expect(reasonsOf({ ...BASE_CONFIG, parameters: { temperature: 0.5, maxTokens: 16000, stream: false } }))
      .toContain("parameters_mismatch_frozen_gateway_call");
  });
});

describe("executeExperiment", () => {
  it("refuses to call the executor when truth is not independently reviewed", async () => {
    const truth = {
      ...REVIEWED_TRUTH,
      truths: REVIEWED_TRUTH.truths.map((entry) => ({ ...entry, independentlyReviewed: false })),
    };
    await expect(
      executeExperiment({ config: frozenConfig(), truth, executor: failIfCalled(), gitShow: fakeGitShow, model: "ds-flash", pricingRaw: PRICING_RAW }),
    ).rejects.toThrowError(ExperimentInputError);
  });

  it("refuses to call the executor when prompt hashes do not match the frozen config", async () => {
    const config = { ...frozenConfig(), promptSha256: { A: "0".repeat(64), B: "0".repeat(64), C: "0".repeat(64), D: "0".repeat(64) } };
    await expect(
      executeExperiment({ config, truth: REVIEWED_TRUTH, executor: failIfCalled(), gitShow: fakeGitShow, model: "ds-flash", pricingRaw: PRICING_RAW }),
    ).rejects.toThrowError(ExperimentInputError);
  });

  it("aborts inconclusive when pricing is unavailable, without calling the executor", async () => {
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor: failIfCalled(),
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: undefined,
    });
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toBe("pricing_unpriced");
    expect(result.runs).toHaveLength(0);
  });

  it("aborts inconclusive when real usage cannot be parsed, keeping the raw record", async () => {
    const state = { calls: 0 };
    const executor: CompletionExecutor = async () => {
      state.calls += 1;
      return { content: VALID_CONTENT, usageRaw: null, providerRequestId: "req-x", finishReason: "stop" };
    };
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toContain("usage_missing");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].usage).toBeNull();
    expect(result.runs[0].actualCost).toBeNull();
    expect(result.runs[0].rawOutput).toBe(VALID_CONTENT);
    expect(state.calls).toBe(1);
  });

  it("aborts on truncated output (finishReason=length) instead of counting it as a valid repetition", async () => {
    const state = { calls: 0 };
    const executor: CompletionExecutor = async () => {
      state.calls += 1;
      return {
        content: VALID_CONTENT.slice(0, 40),
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        providerRequestId: "req-len",
        finishReason: "length",
      };
    };
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toContain("output_truncated");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].error).toBe("output_truncated");
    expect(result.runs[0].usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 0 });
    expect(state.calls).toBe(1);
  });

  it("aborts on unparseable output instead of counting it as a valid repetition", async () => {
    const state = { calls: 0 };
    const executor: CompletionExecutor = async () => {
      state.calls += 1;
      return {
        content: "this is not JSON",
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        providerRequestId: "req-bad",
        finishReason: "stop",
      };
    };
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toContain("parse_error");
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].parseError).not.toBeNull();
    expect(result.runs[0].error).toBe("parse_error");
    expect(state.calls).toBe(1);
  });

  it("runs 4 arms x 3 repetitions once each and records raw output, full usage, repair/retry counts and cost basis", async () => {
    const state = { calls: 0 };
    const executor: CompletionExecutor = async (messages) => {
      state.calls += 1;
      expect(messages).toHaveLength(2);
      return {
        content: VALID_CONTENT,
        usageRaw: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 20 },
        providerRequestId: `req-${state.calls}`,
        finishReason: "stop",
      };
    };
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(result.status).toBe("completed");
    expect(state.calls).toBe(12);
    expect(result.runs).toHaveLength(12);
    expect(result.runs.map((run) => `${run.arm}${run.repetition}`)).toEqual([
      "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3", "D1", "D2", "D3",
    ]);
    for (const run of result.runs) {
      expect(run.rawOutput).toBe(VALID_CONTENT);
      expect(run.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheHitTokens: 20 });
      expect(run.usageRaw).toEqual({ prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 20 });
      expect(run.llmCalls).toBe(1);
      expect(run.repairCount).toBe(0);
      expect(run.retryCount).toBe(0);
      expect(run.pricing.version).toBe("v1");
      expect(run.pricing.currency).toBe("CNY");
      expect(run.cacheCondition).toContain("flat");
      expect(run.actualCost).toBeCloseTo((80 / 1_000_000) * 2 + (50 / 1_000_000) * 8 + (20 / 1_000_000) * 1, 12);
      expect(run.promptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(run.error).toBeNull();
      expect(run.parseError).toBeNull();
    }
  });
});

describe("buildMeasurements", () => {
  it("refuses to build measurements without complete judgments", async () => {
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor: okExecutor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(() => buildMeasurements(result.runs, [])).toThrowError(ExperimentInputError);
    expect(() => buildMeasurements(result.runs, makeJudgments().slice(0, 11))).toThrowError(ExperimentInputError);
  });

  it("refuses to count truncated or unparseable runs as measurable repetitions", async () => {
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor: okExecutor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    const truncated = result.runs.map((run, index) => (index === 0 ? { ...run, error: "output_truncated" } : run));
    try {
      buildMeasurements(truncated, makeJudgments());
      throw new Error("buildMeasurements should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ExperimentInputError);
      expect((error as ExperimentInputError).reasons.join(",")).toContain("run_not_measurable:A:1");
    }
    const unparseable = result.runs.map((run, index) => (index === 0 ? { ...run, parseError: "bad json" } : run));
    expect(() => buildMeasurements(unparseable, makeJudgments())).toThrowError(ExperimentInputError);
  });
});

describe("summarizeExperiment", () => {
  async function completedRuns() {
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor: okExecutor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    return result.runs;
  }

  it("is inconclusive when truth is not independently reviewed, even with reviewed judgments", async () => {
    const runs = await completedRuns();
    const truth = {
      ...REVIEWED_TRUTH,
      truths: REVIEWED_TRUTH.truths.map((entry) => ({ ...entry, independentlyReviewed: false })),
    };
    const verdict = summarizeExperiment(truth, runs, makeJudgments());
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons).toContain("truth_not_independently_reviewed");
  });

  it("is inconclusive when judgments are not independently reviewed", async () => {
    const runs = await completedRuns();
    const verdict = summarizeExperiment(REVIEWED_TRUTH, runs, makeJudgments({ independentlyReviewed: false, reviewer: null }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons).toContain("not_independently_reviewed");
  });

  it("is inconclusive when pricing versions are not comparable across runs", async () => {
    const runs = await completedRuns();
    const mutated = runs.map((run, index) =>
      index < 6 ? run : { ...run, pricing: { ...run.pricing, version: "v2" } });
    const verdict = summarizeExperiment(REVIEWED_TRUTH, mutated, makeJudgments());
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons).toContain("pricing_version_not_comparable");
  });

  it("is inconclusive when usage is missing on any run, never a zero-cost pass", async () => {
    const runs = await completedRuns();
    const mutated = runs.map((run, index) =>
      index === 0 ? { ...run, usage: null, actualCost: null } : run);
    const verdict = summarizeExperiment(REVIEWED_TRUTH, mutated, makeJudgments());
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons).toContain("usage_missing");
  });

  it("is inconclusive when a run set aborted mid-experiment (defective repetition removed from measurement)", async () => {
    const state = { calls: 0 };
    const executor: CompletionExecutor = async () => {
      state.calls += 1;
      if (state.calls === 4) {
        return {
          content: VALID_CONTENT,
          usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
          providerRequestId: "req-len",
          finishReason: "length",
        };
      }
      return {
        content: VALID_CONTENT,
        usageRaw: { prompt_tokens: 100, completion_tokens: 50 },
        providerRequestId: `req-${state.calls}`,
        finishReason: "stop",
      };
    };
    const result = await executeExperiment({
      config: frozenConfig(),
      truth: REVIEWED_TRUTH,
      executor,
      gitShow: fakeGitShow,
      model: "ds-flash",
      pricingRaw: PRICING_RAW,
    });
    expect(result.status).toBe("aborted");
    expect(result.runs).toHaveLength(4);
    const recorded = new Set(result.runs.filter((run) => !run.error && !run.parseError).map((run) => `${run.arm}:${run.repetition}`));
    const verdict = summarizeExperiment(
      REVIEWED_TRUTH,
      result.runs.filter((run) => recorded.has(`${run.arm}:${run.repetition}`)),
      makeJudgments().filter((judgment) => recorded.has(`${judgment.arm}:${judgment.repetition}`)),
    );
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons.some((reason) => reason.startsWith("incomplete_arm_repetitions"))).toBe(true);
  });

  it("passes only with reviewed truth, reviewed judgments and comparable cost basis", async () => {
    const runs = await completedRuns();
    const verdict = summarizeExperiment(REVIEWED_TRUTH, runs, makeJudgments());
    expect(verdict.status).toBe("passed");
    expect(verdict.measurements).toHaveLength(12);
  });
});

describe("parseUsageTokens", () => {
  it("parses the DeepSeek/OpenAI usage shape including cache hits", () => {
    expect(parseUsageTokens({ prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheHitTokens: 20,
    });
    expect(parseUsageTokens({ prompt_tokens: 100, completion_tokens: 50 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheHitTokens: 0,
    });
    expect(parseUsageTokens({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 } })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheHitTokens: 30,
    });
  });

  it("returns null for missing or malformed usage", () => {
    expect(parseUsageTokens(null)).toBeNull();
    expect(parseUsageTokens(undefined)).toBeNull();
    expect(parseUsageTokens({})).toBeNull();
    expect(parseUsageTokens({ prompt_tokens: "100", completion_tokens: 50 })).toBeNull();
    expect(parseUsageTokens({ prompt_tokens: 100 })).toBeNull();
  });
});

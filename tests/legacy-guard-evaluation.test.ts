import { describe, expect, it } from "vitest";
import type { GuardExperimentArm } from "../lib/legacy-analysis/guard-prompt";
import {
  evaluateLegacyGuardExperiment,
  type GuardRunMeasurement,
} from "../lib/legacy-analysis/guard-evaluation";

function measurement(
  arm: GuardExperimentArm,
  repetition: 1 | 2 | 3,
  overrides: Partial<GuardRunMeasurement> = {},
): GuardRunMeasurement {
  return {
    arm,
    repetition,
    cb18Hit: false,
    nonAnchorHits: 10,
    overallHits: 12,
    falsePositives: 1,
    falseDeltas: 1,
    llmCalls: 2,
    inputTokens: 1_000,
    outputTokens: 500,
    actualCost: 0.01,
    pricingVersion: "2026-11-v1",
    cacheCondition: "cold-no-cache",
    independentlyReviewed: true,
    evidenceAllowSetUnchanged: true,
    manualProtected: true,
    ...overrides,
  };
}

function armRuns(arm: GuardExperimentArm, overrides: Array<Partial<GuardRunMeasurement>> = [{}, {}, {}]) {
  return ([1, 2, 3] as const).map((repetition, index) => measurement(arm, repetition, overrides[index]));
}

function passingRuns(): GuardRunMeasurement[] {
  return [
    ...armRuns("A", [{ cb18Hit: false }, { cb18Hit: true }, { cb18Hit: false }]),
    ...armRuns("B", [{ cb18Hit: true }, { cb18Hit: true }, { cb18Hit: false }]),
    ...armRuns("C", [{ cb18Hit: true }, { cb18Hit: true }, { cb18Hit: true }]),
    ...armRuns("D", [{ cb18Hit: true }, { cb18Hit: true }, { cb18Hit: true }]),
  ];
}

function reasons(result: { reasons: string[] }) {
  return result.reasons.join(" ");
}

describe("legacy guard experiment offline gate", () => {
  it("passes when C improves CB-18, B does not regress and D dominates without extra cost", () => {
    const result = evaluateLegacyGuardExperiment(passingRuns());
    expect(result.status).toBe("passed");
    expect(result.reasons).toEqual([]);
  });

  it("fails when arm A already hits CB-18 in all three repetitions (no improvement room)", () => {
    const runs = passingRuns().map((run) => run.arm === "A" ? { ...run, cb18Hit: true } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("a_cb18_saturated_no_improvement_room");
  });

  it("fails when arm C shows no CB-18 improvement over A", () => {
    const runs = passingRuns().map((run) =>
      run.arm === "C" && run.repetition !== 1 ? { ...run, cb18Hit: false } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("c_no_cb18_improvement");
  });

  it("fails when arm B regresses non-anchor recall", () => {
    const runs = passingRuns().map((run) => run.arm === "B" ? { ...run, nonAnchorHits: 9 } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("b_non_anchor_recall_regression");
  });

  it("fails when arm D falls below C on CB-18", () => {
    const runs = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 3 ? { ...run, cb18Hit: false } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("d_cb18_below_c");
  });

  it("fails when arm D does not beat B on CB-18", () => {
    const runs = passingRuns().map((run) => {
      if (run.arm === "C" || run.arm === "D") {
        return run.repetition === 3 ? { ...run, cb18Hit: false } : run;
      }
      return run;
    });
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("d_cb18_not_above_b");
  });

  it("fails when arm D regresses non-anchor recall", () => {
    const runs = passingRuns().map((run) => run.arm === "D" ? { ...run, nonAnchorHits: 8 } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("d_non_anchor_recall_regression");
  });

  it("fails when arm D increases false positives or false deltas", () => {
    const falsePositives = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 1 ? { ...run, falsePositives: 2 } : run);
    expect(evaluateLegacyGuardExperiment(falsePositives).status).toBe("failed");
    expect(reasons(evaluateLegacyGuardExperiment(falsePositives))).toContain("d_false_positives_increase");

    const falseDeltas = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 2 ? { ...run, falseDeltas: 3 } : run);
    expect(evaluateLegacyGuardExperiment(falseDeltas).status).toBe("failed");
    expect(reasons(evaluateLegacyGuardExperiment(falseDeltas))).toContain("d_false_deltas_increase");
  });

  it("fails when arm D increases calls, tokens or cost", () => {
    const moreCalls = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 1 ? { ...run, llmCalls: 3 } : run);
    expect(reasons(evaluateLegacyGuardExperiment(moreCalls))).toContain("d_llm_calls_increase");

    const moreInput = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 2 ? { ...run, inputTokens: 1_001 } : run);
    expect(reasons(evaluateLegacyGuardExperiment(moreInput))).toContain("d_input_tokens_increase");

    const moreOutput = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 3 ? { ...run, outputTokens: 600 } : run);
    expect(reasons(evaluateLegacyGuardExperiment(moreOutput))).toContain("d_output_tokens_increase");

    const moreCost = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 1 ? { ...run, actualCost: 0.02 } : run);
    expect(reasons(evaluateLegacyGuardExperiment(moreCost))).toContain("d_actual_cost_increase");
  });

  it("aggregates cost over the three repetitions of each arm", () => {
    const higherSum = passingRuns().map((run) => {
      if (run.arm !== "D") return run;
      const cost = run.repetition === 1 ? 0.005 : run.repetition === 2 ? 0.01 : 0.02;
      return { ...run, actualCost: cost };
    });
    const result = evaluateLegacyGuardExperiment(higherSum);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("d_actual_cost_increase");

    const lowerSum = passingRuns().map((run) => {
      if (run.arm !== "D") return run;
      const cost = run.repetition === 1 ? 0.02 : run.repetition === 2 ? 0.005 : 0.004;
      return { ...run, actualCost: cost };
    });
    expect(evaluateLegacyGuardExperiment(lowerSum).status).toBe("passed");
  });

  it("is inconclusive when usage is missing", () => {
    const runs = passingRuns().map((run) =>
      run.arm === "C" && run.repetition === 2
        ? ({ ...run, inputTokens: undefined } as unknown as GuardRunMeasurement)
        : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("inconclusive");
    expect(reasons(result)).toContain("usage_missing");
  });

  it("is inconclusive when pricing or cache conditions are not comparable", () => {
    const pricing = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 1 ? { ...run, pricingVersion: "2026-10-v9" } : run);
    expect(evaluateLegacyGuardExperiment(pricing).status).toBe("inconclusive");
    expect(reasons(evaluateLegacyGuardExperiment(pricing))).toContain("pricing_version_not_comparable");

    const cache = passingRuns().map((run) =>
      run.arm === "B" && run.repetition === 3 ? { ...run, cacheCondition: "warm" } : run);
    expect(evaluateLegacyGuardExperiment(cache).status).toBe("inconclusive");
    expect(reasons(evaluateLegacyGuardExperiment(cache))).toContain("cache_condition_not_comparable");
  });

  it("is inconclusive when a run was not independently reviewed", () => {
    const runs = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 2 ? { ...run, independentlyReviewed: false } : run);
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("inconclusive");
    expect(reasons(result)).toContain("not_independently_reviewed");
  });

  it("is inconclusive when an arm does not have exactly repetitions 1-3", () => {
    const missing = passingRuns().filter((run) => !(run.arm === "C" && run.repetition === 3));
    expect(evaluateLegacyGuardExperiment(missing).status).toBe("inconclusive");
    expect(reasons(evaluateLegacyGuardExperiment(missing))).toContain("incomplete_arm_repetitions");

    const duplicated = [...passingRuns(), measurement("C", 2, { cb18Hit: true })];
    expect(evaluateLegacyGuardExperiment(duplicated).status).toBe("inconclusive");
  });

  it("fails when the evidence allow set changed or manual entries were not protected", () => {
    const allowSet = passingRuns().map((run) =>
      run.arm === "C" && run.repetition === 1 ? { ...run, evidenceAllowSetUnchanged: false } : run);
    expect(evaluateLegacyGuardExperiment(allowSet).status).toBe("failed");
    expect(reasons(evaluateLegacyGuardExperiment(allowSet))).toContain("evidence_allow_set_changed");

    const manual = passingRuns().map((run) =>
      run.arm === "D" && run.repetition === 3 ? { ...run, manualProtected: false } : run);
    expect(evaluateLegacyGuardExperiment(manual).status).toBe("failed");
    expect(reasons(evaluateLegacyGuardExperiment(manual))).toContain("manual_protection_violated");
  });

  it("prioritizes failures over inconclusive conditions", () => {
    const runs = passingRuns().map((run) => {
      if (run.arm === "D" && run.repetition === 1) {
        return { ...run, evidenceAllowSetUnchanged: false, pricingVersion: "other" };
      }
      return run;
    });
    const result = evaluateLegacyGuardExperiment(runs);
    expect(result.status).toBe("failed");
    expect(reasons(result)).toContain("evidence_allow_set_changed");
  });
});

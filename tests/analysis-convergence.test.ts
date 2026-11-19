import { afterEach, describe, expect, it } from "vitest";
import { analysisConvergenceRounds, fullAnalysisMode, shouldRunAnotherConvergenceRound } from "../lib/env";

/** W2 收敛式全量提取（2026-11-19 立项）：多趟提取按边际产出收敛，取代隐形趟数封顶。
 *  契约：默认 1 轮（现行为）；maxRounds 内、边际新增锚定场景 ≥ ε 才再跑一轮。 */

afterEach(() => {
  delete process.env.ANALYSIS_CONVERGENCE_ROUNDS;
  delete process.env.FULL_ANALYSIS_MODE;
});

describe("analysisConvergenceRounds", () => {
  it("defaults to 1 (current behavior, opt-in convergence)", () => {
    delete process.env.ANALYSIS_CONVERGENCE_ROUNDS;
    expect(analysisConvergenceRounds()).toBe(1);
  });

  it("parses a configured value and clamps to [1, 10]", () => {
    process.env.ANALYSIS_CONVERGENCE_ROUNDS = "3";
    expect(analysisConvergenceRounds()).toBe(3);
    process.env.ANALYSIS_CONVERGENCE_ROUNDS = "99";
    expect(analysisConvergenceRounds()).toBe(10);
  });

  it("falls back to 1 on garbage input", () => {
    process.env.ANALYSIS_CONVERGENCE_ROUNDS = "abc";
    expect(analysisConvergenceRounds()).toBe(1);
    process.env.ANALYSIS_CONVERGENCE_ROUNDS = "0";
    expect(analysisConvergenceRounds()).toBe(1);
  });
});

describe("shouldRunAnotherConvergenceRound", () => {
  it("runs while rounds remain and marginal yield meets epsilon", () => {
    expect(shouldRunAnotherConvergenceRound({ roundsRun: 1, scenarioCount: 300, lastCount: 100, maxRounds: 3, epsilon: 5 })).toBe(true);
  });

  it("stops when marginal yield drops below epsilon (converged)", () => {
    expect(shouldRunAnotherConvergenceRound({ roundsRun: 2, scenarioCount: 304, lastCount: 300, maxRounds: 3, epsilon: 5 })).toBe(false);
  });
  it("keeps running when marginal yield equals epsilon (>= epsilon contract)", () => {
    expect(shouldRunAnotherConvergenceRound({ roundsRun: 2, scenarioCount: 305, lastCount: 300, maxRounds: 3, epsilon: 5 })).toBe(true);
  });

  it("stops when max rounds reached even with high yield", () => {
    expect(shouldRunAnotherConvergenceRound({ roundsRun: 3, scenarioCount: 600, lastCount: 100, maxRounds: 3, epsilon: 5 })).toBe(false);
  });
});

describe("fullAnalysisMode routing", () => {
  it("defaults to legacy so the existing partition/convergence flow is unchanged", () => {
    delete process.env.FULL_ANALYSIS_MODE;
    expect(fullAnalysisMode()).toBe("legacy");
  });

  it("falls back to legacy on garbage input", () => {
    process.env.FULL_ANALYSIS_MODE = "enable-the-new-thing";
    expect(fullAnalysisMode()).toBe("legacy");
  });
});

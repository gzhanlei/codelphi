import { describe, expect, it } from "vitest";
import frozenCases from "../docs/benchmark/frozen/legacy-analysis-cases-v1.json";
import frozenBaseline from "../docs/benchmark/frozen/legacy-analysis-baseline-v1.json";
import {
  evaluateLegacyImprovement,
  type LegacyGroundTruthCase,
  type LegacyImprovementInput,
  type LegacyPathMeasurement,
} from "../lib/legacy-analysis-benchmark";

const cases = frozenCases.cases as LegacyGroundTruthCase[];

function measurement(overrides: Partial<LegacyPathMeasurement> = {}): LegacyPathMeasurement {
  return {
    llmCalls: 100,
    totalTokens: 10_000,
    correctedMisses: 0,
    falseDeltaRate: 0.05,
    factInterpretationErrors: 0,
    dependencyHits: 0,
    dependencyFalsePositives: 0,
    staleHits: 0,
    staleMisses: 0,
    pricingVersion: "deepseek-flash-2026-11:offPeak",
    cacheCondition: "cold",
    ...overrides,
  };
}

function validInput(): LegacyImprovementInput {
  return {
    cases,
    baseline: measurement(),
    candidate: measurement({
      totalTokens: 10_500,
      correctedMisses: 3,
      dependencyHits: 2,
      staleHits: 2,
    }),
  };
}

function caseInput(id: string): LegacyImprovementInput {
  const groundTruthCase = cases.find((item) => item.id === id);
  if (!groundTruthCase) throw new Error(`missing test case ${id}`);
  return { ...validInput(), cases: [structuredClone(groundTruthCase)] };
}

describe("legacy analysis frozen ground truth", () => {
  it("contains every pre-registered case with independently fixed expectations", () => {
    expect(cases.map((item) => item.id)).toEqual(expect.arrayContaining([
      "archive_limit",
      "alias_and_shadowing",
      "shared_permission",
      "strict_operator",
      "dynamic_unknown",
      "critical_unknown",
      "refactor_same",
      "refactor_changed",
      "split_unknown",
      "delete_stale",
    ]));
    const archive = cases.find((item) => item.id === "archive_limit");
    expect(archive?.before[0]?.content).toContain("MAX_ARCHIVE_BYTES = 500_000_000");
    const permission = cases.find((item) => item.id === "shared_permission");
    expect(permission?.expected.impacted).toEqual(["uploadFile"]);
    expect(permission?.expected.unaffected).toEqual(["listFiles"]);
  });

  it("preserves the actual frozen L run and receipt provenance", () => {
    expect(frozenBaseline).toMatchObject({
      database: "codelphi_bench_l",
      runId: 82,
      specVersionId: 65,
      outputHash: "e23dc1bcef615ab4dd790f5a5483c62af427378e5e8ade3e65b338d24e0e12d6",
      usage: {
        llmCalls: 148,
        totalTokens: 1_268_333,
        costAmount: 0.276366,
        currency: "USD",
      },
    });
  });
});

describe("evaluateLegacyImprovement", () => {
  it("passes a valid shadow measurement at exactly the 1.05 token limit", () => {
    expect(evaluateLegacyImprovement(validInput())).toEqual({ status: "passed", reasons: [] });
  });

  it("is inconclusive when a measurement field is missing", () => {
    const input = validInput();
    delete (input.candidate as Partial<LegacyPathMeasurement>).totalTokens;
    const result = evaluateLegacyImprovement(input);
    expect(result.status).toBe("inconclusive");
    expect(result.reasons.join("\n")).toContain("totalTokens");
  });

  it("is inconclusive when ground truth is incomplete", () => {
    const input = validInput();
    const broken = structuredClone(input.cases[0]!) as Partial<LegacyGroundTruthCase>;
    delete broken.expected;
    const result = evaluateLegacyImprovement({ ...input, cases: [broken as LegacyGroundTruthCase] });
    expect(result.status).toBe("inconclusive");
  });

  it("fails archive_limit when no pre-registered miss was corrected", () => {
    const input = caseInput("archive_limit");
    input.candidate.correctedMisses = 0;
    const result = evaluateLegacyImprovement(input);
    expect(result.status).toBe("failed");
    expect(result.reasons.join("\n")).toContain("archive_limit");
  });

  it("does not require correctedMisses for refactor_same", () => {
    const input = caseInput("refactor_same");
    input.candidate.correctedMisses = 0;
    input.candidate.dependencyHits = 0;
    input.candidate.staleHits = 0;
    expect(evaluateLegacyImprovement(input).status).toBe("passed");
  });

  it("fails when the false delta rate rises", () => {
    const input = validInput();
    input.candidate.falseDeltaRate = input.baseline.falseDeltaRate + 0.01;
    expect(evaluateLegacyImprovement(input).status).toBe("failed");
  });

  it("fails on dependency false positives", () => {
    const input = validInput();
    input.candidate.dependencyFalsePositives = 1;
    expect(evaluateLegacyImprovement(input).status).toBe("failed");
  });

  it("fails on stale misses", () => {
    const input = validInput();
    input.candidate.staleMisses = 1;
    expect(evaluateLegacyImprovement(input).status).toBe("failed");
  });

  it("fails when tokens exceed 1.05 times the baseline", () => {
    const input = validInput();
    input.candidate.totalTokens = 10_501;
    expect(evaluateLegacyImprovement(input).status).toBe("failed");
  });

  it("fails when LLM calls increase", () => {
    const input = validInput();
    input.candidate.llmCalls = input.baseline.llmCalls + 1;
    expect(evaluateLegacyImprovement(input).status).toBe("failed");
  });

  it("is inconclusive when pricing or cache conditions are not comparable", () => {
    const pricing = validInput();
    pricing.candidate.pricingVersion = "other-pricing";
    expect(evaluateLegacyImprovement(pricing).status).toBe("inconclusive");

    const cache = validInput();
    cache.candidate.cacheCondition = "warm";
    expect(evaluateLegacyImprovement(cache).status).toBe("inconclusive");
  });

  it("requires unknown cases to be explicit and rejects not_analyzed as unknown", () => {
    const missing = caseInput("dynamic_unknown");
    missing.cases[0]!.expected.unknown = [];
    expect(evaluateLegacyImprovement(missing).status).toBe("inconclusive");

    const mixed = caseInput("dynamic_unknown");
    mixed.cases[0]!.expected.unknown[0]!.resolution = "not_analyzed" as "unknown";
    const result = evaluateLegacyImprovement(mixed);
    expect(result.status).toBe("inconclusive");
    expect(result.reasons.join("\n")).toContain("not_analyzed");
  });
});

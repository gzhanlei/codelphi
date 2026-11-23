#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { parseComparison } from "./measure-inventory-analysis";
import {
  evaluatePipelineImprovement,
  type ImprovementRepoInput,
  type PipelineCost,
  type PipelineExperimentIdentity,
} from "../lib/pipeline-improvement-benchmark";
import type { PipelineUsage } from "../lib/pipeline-usage";

const promptHashes = z.object({ baseline: z.string().min(1), candidate: z.string().min(1) }).strict();
const identitySchema = z.object({
  repo: z.string().min(1),
  beforeSha: z.string().nullable(),
  afterSha: z.string().min(7),
  benchmarkTruthVersion: z.string().min(1),
  model: z.string().min(1),
  modelConfigHash: z.string().min(1),
  outputLanguage: z.enum(["zh-CN", "en"]),
  budgetConfigHash: z.string().min(1),
  pricingConfigHash: z.string().min(1),
  cacheCondition: z.string().min(1),
  legacyResult: z.object({ runId: z.number().int().positive(), outputHash: z.string().min(1) }).strict(),
  baselineCodeSha: z.string().min(7),
  candidateCodeSha: z.string().min(7),
  describePromptHash: promptHashes,
  judgePromptBaselineHash: promptHashes,
  repairPromptBaselineHash: promptHashes,
}).strict();
const experimentSchema = z.object({
  schema: z.literal("analysis-pipeline-experiment-v1"),
  identity: identitySchema,
  baselineComparison: z.string().min(1),
  candidateComparison: z.string().min(1),
  baselineUsage: z.string().min(1),
  candidateUsage: z.string().min(1),
  baselineOutput: z.string().min(1),
  candidateOutput: z.string().min(1),
  targets: z.array(z.object({
    behaviorId: z.string().min(1),
    errorClass: z.enum(["fact_omission", "fact_extraction_error", "fact_interpretation_error", "behavior_omission", "evidence_mismatch"]),
  }).strict()).min(1),
}).strict();

const usageSchema = z.object({
  tasks: z.array(z.object({
    taskKey: z.string().min(1),
    total: z.number().int().nonnegative(),
    describe: z.number().int().nonnegative(),
    judge: z.number().int().nonnegative(),
    semanticRepair: z.number().int().nonnegative(),
    reusedTerminal: z.boolean(),
  }).strict()),
  productSummary: z.number().int().nonnegative(),
}).strict();

const outputFactsSchema = z.object({
  featureCount: z.number().nonnegative(),
  scenarioCount: z.number().nonnegative(),
  duplicateClusters: z.number().int().nonnegative(),
  factInterpretationErrors: z.number().int().nonnegative(),
  activationPassed: z.boolean(),
}).strict();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readUsage(path: string): PipelineUsage {
  const raw = readJson(path) as { usage?: unknown };
  return usageSchema.parse(raw.usage ?? raw);
}

function readOutput(path: string) {
  return outputFactsSchema.parse(readJson(path));
}

function readCost(raw: unknown, pricingConfigHash: string): PipelineCost {
  const source = raw as { inventory?: unknown };
  const cost = z.object({
    llmCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costAmount: z.number().nonnegative(),
    currency: z.string().min(1),
    durationMs: z.number().int().nonnegative().optional(),
  }).strict().parse(source.inventory);
  return { ...cost, pricingConfigHash };
}

function loadExperiment(path: string): ImprovementRepoInput {
  const experiment = experimentSchema.parse(readJson(path));
  const identity: PipelineExperimentIdentity = experiment.identity;
  const directory = dirname(path);
  const baseline = parseComparison(readJson(resolve(directory, experiment.baselineComparison)), experiment.baselineComparison);
  const candidate = parseComparison(readJson(resolve(directory, experiment.candidateComparison)), experiment.candidateComparison);
  for (const measured of [baseline, candidate]) {
    const revision = measured.telemetry.revision as { beforeSha?: string | null; afterSha?: string } | undefined;
    if (revision?.beforeSha !== identity.beforeSha || revision.afterSha !== identity.afterSha) {
      throw new Error(`${identity.repo}: comparison revision does not match experiment identity`);
    }
    if (measured.telemetry.frozenAt !== identity.benchmarkTruthVersion) {
      throw new Error(`${identity.repo}: comparison frozenAt must equal benchmarkTruthVersion`);
    }
  }
  return {
    identity,
    baseline: baseline.comparison,
    candidate: candidate.comparison,
    baselineCost: readCost(baseline.telemetry.cost, identity.pricingConfigHash),
    candidateCost: readCost(candidate.telemetry.cost, identity.pricingConfigHash),
    baselineUsage: readUsage(resolve(directory, experiment.baselineUsage)),
    candidateUsage: readUsage(resolve(directory, experiment.candidateUsage)),
    baselineLegacyOutputHash: identity.legacyResult.outputHash,
    candidateLegacyOutputHash: identity.legacyResult.outputHash,
    baselineBenchmarkTruthVersion: String(baseline.telemetry.frozenAt),
    candidateBenchmarkTruthVersion: String(candidate.telemetry.frozenAt),
    baselineOutput: readOutput(resolve(directory, experiment.baselineOutput)),
    candidateOutput: readOutput(resolve(directory, experiment.candidateOutput)),
  };
}

function args(argv: readonly string[]): { experiment: string; out?: string } {
  let experiment: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--experiment") experiment = argv[++index];
    else if (argv[index] === "--out") out = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!experiment) throw new Error("usage: tsx scripts/measure-pipeline-improvement.ts --experiment <experiment.json> [--out <report.json>]");
  return { experiment, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = args(process.argv.slice(2));
    const input = loadExperiment(parsed.experiment);
    const verdict = evaluatePipelineImprovement([input]);
    const report = { generatedAt: new Date().toISOString(), mode: "shadow-offline", verdict, experiment: parsed.experiment };
    const json = JSON.stringify(report, null, 2);
    if (parsed.out) writeFileSync(parsed.out, `${json}\n`);
    else console.log(json);
    process.exitCode = verdict.status === "passed" ? 0 : verdict.status === "failed" ? 1 : 2;
  } catch (error) {
    console.error(`[measure-pipeline-improvement] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 3;
  }
}

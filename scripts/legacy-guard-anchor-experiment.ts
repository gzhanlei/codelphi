#!/usr/bin/env tsx
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  parseAnalysisContent,
  requestStructuredCompletionDetailed,
  type StructuredCompletionDetails,
} from "../lib/ai";
import type { SourceFile } from "../lib/github";
import { llmCostAmount, resolveLlmPricing, type PricedLlm } from "../lib/billing/llm-pricing";
import { extractLegacyGuardAnchors, type GuardAnchor } from "../lib/legacy-analysis/guard-anchors";
import { buildLegacyGuardExperimentMessages, type GuardExperimentArm } from "../lib/legacy-analysis/guard-prompt";
import { evaluateLegacyGuardExperiment, type GuardRunMeasurement } from "../lib/legacy-analysis/guard-evaluation";

/**
 * Legacy GUARD 锚点实验（Task 3）：冻结真值/配置 → A/B/C/D 各 3 次真实调用 → 原始结果落盘。
 * 失败封闭：真值未经独立评审、配置非 4 臂×3 次、Prompt hash 漂移、参数漂移均在调用任何
 * LLM 之前抛 ExperimentInputError；usage 解析失败或定价不可比时停止并把本次运行标记为
 * aborted（只能判 inconclusive）。不重试、不挑样本。原始结果只写本计划的 git-ignored
 * workspace，不写生产数据库（调用 requestStructuredCompletionDetailed 不传 billing）。
 */

const EXPERIMENT = "legacy-guard-anchor-v1";
const WORKSPACE = ".superpowers/sdd/2026-11-23-legacy-guard-anchor-experiment";
const ARMS: readonly GuardExperimentArm[] = ["A", "B", "C", "D"];
const REPETITIONS_PER_ARM = 3;
/** 与 lib/ai.ts requestStructuredCompletionDetailed 实际发送的参数一致；漂移即拒绝。 */
const FROZEN_PARAMETERS = { temperature: 0, maxTokens: 16_000, stream: false } as const;

export class ExperimentInputError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`[legacy-guard-experiment] input rejected: ${reasons.join("; ")}`);
    this.name = "ExperimentInputError";
    this.reasons = reasons;
  }
}

const evidenceRefSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const truthSchema = z.object({
  schemaVersion: z.literal(1),
  experiment: z.literal(EXPERIMENT),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  truths: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["anchor", "non-anchor"]),
    statement: z.string().min(1),
    evidence: z.array(evidenceRefSchema).min(1),
    independentlyReviewed: z.boolean(),
    reviewer: z.string().nullable(),
    reviewedAt: z.string().nullable(),
  })).min(1),
});

const configSchema = z.object({
  schemaVersion: z.literal(1),
  experiment: z.literal(EXPERIMENT),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  sources: z.array(z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })).min(1),
  change: z.object({
    message: z.string().min(1),
    files: z.array(z.object({ path: z.string().min(1), status: z.string().min(1), patch: z.string() })),
  }),
  model: z.string().min(1),
  parameters: z.object({
    temperature: z.number(),
    maxTokens: z.number().int().positive(),
    stream: z.literal(false),
  }),
  arms: z.array(z.enum(["A", "B", "C", "D"])).length(4),
  repetitionsPerArm: z.number().int().positive(),
  outputLanguage: z.enum(["zh-CN", "en"]),
  promptSha256: z.object({
    A: z.string().regex(/^[0-9a-f]{64}$/),
    B: z.string().regex(/^[0-9a-f]{64}$/),
    C: z.string().regex(/^[0-9a-f]{64}$/),
    D: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

export type ExperimentTruthFile = z.infer<typeof truthSchema>;
export type ExperimentConfigFile = z.infer<typeof configSchema>;
export type GitShow = (revision: string, path: string) => string;
export type CompletionExecutor = (messages: Array<{ role: string; content: string }>) => Promise<StructuredCompletionDetails>;

export function validateTruth(raw: unknown): ExperimentTruthFile {
  const parsed = truthSchema.safeParse(raw);
  if (!parsed.success) throw new ExperimentInputError([`truth_schema_invalid:${parsed.error.issues[0]?.message ?? "unknown"}`]);
  const truth = parsed.data;
  const reasons: string[] = [];
  const ids = truth.truths.map((entry) => entry.id);
  for (const required of ["CB-18", "CB-30"]) {
    if (!ids.includes(required)) reasons.push(`truth_missing:${required}`);
  }
  if (truth.truths.length !== 2) reasons.push("truth_must_contain_exactly_cb18_and_cb30");
  for (const entry of truth.truths) {
    if (!entry.independentlyReviewed) reasons.push(`truth_not_independently_reviewed:${entry.id}`);
  }
  if (reasons.length > 0) throw new ExperimentInputError(reasons);
  return truth;
}

export function validateConfig(raw: unknown): ExperimentConfigFile {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ExperimentInputError([`config_schema_invalid:${parsed.error.issues[0]?.message ?? "unknown"}`]);
  const config = parsed.data;
  const reasons: string[] = [];
  if (config.repetitionsPerArm !== REPETITIONS_PER_ARM) reasons.push(`repetitions_per_arm_must_be_${REPETITIONS_PER_ARM}`);
  if ([...config.arms].sort().join(",") !== ARMS.join(",")) reasons.push("arms_must_be_exactly_A_B_C_D");
  for (const source of config.sources) {
    if (source.endLine < source.startLine) reasons.push(`source_range_invalid:${source.path}`);
  }
  if (config.parameters.temperature !== FROZEN_PARAMETERS.temperature
    || config.parameters.maxTokens !== FROZEN_PARAMETERS.maxTokens
    || config.parameters.stream !== FROZEN_PARAMETERS.stream) {
    reasons.push("parameters_mismatch_frozen_gateway_call");
  }
  if (reasons.length > 0) throw new ExperimentInputError(reasons);
  return config;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const defaultGitShow: GitShow = (revision, path) =>
  execFileSync("git", ["show", `${revision}:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function numberLines(content: string, startLine: number): string {
  return content.split("\n").map((line, index) => `${startLine + index}: ${line}`).join("\n");
}

/** 按冻结 revision 与行窗读取源码，切成与生产 getSourceSnapshot 相同的 `N: line` 编号格式。 */
export function loadFrozenSources(config: ExperimentConfigFile, gitShow: GitShow = defaultGitShow): SourceFile[] {
  return config.sources.map((entry) => {
    const raw = gitShow(config.revision, entry.path);
    const lines = raw.split("\n").slice(entry.startLine - 1, entry.endLine);
    return { path: entry.path, content: numberLines(lines.join("\n"), entry.startLine) };
  });
}

/**
 * 锚点从冻结 revision 的完整文件提取（行窗 1-610 截在函数体内，语法诊断失败会整文件跳过），
 * 再按 evidence 过滤到配置行窗内——锚点行号与编号源码一致，Task 1 提取器语义不变。
 */
export function extractWindowAnchors(config: ExperimentConfigFile, gitShow: GitShow = defaultGitShow): GuardAnchor[] {
  const anchors: GuardAnchor[] = [];
  for (const entry of config.sources) {
    if (!/\.tsx?$/.test(entry.path)) continue;
    const full = gitShow(config.revision, entry.path);
    for (const anchor of extractLegacyGuardAnchors({ path: entry.path, content: full })) {
      if (anchor.evidence.startLine >= entry.startLine && anchor.evidence.endLine <= entry.endLine) {
        anchors.push(anchor);
      }
    }
  }
  return anchors;
}

export type ExperimentPrompt = { messages: Array<{ role: string; content: string }>; sha256: string };
export type ExperimentPrompts = Record<GuardExperimentArm, ExperimentPrompt>;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildExperimentPrompts(config: ExperimentConfigFile, sources: SourceFile[], anchors: GuardAnchor[]): ExperimentPrompts {
  const prompts = {} as ExperimentPrompts;
  for (const arm of ARMS) {
    const built = buildLegacyGuardExperimentMessages({ arm, sources, change: config.change, anchors });
    const messages = built.map((message) => ({ role: message.role, content: message.content }));
    prompts[arm] = { messages, sha256: sha256Hex(JSON.stringify(messages)) };
  }
  return prompts;
}

export function verifyPromptHashes(config: ExperimentConfigFile, prompts: ExperimentPrompts): void {
  const reasons: string[] = [];
  for (const arm of ARMS) {
    if (config.promptSha256[arm] !== prompts[arm].sha256) reasons.push(`prompt_hash_mismatch:${arm}`);
  }
  if (reasons.length > 0) throw new ExperimentInputError(reasons);
}

export type UsageTokens = { inputTokens: number; outputTokens: number; cacheHitTokens: number };

/** 解析网关原始 usage；缺 input/output token 或类型异常返回 null（→ inconclusive，绝不按零成本放行）。 */
export function parseUsageTokens(usageRaw: unknown): UsageTokens | null {
  if (typeof usageRaw !== "object" || usageRaw === null) return null;
  const raw = usageRaw as Record<string, unknown>;
  const input = raw.prompt_tokens ?? raw.input_tokens;
  const output = raw.completion_tokens ?? raw.output_tokens;
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  if (typeof output !== "number" || !Number.isFinite(output)) return null;
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheHit = raw.prompt_cache_hit_tokens ?? details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheHitTokens: typeof cacheHit === "number" && Number.isFinite(cacheHit) ? cacheHit : 0,
  };
}

export type PricingSnapshot = {
  status: "priced" | "unpriced";
  version: string | null;
  period: string | null;
  currency: string | null;
  inputPrice: number | null;
  outputPrice: number | null;
  cachePrice: number | null;
};

export type RawRunRecord = {
  arm: GuardExperimentArm;
  repetition: 1 | 2 | 3;
  promptSha256: string;
  startedAt: string;
  durationMs: number;
  requestMessages: Array<{ role: string; content: string }>;
  rawOutput: string | null;
  finishReason: string | null;
  providerRequestId: string | null;
  parseError: string | null;
  usageRaw: unknown | null;
  usage: UsageTokens | null;
  pricing: PricingSnapshot;
  cacheCondition: string;
  actualCost: number | null;
  llmCalls: number;
  repairCount: number;
  retryCount: number;
  error: string | null;
};

export type ExperimentRunSet = {
  status: "completed" | "aborted";
  abortReason: string | null;
  runs: RawRunRecord[];
};

function pricingSnapshot(pricing: ReturnType<typeof resolveLlmPricing>): PricingSnapshot {
  if (pricing.status !== "priced") {
    return { status: "unpriced", version: null, period: null, currency: null, inputPrice: null, outputPrice: null, cachePrice: null };
  }
  const priced: PricedLlm = pricing;
  return {
    status: "priced",
    version: priced.version,
    period: priced.period,
    currency: priced.currency,
    inputPrice: priced.inputPrice,
    outputPrice: priced.outputPrice,
    cachePrice: priced.cachePrice,
  };
}

/**
 * 依次执行 A/B/C/D 各 3 次（每臂内按 repetition 1→3），每次恰好 1 次 LLM 调用，不重试、不挑样本。
 * usage 解析失败 / 成本不可计算 / 执行器抛错时立即停止剩余调用（aborted → 只能 inconclusive）。
 */
export async function executeExperiment(deps: {
  config: ExperimentConfigFile;
  truth: ExperimentTruthFile;
  executor: CompletionExecutor;
  gitShow?: GitShow;
  model?: string;
  pricingRaw?: string;
  now?: () => Date;
}): Promise<ExperimentRunSet> {
  const config = validateConfig(deps.config);
  const truth = validateTruth(deps.truth);
  const model = deps.model ?? process.env.AI_MODEL ?? "";
  if (model !== config.model) throw new ExperimentInputError([`model_mismatch:config=${config.model},env=${model || "<unset>"}`]);
  const sources = loadFrozenSources(config, deps.gitShow);
  const anchors = extractWindowAnchors(config, deps.gitShow);
  const prompts = buildExperimentPrompts(config, sources, anchors);
  verifyPromptHashes(config, prompts);

  const now = deps.now ?? (() => new Date());
  const upfrontPricing = resolveLlmPricing(model, deps.pricingRaw, now());
  if (upfrontPricing.status !== "priced") {
    return { status: "aborted", abortReason: "pricing_unpriced", runs: [] };
  }

  const runs: RawRunRecord[] = [];
  const abort = (reason: string): ExperimentRunSet => ({ status: "aborted", abortReason: reason, runs });
  for (const arm of ARMS) {
    for (const repetition of [1, 2, 3] as const) {
      const prompt = prompts[arm];
      const startedAt = now();
      const startMs = Date.now();
      let details: StructuredCompletionDetails;
      try {
        details = await deps.executor(prompt.messages);
      } catch (error) {
        runs.push({
          arm,
          repetition,
          promptSha256: prompt.sha256,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startMs,
          requestMessages: prompt.messages,
          rawOutput: null,
          finishReason: null,
          providerRequestId: null,
          parseError: null,
          usageRaw: null,
          usage: null,
          pricing: pricingSnapshot({ status: "unpriced" }),
          cacheCondition: "unknown",
          actualCost: null,
          llmCalls: 1,
          repairCount: 0,
          retryCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        return abort(`executor_error:${arm}:${repetition}`);
      }
      const pricing = resolveLlmPricing(model, deps.pricingRaw, startedAt);
      const snapshot = pricingSnapshot(pricing);
      const cacheCondition = pricing.status === "priced" ? `auto-context-cache;period=${pricing.period}` : "unpriced";
      const usage = parseUsageTokens(details.usageRaw);
      const base: Omit<RawRunRecord, "usage" | "actualCost" | "error" | "parseError"> = {
        arm,
        repetition,
        promptSha256: prompt.sha256,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startMs,
        requestMessages: prompt.messages,
        rawOutput: details.content,
        finishReason: details.finishReason,
        providerRequestId: details.providerRequestId,
        usageRaw: details.usageRaw ?? null,
        pricing: snapshot,
        cacheCondition,
        llmCalls: 1,
        repairCount: 0,
        retryCount: 0,
      };
      if (!usage) {
        runs.push({ ...base, usage: null, actualCost: null, parseError: null, error: "usage_missing" });
        return abort(`usage_missing:${arm}:${repetition}`);
      }
      const cost = llmCostAmount(pricing, usage);
      if (cost === null) {
        runs.push({ ...base, usage, actualCost: null, parseError: null, error: "cost_not_computable" });
        return abort(`cost_not_computable:${arm}:${repetition}`);
      }
      let parseError: string | null = null;
      let error: string | null = null;
      if (details.finishReason === "length") {
        error = "output_truncated";
      } else {
        try {
          parseAnalysisContent(details.content);
        } catch (parseFailure) {
          parseError = parseFailure instanceof Error ? parseFailure.message : String(parseFailure);
        }
      }
      runs.push({ ...base, usage, actualCost: cost, parseError, error });
    }
  }
  return { status: "completed", abortReason: null, runs };
}

export type RunJudgment = {
  arm: GuardExperimentArm;
  repetition: 1 | 2 | 3;
  cb18Hit: boolean;
  nonAnchorHits: number;
  overallHits: number;
  falsePositives: number;
  falseDeltas: number;
  evidenceAllowSetUnchanged: boolean;
  manualProtected: boolean;
  independentlyReviewed: boolean;
  reviewer: string | null;
  notes?: string;
};

const judgmentSchema = z.object({
  arm: z.enum(["A", "B", "C", "D"]),
  repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  cb18Hit: z.boolean(),
  nonAnchorHits: z.number().int().nonnegative(),
  overallHits: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  falseDeltas: z.number().int().nonnegative(),
  evidenceAllowSetUnchanged: z.boolean(),
  manualProtected: z.boolean(),
  independentlyReviewed: z.boolean(),
  reviewer: z.string().nullable(),
  notes: z.string().optional(),
});

export function validateJudgments(raw: unknown): RunJudgment[] {
  const parsed = z.array(judgmentSchema).safeParse(raw);
  if (!parsed.success) throw new ExperimentInputError([`judgments_schema_invalid:${parsed.error.issues[0]?.message ?? "unknown"}`]);
  return parsed.data;
}

/** 把 12 条原始运行与独立评审 judgments 合并为判定器测量；缺评审或键不齐一律拒绝（失败封闭）。 */
export function buildMeasurements(runs: RawRunRecord[], judgments: RunJudgment[]): GuardRunMeasurement[] {
  const reasons: string[] = [];
  const byKey = new Map<string, RunJudgment>();
  for (const judgment of judgments) {
    const key = `${judgment.arm}:${judgment.repetition}`;
    if (byKey.has(key)) reasons.push(`judgment_duplicate:${key}`);
    byKey.set(key, judgment);
  }
  const measurements: GuardRunMeasurement[] = [];
  for (const run of runs) {
    const key = `${run.arm}:${run.repetition}`;
    const judgment = byKey.get(key);
    if (!judgment) {
      reasons.push(`judgment_missing:${key}`);
      continue;
    }
    byKey.delete(key);
    measurements.push({
      arm: run.arm,
      repetition: run.repetition,
      cb18Hit: judgment.cb18Hit,
      nonAnchorHits: judgment.nonAnchorHits,
      overallHits: judgment.overallHits,
      falsePositives: judgment.falsePositives,
      falseDeltas: judgment.falseDeltas,
      llmCalls: run.llmCalls + run.repairCount + run.retryCount,
      inputTokens: run.usage?.inputTokens ?? Number.NaN,
      outputTokens: run.usage?.outputTokens ?? Number.NaN,
      actualCost: run.actualCost ?? Number.NaN,
      pricingVersion: run.pricing.version ?? "unpriced",
      cacheCondition: run.cacheCondition,
      independentlyReviewed: judgment.independentlyReviewed,
      evidenceAllowSetUnchanged: judgment.evidenceAllowSetUnchanged,
      manualProtected: judgment.manualProtected,
    });
  }
  for (const key of byKey.keys()) reasons.push(`judgment_without_run:${key}`);
  if (reasons.length > 0) throw new ExperimentInputError(reasons);
  return measurements;
}

export type ExperimentVerdict = {
  status: "passed" | "failed" | "inconclusive";
  reasons: string[];
  measurements: GuardRunMeasurement[];
};

/** 汇总：真值未经独立评审时恒 inconclusive；其余交给 Task 2 判定器（usage 缺失/定价缓存不可比/未评审 → inconclusive）。 */
export function summarizeExperiment(truth: ExperimentTruthFile, runs: RawRunRecord[], judgments: RunJudgment[]): ExperimentVerdict {
  const measurements = buildMeasurements(runs, judgments);
  const truthReviewed = truth.truths.every((entry) => entry.independentlyReviewed);
  const verdict = evaluateLegacyGuardExperiment(measurements);
  if (!truthReviewed && verdict.status !== "failed") {
    return { status: "inconclusive", reasons: ["truth_not_independently_reviewed", ...verdict.reasons], measurements };
  }
  return { ...verdict, measurements };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function judgmentsTemplate(runs: RawRunRecord[]) {
  return runs.map((run) => ({
    arm: run.arm,
    repetition: run.repetition,
    cb18Hit: null,
    nonAnchorHits: null,
    overallHits: null,
    falsePositives: null,
    falseDeltas: null,
    evidenceAllowSetUnchanged: null,
    manualProtected: null,
    independentlyReviewed: false,
    reviewer: null,
    notes: "",
  }));
}

async function main(): Promise<void> {
  const [, , command] = process.argv;
  const frozenDir = resolve(repoRoot, "docs/benchmark/frozen");
  const workspaceDir = resolve(repoRoot, WORKSPACE);
  const truthPath = resolve(frozenDir, "legacy-guard-anchor-truth-v1.json");
  const configPath = resolve(frozenDir, "legacy-guard-anchor-config-v1.json");
  const rawRunsPath = resolve(workspaceDir, "raw-runs.json");
  const judgmentsPath = resolve(workspaceDir, "judgments.json");
  const verdictPath = resolve(workspaceDir, "verdict.json");

  if (command === "run") {
    const truth = validateTruth(readJson(truthPath));
    const config = validateConfig(readJson(configPath));
    const executor: CompletionExecutor = (messages) => requestStructuredCompletionDetailed(messages);
    const model = process.env.AI_MODEL;
    const result = await executeExperiment({
      config,
      truth,
      executor,
      model,
      pricingRaw: process.env.LLM_PRICES,
    });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(rawRunsPath, JSON.stringify({
      experiment: EXPERIMENT,
      revision: config.revision,
      model: config.model,
      executedAt: new Date().toISOString(),
      status: result.status,
      abortReason: result.abortReason,
      runs: result.runs,
    }, null, 2));
    if (!existsSync(judgmentsPath)) {
      writeFileSync(judgmentsPath, JSON.stringify(judgmentsTemplate(result.runs), null, 2));
    }
    console.log(`[legacy-guard-experiment] run ${result.status}: ${result.runs.length} calls recorded → ${rawRunsPath}`);
    if (result.abortReason) console.log(`[legacy-guard-experiment] abort reason: ${result.abortReason}`);
    return;
  }

  if (command === "summarize") {
    const truth = validateTruth(readJson(truthPath));
    const raw = readJson(rawRunsPath) as { runs: RawRunRecord[] };
    const judgments = validateJudgments(readJson(judgmentsPath));
    const verdict = summarizeExperiment(truth, raw.runs, judgments);
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(verdictPath, JSON.stringify({ experiment: EXPERIMENT, summarizedAt: new Date().toISOString(), ...verdict }, null, 2));
    console.log(JSON.stringify({ status: verdict.status, reasons: verdict.reasons }, null, 2));
    return;
  }

  console.error("usage: tsx scripts/legacy-guard-anchor-experiment.ts <run|summarize>");
  process.exit(2);
}

if (process.argv[1]?.endsWith("legacy-guard-anchor-experiment.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

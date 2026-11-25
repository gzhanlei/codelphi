import "dotenv/config";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeWithAI, type ChangeContext, type SpecAnchorFeature } from "../lib/ai";
import type { SourceFile } from "../lib/code-hosting/types";
import { createStandaloneClientFromEnv, type StructuredCompletionClient } from "../lib/llm-client";

const execFileAsync = promisify(execFile);

export interface SemanticInheritanceWindow {
  id: string;
  project: string;
  repository: string;
  baseSha: string;
  targetSha: string;
  declaredIntent: string;
  evidence: Array<{ path: string; symbols: string[] }>;
}

export interface SemanticWindowPlan {
  baselinePaths: string[];
  arms: {
    full_rebuild: string[];
    diff_only: string[];
    semantic_inheritance: string[];
  };
}

export interface RunSemanticWindowOptions {
  window: SemanticInheritanceWindow;
  change: ChangeContext;
  outputDir: string;
  client: StructuredCompletionClient;
  readFile: (sha: string, path: string) => Promise<string | null>;
  maxFileChars?: number;
  previousWindows?: SemanticInheritanceWindow[];
}

function eligiblePath(filePath: string) {
  return filePath !== "git-tree" && !filePath.startsWith("server/static/");
}

function sortedUnique(paths: readonly string[]) {
  return [...new Set(paths.filter(eligiblePath))].sort();
}

export function planSemanticWindow(window: SemanticInheritanceWindow, changedPaths: readonly string[], previousWindows: readonly SemanticInheritanceWindow[] = []): SemanticWindowPlan {
  const changed = sortedUnique(changedPaths);
  const scope = sortedUnique([
    ...previousWindows.flatMap((previous) => previous.evidence.map((item) => item.path)),
    ...window.evidence.map((item) => item.path),
    ...changed,
  ]);
  return {
    baselinePaths: scope,
    arms: {
      full_rebuild: scope,
      diff_only: changed,
      semantic_inheritance: scope,
    },
  };
}

function numbered(content: string, maxChars: number) {
  return content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n").slice(0, maxChars);
}

async function writeJson(filePath: string, value: unknown) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function specAnchors(features: Awaited<ReturnType<typeof analyzeWithAI>>["features"]): SpecAnchorFeature[] {
  return features.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: feature.scenarios.map((scenario) => ({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category,
      step: scenario.step,
    })),
  }));
}

export function continuityAgainstBaseline(
  baseline: Awaited<ReturnType<typeof analyzeWithAI>>,
  candidate: Awaited<ReturnType<typeof analyzeWithAI>>,
) {
  const scenarios = (analysis: Awaited<ReturnType<typeof analyzeWithAI>>) => analysis.features.flatMap((feature) =>
    feature.scenarios.map((scenario) => ({
      key: `${feature.name}\n${scenario.reference}`,
      text: `${scenario.context}\n${scenario.action}\n${scenario.outcome}`,
    })),
  );
  const before = scenarios(baseline);
  const after = new Map(scenarios(candidate).map((scenario) => [scenario.key, scenario.text]));
  const beforeKeys = new Set(before.map((scenario) => scenario.key));
  const exact = before.filter((scenario) => after.get(scenario.key) === scenario.text).length;
  const missing = before.filter((scenario) => !after.has(scenario.key)).length;
  const changed = before.filter((scenario) => after.has(scenario.key) && after.get(scenario.key) !== scenario.text).length;
  const added = scenarios(candidate).filter((scenario) => !beforeKeys.has(scenario.key)).length;
  return {
    baselineScenarios: before.length,
    exactPreservedScenarios: exact,
    missingScenarios: missing,
    newScenarios: added,
    changedScenarios: changed,
    exactPreservationRate: before.length === 0 ? 0 : exact / before.length,
  };
}

export function reconcileSemanticAnalysis(
  baseline: Awaited<ReturnType<typeof analyzeWithAI>>,
  inherited: Awaited<ReturnType<typeof analyzeWithAI>>,
) {
  const analysis = structuredClone(inherited);
  const baselineScenarios = new Map<string, string>(baseline.features.flatMap((feature) =>
    feature.scenarios.map((scenario) => [
      `${feature.name}\n${scenario.reference}`,
      `${scenario.context}\n${scenario.action}\n${scenario.outcome}`,
    ] as const),
  ));
  const identityCollisions: Array<Record<string, unknown>> = [];
  for (const feature of analysis.features) {
    feature.scenarios = feature.scenarios.filter((scenario) => {
      const key = `${feature.name}\n${scenario.reference}`;
      const beforeText = baselineScenarios.get(key);
      const afterText = `${scenario.context}\n${scenario.action}\n${scenario.outcome}`;
      if (beforeText === undefined || beforeText === afterText) return true;
      identityCollisions.push({
        featureName: feature.name,
        reference: scenario.reference,
        status: "pending_identity_review",
        reason: "same_reference_different_behavior",
        before: baseline.features.find((candidate) => candidate.name === feature.name)?.scenarios.find((candidate) => candidate.reference === scenario.reference),
        after: scenario,
      });
      return false;
    });
  }

  const coveredPaths = new Set(analysis.features.flatMap((feature) =>
    feature.scenarios.flatMap((scenario) => scenario.evidence.map((item) => item.path)),
  ));
  const newBehaviorCandidates = analysis.changes
    .filter((change) => change.kind === "reviewed")
    .map((change) => ({
      ...change,
      uncoveredEvidencePaths: change.evidence.map((item) => item.path).filter((filePath) => !coveredPaths.has(filePath)),
    }))
    .filter((change) => change.uncoveredEvidencePaths.length === change.evidence.length)
    .map((change) => ({ ...change, status: "pending_behavior_review" }));
  return {
    analysis,
    reviewQueue: {
      status: identityCollisions.length + newBehaviorCandidates.length > 0 ? "pending" : "empty",
      identityCollisions,
      newBehaviorCandidates,
    },
  };
}

export type ReviewDecision = ({
  rationale: string;
  reviewedBy: string;
  reviewedAt: string;
} & (
  | {
      type: "promote_candidate";
      candidateFeatureName: string;
      targetFeature: { name: string; summary: string };
      scenarios: Awaited<ReturnType<typeof analyzeWithAI>>["features"][number]["scenarios"];
      changeOrigin: "current_commit" | "preexisting_discovery";
    }
  | {
      type: "reject_candidate";
      candidateFeatureName: string;
    }
  | {
      type: "resolve_collision";
      featureName: string;
      reference: string;
      targetFeatureName: string;
      scenario: Awaited<ReturnType<typeof analyzeWithAI>>["features"][number]["scenarios"][number];
      changeOrigin: "current_commit" | "preexisting_discovery";
    }
));

export function applyReviewDecisions(
  inputAnalysis: Awaited<ReturnType<typeof analyzeWithAI>>,
  inputQueue: ReturnType<typeof reconcileSemanticAnalysis>["reviewQueue"],
  decisions: readonly ReviewDecision[],
) {
  const analysis = structuredClone(inputAnalysis);
  const reviewQueue = { ...structuredClone(inputQueue), decisions: [...decisions] };
  const verification: Array<Record<string, unknown>> = [];
  const appendScenario = (featureName: string, summary: string, scenario: Awaited<ReturnType<typeof analyzeWithAI>>["features"][number]["scenarios"][number], decision: ReviewDecision & { changeOrigin: string }) => {
    let feature = analysis.features.find((candidate) => candidate.name === featureName);
    if (!feature) {
      feature = { name: featureName, summary, scenarios: [] };
      analysis.features.push(feature);
    }
    if (feature.scenarios.some((candidate) => candidate.reference === scenario.reference)) {
      throw new Error(`Review would create another identity collision: ${featureName} ${scenario.reference}`);
    }
    feature.scenarios.push(scenario);
    verification.push({
      featureName,
      reference: scenario.reference,
      state: "unverified",
      source: decision.reviewedBy,
      reviewedAt: decision.reviewedAt,
      rationale: decision.rationale,
      changeOrigin: decision.changeOrigin,
    });
  };

  for (const decision of decisions) {
    if (decision.type === "promote_candidate") {
      appendScenario(decision.targetFeature.name, decision.targetFeature.summary, decision.scenarios[0], decision);
      for (const scenario of decision.scenarios.slice(1)) appendScenario(decision.targetFeature.name, decision.targetFeature.summary, scenario, decision);
      reviewQueue.newBehaviorCandidates = reviewQueue.newBehaviorCandidates.filter((candidate) => candidate.featureName !== decision.candidateFeatureName);
    } else if (decision.type === "reject_candidate") {
      reviewQueue.newBehaviorCandidates = reviewQueue.newBehaviorCandidates.filter((candidate) => candidate.featureName !== decision.candidateFeatureName);
    } else {
      appendScenario(decision.targetFeatureName, decision.targetFeatureName, decision.scenario, decision);
      reviewQueue.identityCollisions = reviewQueue.identityCollisions.filter((candidate) =>
        candidate.featureName !== decision.featureName || candidate.reference !== decision.reference,
      );
    }
  }
  reviewQueue.status = reviewQueue.identityCollisions.length + reviewQueue.newBehaviorCandidates.length > 0 ? "pending" : "resolved";
  return { analysis, reviewQueue, verification };
}

export interface VerificationRecord {
  state: "unverified" | "verified" | "stale-verified";
  specVersionId?: number;
  commitSha?: string;
  verifiedAt?: string;
  verifiedBy?: string;
}

export function transitionVerification(
  baseline: VerificationRecord | null,
  change: "unchanged" | "behavior_changed" | "new" | "identity_collision" | "tree_revert",
) {
  const history = baseline ? [baseline] : [];
  if (change === "unchanged" && baseline) return { current: baseline, history };
  if (change === "new" || change === "identity_collision" || !baseline) {
    return { current: { state: "unverified" as const }, history };
  }
  return {
    current: { state: baseline.state === "unverified" ? "unverified" as const : "stale-verified" as const },
    history,
  };
}

export async function runSemanticWindow(options: RunSemanticWindowOptions) {
  const { window, change, outputDir, client } = options;
  const maxFileChars = options.maxFileChars ?? 120_000;
  await mkdir(outputDir, { recursive: true });
  const plan = planSemanticWindow(window, change.files.map((file) => file.path), options.previousWindows);
  const experimentChange: ChangeContext = {
    ...change,
    files: change.files.filter((file) => eligiblePath(file.path)),
  };
  const readSources = async (sha: string, paths: readonly string[]) => {
    const sources: SourceFile[] = [];
    const missing: string[] = [];
    for (const filePath of paths) {
      const content = await options.readFile(sha, filePath);
      if (content === null) {
        missing.push(filePath);
      } else {
        sources.push({ path: filePath, content: numbered(content, maxFileChars) });
      }
    }
    return { sources, missing };
  };

  const baselinePath = path.join(outputDir, "baseline.json");
  let baseline: Awaited<ReturnType<typeof analyzeWithAI>>;
  let baselineReused = true;
  let baselineMissing: string[] = [];
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Awaited<ReturnType<typeof analyzeWithAI>>;
  } catch {
    const loaded = await readSources(window.baseSha, plan.baselinePaths);
    baselineMissing = loaded.missing;
    if (loaded.sources.length === 0) throw new Error(`No readable baseline sources for ${window.id}`);
    baseline = await analyzeWithAI(loaded.sources, {
      message: `Baseline reconstruction for ${window.project}@${window.baseSha}`,
      files: [],
    }, { client });
    baselineReused = false;
    await writeJson(baselinePath, baseline);
  }

  const target = await readSources(window.targetSha, plan.arms.full_rebuild);
  if (target.sources.length === 0) throw new Error(`No readable target sources for ${window.id}`);
  const changed = await readSources(window.targetSha, plan.arms.diff_only);
  if (changed.sources.length === 0) throw new Error(`No readable changed sources for ${window.id}`);

  const full = await analyzeWithAI(target.sources, experimentChange, { client });
  await writeJson(path.join(outputDir, "full_rebuild.json"), full);

  const diff = await analyzeWithAI(changed.sources, experimentChange, { client });
  await writeJson(path.join(outputDir, "diff_only.json"), diff);

  const inheritedRaw = await analyzeWithAI(target.sources, experimentChange, {
    client,
    previousSpec: specAnchors(baseline.features),
    affectedFeatureNames: baseline.features.map((feature) => feature.name),
    unassignedBehavioralPaths: experimentChange.files.map((file) => file.path),
  });
  const { analysis: inherited, reviewQueue } = reconcileSemanticAnalysis(baseline, inheritedRaw);
  await writeJson(path.join(outputDir, "semantic_inheritance.raw.json"), inheritedRaw);
  await writeJson(path.join(outputDir, "semantic_inheritance.json"), inherited);
  await writeJson(path.join(outputDir, "review_queue.json"), reviewQueue);

  const modelCalls = baselineReused ? 3 : 4;
  await writeJson(path.join(outputDir, "run.json"), {
    windowId: window.id,
    status: reviewQueue.status === "pending" ? "review_required" : "succeeded",
    baseSha: window.baseSha,
    targetSha: window.targetSha,
    arms: ["full_rebuild", "diff_only", "semantic_inheritance"],
    modelCalls,
    baselineReused,
    reviewQueue: {
      identityCollisions: reviewQueue.identityCollisions.length,
      newBehaviorCandidates: reviewQueue.newBehaviorCandidates.length,
    },
    sources: {
      baselinePaths: plan.baselinePaths,
      targetPaths: plan.arms.full_rebuild,
      diffPaths: plan.arms.diff_only,
      baselineMissing,
      targetMissing: target.missing,
      diffMissing: changed.missing,
      excludedGeneratedPaths: change.files.map((file) => file.path).filter((filePath) => !eligiblePath(filePath)),
    },
  });
  return { modelCalls, baselineReused };
}

export interface SemanticArgs {
  windowId: string;
  repoDir: string;
  outputDir: string;
  execute: boolean;
}

export function parseSemanticArgs(argv: readonly string[]): SemanticArgs {
  let windowId = "";
  let repoDir = "";
  let outputDir = "";
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (argument === "--window" || argument === "--repo" || argument === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--window") windowId = value;
      if (argument === "--repo") repoDir = value;
      if (argument === "--out") outputDir = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!windowId) throw new Error("--window is required");
  if (!repoDir) throw new Error("--repo is required");
  return {
    windowId,
    repoDir: path.resolve(repoDir),
    outputDir: path.resolve(outputDir || path.join("artifacts", "semantic-inheritance", windowId)),
    execute,
  };
}

async function git(repoDir: string, args: readonly string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

async function loadFrozenWindow(windowId: string) {
  const filePath = path.join(process.cwd(), "docs", "benchmark", "frozen", "semantic-inheritance-2026-11-23-v2", "cases.json");
  const cases = JSON.parse(await readFile(filePath, "utf8")) as { windows: SemanticInheritanceWindow[] };
  const index = cases.windows.findIndex((item) => item.id === windowId);
  if (index < 0) throw new Error(`Unknown frozen window: ${windowId}`);
  const window = cases.windows[index];
  return {
    window,
    previousWindows: cases.windows.slice(0, index).filter((item) => item.project === window.project),
  };
}

async function loadGitChange(repoDir: string, window: SemanticInheritanceWindow): Promise<ChangeContext> {
  const [message, nameStatus] = await Promise.all([
    git(repoDir, ["show", "-s", "--format=%B", window.targetSha]),
    git(repoDir, ["diff", "--name-status", window.baseSha, window.targetSha]),
  ]);
  const files = await Promise.all(nameStatus.trim().split("\n").filter(Boolean).map(async (line) => {
    const columns = line.split("\t");
    const filePath = columns[columns.length - 1];
    return {
      path: filePath,
      status: columns[0],
      patch: await git(repoDir, ["diff", "--unified=80", window.baseSha, window.targetSha, "--", filePath]),
    };
  }));
  return { message: message.trim(), files };
}

export async function main(argv: readonly string[] = process.argv.slice(2), environment: Record<string, string | undefined> = process.env) {
  const args = parseSemanticArgs(argv);
  const { window, previousWindows } = await loadFrozenWindow(args.windowId);
  const change = await loadGitChange(args.repoDir, window);
  if (!args.execute) {
    const result = {
      windowId: window.id,
      execute: false,
      modelCalls: 0,
      plannedModelCalls: 4,
      plan: planSemanticWindow(window, change.files.map((file) => file.path), previousWindows),
      outputDir: args.outputDir,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const client = createStandaloneClientFromEnv(environment, {
    onUsage: async (usage, metadata) => {
      await appendFile(path.join(args.outputDir, "usage.jsonl"), `${JSON.stringify({
        windowId: window.id,
        model: client.displayName ?? null,
        usage,
        ...metadata,
      })}\n`, "utf8");
    },
  });
  const result = await runSemanticWindow({
    window,
    change,
    outputDir: args.outputDir,
    client,
    previousWindows,
    readFile: async (sha, filePath) => {
      try {
        return await git(args.repoDir, ["show", `${sha}:${filePath}`]);
      } catch {
        return null;
      }
    },
  });
  const output = { windowId: window.id, execute: true, outputDir: args.outputDir, ...result };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1]?.endsWith("semantic-inheritance.ts")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

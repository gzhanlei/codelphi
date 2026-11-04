import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createRemoteSourceIndex } from "../lib/remote-source-index";
import { createSlicePlanner, type SliceBudgets, type SlicePlanner, type SourceSlice } from "../lib/slice-planner";
import { analysisSliceBudgets } from "../lib/remote-analysis";
import { buildArchitectureDocument } from "../lib/architecture-generic";
import { createDirectArchitectureShadow, createLegacyArchitectureShadow, unavailableArchitectureShadow, type ArchitectureShadow } from "../lib/architecture/shadow";
import type { ArchitectureDocument } from "../lib/architecture-draft";
import { resolveGitHubToken } from "../lib/github-access";
import type { OpenedRemoteSourceRevision, RemoteSourceBudgets, SourceScopeRoot } from "../lib/remote-source-index";
import type { SourceFile } from "../lib/github";

const manifestSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().min(1),
  repositories: z.array(z.object({
    id: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    expectedProfile: z.string().min(1),
    sourceRoots: z.array(z.string()),
  })).min(1),
});

export type StackCorpusManifest = z.infer<typeof manifestSchema>;
export type StackCorpusRepository = StackCorpusManifest["repositories"][number];

export interface StackCorpusArgs {
  only: string[];
  output: string;
}

export interface StackCorpusRunOptions extends StackCorpusArgs {
  manifestPath: string;
  planner?: SlicePlanner;
  index?: OpenedRemoteSourceRevision;
  token?: string;
  sourceBudgets?: Partial<RemoteSourceBudgets>;
  root?: string;
}

const plannerBudgets: SliceBudgets = {
  ...analysisSliceBudgets,
  maxSelectedFiles: 120,
  maxSelectedLineRanges: 600,
  maxPlannerContentBytes: 240_000,
  maxAiContextSourceBytes: 240_000,
};

export function parseStackCorpusArgs(argv: string[]): StackCorpusArgs {
  const onlyArgument = argv.find((argument) => argument.startsWith("--only="));
  const only = onlyArgument === undefined ? [] : onlyArgument.slice(7).split(",").filter(Boolean);
  const output = argv.find((argument) => argument.startsWith("--output="))?.slice(9) || "artifacts/stack-corpus/report.json";
  return { only, output };
}

export function selectStackCorpusRepositories(manifest: StackCorpusManifest, only: string[]) {
  return manifest.repositories.filter((repository) => only.length === 0 || only.includes(repository.id) || only.includes(`${repository.owner}/${repository.repo}`));
}

const corpusSourceBudgets: Partial<RemoteSourceBudgets> = {
  maxTreeExpansions: 500,
  maxBlobFetches: 400,
  maxBlobBytes: 1_000_000,
  maxTotalContentBytes: 2_000_000,
};

export function resolveCorpusSourceBudgets(budgets: Partial<RemoteSourceBudgets> | undefined) {
  return budgets === undefined ? corpusSourceBudgets : budgets;
}

export function scopeRoots(paths: string[]): SourceScopeRoot[] {
  return paths.map((path) => ({ path, role: path === "" ? "shared" : undefined }));
}

async function readSliceSources(index: OpenedRemoteSourceRevision, slice: SourceSlice): Promise<SourceFile[]> {
  const sources: SourceFile[] = [];
  for (const file of slice.files) {
    const range = file.lineRanges[0];
    if (!range) continue;
    const read = await index.readLines({
      path: file.path,
      startLine: range.startLine,
      endLine: range.endLine,
      requestedBy: "evidence_verifier",
      reason: `stack corpus: ${file.reason}`,
    });
    sources.push({ path: file.path, content: read.lines.map((line: string, offset: number) => `${read.startLine + offset}: ${line}`).join("\n") });
  }
  return sources;
}

export function shadowSummary(revision: string, sources: SourceFile[], document?: ArchitectureDocument): ArchitectureShadow & { error?: string } {
  try {
    return createLegacyArchitectureShadow({ revision, scope: "source-slice", sources, document });
  } catch (error) {
    return unavailableArchitectureShadow("source-slice", error instanceof Error ? error.message : "Architecture shadow failed");
  }
}

export function architectureFactSummary(revision: string, sources: SourceFile[]): ArchitectureShadow & { error?: string } {
  try {
    return createDirectArchitectureShadow({ revision, scope: "source-slice", sources });
  } catch (error) {
    return unavailableArchitectureShadow("source-slice", error instanceof Error ? error.message : "Architecture fact analysis failed");
  }
}

export function architectureSummary(repository: StackCorpusRepository, revision: string, sources: SourceFile[]) {
  let architecture: ArchitectureDocument;
  try {
    architecture = buildArchitectureDocument({
      productName: repository.repo,
      productSlug: repository.id,
      owner: repository.owner,
      name: repository.repo,
      revision,
      sources,
    });
  } catch (error) {
    return { architectureComponents: [] as string[], architectureError: error instanceof Error ? error.message : "Architecture generation failed", architectureShadow: shadowSummary(revision, sources), architectureFacts: architectureFactSummary(revision, sources) };
  }
  return { architectureComponents: architecture.components.map((component) => component.id), architectureError: null, architectureShadow: shadowSummary(revision, sources, architecture), architectureFacts: architectureFactSummary(revision, sources) };
}

async function planStackCorpusRepository(repository: StackCorpusRepository, planner: SlicePlanner, dependencies: { token?: string; index?: OpenedRemoteSourceRevision; budgets?: Partial<RemoteSourceBudgets> }) {
  const index = dependencies.index === undefined ? await createRemoteSourceIndex(
    { owner: repository.owner, repo: repository.repo, revision: repository.revision },
    { access: { token: dependencies.token }, scopeRoots: scopeRoots(repository.sourceRoots), budgets: resolveCorpusSourceBudgets(dependencies.budgets) },
  ) : dependencies.index;
  return {
    index,
    planned: await planner.plan({
      product: { id: 0, slug: repository.id, name: repository.repo },
      repository: { owner: repository.owner, repo: repository.repo, revision: repository.revision },
      scopeRoots: scopeRoots(repository.sourceRoots),
      budgets: plannerBudgets,
      plannerVersion: "stack-corpus-v1",
      profileVersion: "stack-corpus-v1",
    }, index),
  };
}

export async function analyzeStackCorpusRepository(
  repository: StackCorpusRepository,
  planner: SlicePlanner,
  dependencies: { token?: string; index?: OpenedRemoteSourceRevision; budgets?: Partial<RemoteSourceBudgets> } = {},
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const { index, planned } = await planStackCorpusRepository(repository, planner, dependencies);
  if (!planned.slice) {
    return failedResult(repository, new Error(planned.missing.join("; ") || "Planner did not return a slice"), Date.now() - startedAt);
  }
  const sources = await readSliceSources(index, planned.slice);
  const architecture = architectureSummary(repository, repository.revision, sources);
  const primaryProfile = planned.slice.metrics.profileMatches[0];
  return {
    id: repository.id,
    repository: `${repository.owner}/${repository.repo}`,
    revision: repository.revision,
    expectedProfile: repository.expectedProfile,
    status: planned.status,
    detectedProfile: primaryProfile === undefined ? "unknown" : primaryProfile.profileId,
    profileMatches: planned.slice.metrics.profileMatches,
    missing: planned.missing,
    diagnostics: planned.diagnostics,
    selectedFiles: planned.slice.files.map((file) => file.path),
    metrics: planned.slice.metrics,
    architectureComponents: architecture.architectureComponents,
    architectureError: architecture.architectureError,
    architectureShadow: architecture.architectureShadow,
    architectureFacts: architecture.architectureFacts,
    durationMs: Date.now() - startedAt,
  };
}

function failedResult(repository: StackCorpusRepository, error: unknown, durationMs: number) {
  return {
    id: repository.id,
    repository: `${repository.owner}/${repository.repo}`,
    revision: repository.revision,
    expectedProfile: repository.expectedProfile,
    status: "failed",
    detectedProfile: "unknown",
    error: error instanceof Error ? error.message : "Unknown corpus error",
    architectureShadow: unavailableArchitectureShadow("unavailable"),
    architectureFacts: unavailableArchitectureShadow("unavailable"),
    durationMs,
  };
}

async function collectStackCorpusResults(repositories: StackCorpusRepository[], planner: SlicePlanner, options: StackCorpusRunOptions) {
  const settled = await Promise.allSettled(repositories.map(async (repository) => ({
    repository,
    result: await analyzeStackCorpusRepository(repository, planner, { token: options.token, index: options.index }),
  })));
  const results = settled.map((outcome, index) => outcome.status === "fulfilled"
    ? { ...outcome.value.result, repository: `${outcome.value.repository.owner}/${outcome.value.repository.repo}` }
    : failedResult(repositories[index], outcome.reason, 0));
  return {
    version: 1,
    manifestUpdatedAt: "",
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      completed: results.filter((result) => (result as { status: string }).status === "completed").length,
      profileMatches: results.filter((result) => {
        const item = result as { expectedProfile: string; detectedProfile: string };
        return item.detectedProfile === item.expectedProfile;
      }).length,
    },
    results,
  };
}

export async function runStackCorpus(options: StackCorpusRunOptions) {
  const contents = await readFile(options.manifestPath, "utf8");
  const manifest = manifestSchema.parse(JSON.parse(contents));
  const repositories = selectStackCorpusRepositories(manifest, options.only);
  if (repositories.length === 0) throw new Error("No stack corpus repositories selected");
  const planner = options.planner === undefined ? createSlicePlanner({ now: Date.now }) : options.planner;
  const collected = await collectStackCorpusResults(repositories, planner, options);
  const report = { ...collected, manifestUpdatedAt: manifest.updatedAt };
  const root = options.root === undefined ? process.cwd() : options.root;
  const outputPath = path.isAbsolute(options.output) ? options.output : path.join(root, options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

export async function main(argv: string[]) {
  const { only, output } = parseStackCorpusArgs(argv);
  const manifestPath = path.join(process.cwd(), "tests/fixtures/stack-corpus/manifest.json");
  const report = await runStackCorpus({ only, output, manifestPath, token: process.env.GITHUB_TOKEN });
  console.log(`Report written: ${path.join(process.cwd(), output)}`);
  return report;
}

if (process.argv[1]?.endsWith("stack-corpus.ts")) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

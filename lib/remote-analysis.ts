import { z } from "zod";
import { analysisAiContextBudgetOverride } from "./env";
import { createRemoteSourceIndex, type OpenedRemoteSourceRevision, type RemoteSourceBudgets, type SourceRevisionRef, type SourceScopeRoot } from "./remote-source-index";
import { createSlicePlanner, type SliceBudgets, type SlicePlanner, type SourceSlice } from "./slice-planner";
import type { CodeHostingProvider, RepositoryAccess, SourceFile } from "./code-hosting/types";
import { radarArchitectureEvidencePaths } from "./architecture-draft";
import { aivlogArchitectureEvidencePaths } from "./architecture-aivlog";
import type { RemoteSourceBackend } from "./remote-source-index";

export interface RemoteAnalysisRequest {
  product: { id: number; slug: string; name: string };
  repository: { owner: string; repo: string; revision: string };
  access: RepositoryAccess;
  provider?: CodeHostingProvider;
  scopeRoots: SourceScopeRoot[];
  backend?: RemoteSourceBackend;
}

export interface RemoteAnalysisRuntime {
  planner: SlicePlanner;
  budgets: SliceBudgets;
}

export interface RemoteAnalysisResult {
  slice: SourceSlice;
  sources: SourceFile[];
  index: OpenedRemoteSourceRevision;
}

export const analysisSliceBudgets: SliceBudgets = {
  maxSelectedFiles: 80,
  maxSelectedLineRanges: 600,
  maxPlannerContentBytes: 160_000,
  maxAiContextSourceBytes: analysisAiContextBudgetOverride() ?? 160_000,
  maxAiReadCalls: 20,
  maxComponents: 12,
  maxConnections: 24,
  maxRepairRounds: 2,
};

export const analysisSourceIndexBudgets: RemoteSourceBudgets = {
  maxTreeExpansions: 1000,
  maxBlobFetches: 1000,
  maxBlobBytes: 1_000_000,
  maxLinesPerRead: 600,
  maxTotalContentBytes: 10_000_000,
};

const sourceRootsSchema = z.array(z.object({
  path: z.string().min(1),
  label: z.string().optional(),
  role: z.enum(["web", "api", "worker", "library", "mobile", "desktop", "deployment", "shared"]).optional(),
}));

export function parseSourceRoots(value: unknown): SourceScopeRoot[] {
  if (value === null || value === undefined) return [];
  const parsed = sourceRootsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (Array.isArray(value)) {
    const paths = z.array(z.string().min(1)).safeParse(value);
    if (paths.success) return paths.data.map((path) => ({ path }));
  }
  throw new Error("Product source roots must be an array of path objects or strings");
}

export function sliceToSourceFiles(slice: SourceSlice, index: OpenedRemoteSourceRevision, maxBytes = Number.POSITIVE_INFINITY): Promise<SourceFile[]> {
  // F3 硬顶（生产实测 4/5 仓库超预算 10–22%）：贪心按规划顺序整文件包含，超预算即停。
  // 返回的文件集就是真实窗口——调用方须以它为准（assertEvidence 允许集 = 实际进 prompt 的内容）。
  return Promise.all(slice.files.map(async (file) => {
    const numbered: string[] = [];
    for (const range of file.lineRanges) {
      const read = await index.readLines({
        path: file.path,
        startLine: range.startLine,
        endLine: range.endLine,
        requestedBy: "evidence_verifier",
        reason: `rebuild analysis source: ${range.purpose}`,
      });
      numbered.push(...read.lines.map((line, offset) => `${range.startLine + offset}: ${line}`));
    }
    return { path: file.path, content: numbered.join("\n") };
  })).then((files) => {
    const included: SourceFile[] = [];
    let total = 0;
    for (const file of files) {
      const size = Buffer.byteLength(file.content, "utf8");
      if (total + size > maxBytes) continue;
      included.push(file);
      total += size;
    }
    return included;
  });
}

async function loadExplicitArchitectureSources(index: OpenedRemoteSourceRevision, sources: SourceFile[], paths: string[], reason: string) {
  const merged = new Map(sources.map((source) => [source.path, source]));
  await Promise.all(paths.map(async (path) => {
    const read = await index.readLines({
      path,
      startLine: 1,
      endLine: 600,
      requestedBy: "evidence_verifier",
      reason,
    });
    merged.set(path, { path, content: read.lines.map((line, offset) => `${read.startLine + offset}: ${line}`).join("\n") });
  }));
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function loadRadarArchitectureSources(index: OpenedRemoteSourceRevision, sources: SourceFile[]) {
  return loadExplicitArchitectureSources(index, sources, radarArchitectureEvidencePaths, "complete Radar architecture evidence");
}

export function loadAIVlogArchitectureSources(index: OpenedRemoteSourceRevision, sources: SourceFile[]) {
  return loadExplicitArchitectureSources(index, sources, aivlogArchitectureEvidencePaths, "complete AIVlog architecture evidence");
}

export async function getRemoteAnalysisSources(request: RemoteAnalysisRequest, runtime: RemoteAnalysisRuntime): Promise<RemoteAnalysisResult> {
  const revision: SourceRevisionRef = {
    owner: request.repository.owner,
    repo: request.repository.repo,
    revision: request.repository.revision,
  };
  const index = await createRemoteSourceIndex(revision, { scopeRoots: request.scopeRoots, access: request.access, provider: request.provider, backend: request.backend, budgets: analysisSourceIndexBudgets });
  const planner = runtime.planner;
  const budgets = runtime.budgets;
  const result = await planner.plan({
    product: request.product,
    repository: request.repository,
    scopeRoots: request.scopeRoots,
    budgets,
    plannerVersion: "remote-analysis-v2",
    profileVersion: "remote-analysis-v1",
  }, index);
  if (!result.slice) {
    throw new Error(`Remote source slice failed: ${result.missing.join("; ") || "unknown planner failure"}`);
  }
  const sources = await sliceToSourceFiles(result.slice, index, budgets.maxAiContextSourceBytes);
  if (sources.length === 0) throw new Error("No supported source files found");
  // slice.files 对齐真实窗口：assertEvidence 的允许集来自 slice.files，
  // 被硬顶排除的文件不得留在允许集（AI 引用未进 prompt 的路径应视为越界）。
  const includedPaths = new Set(sources.map((source) => source.path));
  const trimmedSlice = { ...result.slice, files: result.slice.files.filter((file) => includedPaths.has(file.path)) };
  return { slice: trimmedSlice, sources, index };
}

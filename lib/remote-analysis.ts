import { z } from "zod";
import { createRemoteSourceIndex, type OpenedRemoteSourceRevision, type SourceRevisionRef, type SourceScopeRoot } from "./remote-source-index";
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
  maxAiContextSourceBytes: 160_000,
  maxAiReadCalls: 20,
  maxComponents: 12,
  maxConnections: 24,
  maxRepairRounds: 2,
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

export function sliceToSourceFiles(slice: SourceSlice, index: OpenedRemoteSourceRevision): Promise<SourceFile[]> {
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
  }));
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
  const index = await createRemoteSourceIndex(revision, { scopeRoots: request.scopeRoots, access: request.access, provider: request.provider, backend: request.backend });
  const planner = runtime.planner;
  const budgets = runtime.budgets;
  const result = await planner.plan({
    product: request.product,
    repository: request.repository,
    scopeRoots: request.scopeRoots,
    budgets,
    plannerVersion: "remote-analysis-v1",
    profileVersion: "remote-analysis-v1",
  }, index);
  if (!result.slice) {
    throw new Error(`Remote source slice failed: ${result.missing.join("; ") || "unknown planner failure"}`);
  }
  const sources = await sliceToSourceFiles(result.slice, index);
  if (sources.length === 0) throw new Error("No supported source files found");
  return { slice: result.slice, sources, index };
}

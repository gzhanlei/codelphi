import { z } from "zod";
import { analysisAiContextBudgetOverride, analysisMaxPartitions } from "./env";
import { createRemoteSourceIndex, type OpenedRemoteSourceRevision, type RemoteSourceBudgets, type SourceRevisionRef, type SourceScopeRoot } from "./remote-source-index";
import { createSlicePlanner, type SliceBudgets, type SlicePlanner, type SourceSlice } from "./slice-planner";
import { mergeExclusions } from "./slice-planner/exclusions";
import type { SliceExclusion } from "./slice-planner/types";
import type { CodeHostingProvider, RepositoryAccess, SourceFile } from "./code-hosting/types";
import { radarArchitectureEvidencePaths } from "./architecture-draft";
import { isModelContextFile } from "./analysis-target";
import { aivlogArchitectureEvidencePaths } from "./architecture-aivlog";
import type { RemoteSourceBackend } from "./remote-source-index";

export interface RemoteAnalysisRequest {
  product: { id: number; slug: string; name: string };
  repository: { owner: string; repo: string; revision: string };
  access: RepositoryAccess;
  provider?: CodeHostingProvider;
  scopeRoots: SourceScopeRoot[];
  backend?: RemoteSourceBackend;
  /** W0-7：窗口 diff 文件路径——分区装配必选（行为证据一手面）。 */
  diffPaths?: readonly string[];
  discovery?: "full" | "required_only";
  requiredPaths?: readonly string[];
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
  maxTreeExpansions: Number.POSITIVE_INFINITY,
  maxBlobFetches: Number.POSITIVE_INFINITY,
  maxBlobBytes: 1_000_000,
  maxLinesPerRead: 600,
  maxTotalContentBytes: Number.POSITIVE_INFINITY,
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
  // 规划器为认技术栈选进来的清单（package.json、go.mod 等）不进提示词：它们不是产品行为，
  // 留在提示词里只会让模型写出「依赖了某个库」这样的功能，还能被引成证据。
  return Promise.all(slice.files.filter((file) => isModelContextFile(file.path)).map(async (file) => {
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
  const partitioned = await getPartitionedAnalysisSources(request, runtime, { singleWindow: true });
  return { ...partitioned.partitions[0], index: partitioned.index };
}

export interface AnalysisPartition {
  slice: SourceSlice;
  sources: SourceFile[];
}

export interface PartitionedAnalysisResult {
  partitions: AnalysisPartition[];
  /** 全部分区的规划器状态（分析层可用于后续 reads；当前保留为未来扩展位）。 */
  index: OpenedRemoteSourceRevision;
  /** 分区被 ANALYSIS_MAX_PARTITIONS 截断（覆盖率披露口径：实现面被成本帽收窄）。 */
  partitionsCapped: boolean;
  /**
   * 规划时排除在分析之外的路径（拷进来的上游项目……），各趟合并去重。
   * 测试替身和别的加载器可以不给：没有排除记录就按没有算。
   */
  excluded?: readonly SliceExclusion[];
}

/**
 * 多趟提取的分区规划（无 AI 成本）：在同一个种子索引上反复规划，每趟排除此前分区
 * 已选路径，直至无新路径。单窗口入口只读取首趟。
 */
export async function getPartitionedAnalysisSources(request: RemoteAnalysisRequest, runtime: RemoteAnalysisRuntime, options: { singleWindow?: boolean } = {}): Promise<PartitionedAnalysisResult> {
  const revision: SourceRevisionRef = {
    owner: request.repository.owner,
    repo: request.repository.repo,
    revision: request.repository.revision,
  };
  const index = await createRemoteSourceIndex(revision, { scopeRoots: request.scopeRoots, access: request.access, provider: request.provider, backend: request.backend, budgets: analysisSourceIndexBudgets });
  const partitions: AnalysisPartition[] = [];
  const excludePaths = new Set<string>();
  const maxPartitions = analysisMaxPartitions();
  let partitionsCapped = false;
  const excluded = new Map<string, SliceExclusion>();
  while (!options.singleWindow || partitions.length === 0) {
    if (maxPartitions !== null && partitions.length >= maxPartitions) {
      partitionsCapped = true;
      console.warn("[analysis] partition cap reached; remaining implementation surface not planned", { planned: partitions.length, cap: maxPartitions });
      break;
    }
    const result = await runtime.planner.plan({
      product: request.product,
      repository: request.repository,
      scopeRoots: request.scopeRoots,
      budgets: runtime.budgets,
      plannerVersion: "remote-analysis-v2",
      profileVersion: "remote-analysis-v1",
      excludePaths,
      diffPaths: request.diffPaths,
      discovery: request.discovery,
      requiredPaths: request.requiredPaths,
    }, index);
    mergeExclusions(excluded, result.excluded);
    if (!result.slice) throw new Error(`Remote source slice failed: ${result.missing.join("; ") || "unknown planner failure"}`);
    if (result.slice.files.length === 0) {
      // 首趟无候选 = 仓库没有可分析源码；后续趟无候选 = 分区耗尽（正常结束）
      if (partitions.length === 0) throw new Error("No supported source files found");
      break;
    }
    const sources = await sliceToSourceFiles(result.slice, index, runtime.budgets.maxAiContextSourceBytes);
    if (sources.length === 0) {
      if (partitions.length === 0) throw new Error("No supported source files found");
      break;
    }
    // 只收此前分区没拿走的文件。分区数默认不设上限，这个循环靠规划器不重选已选的路径才能停；
    // 2026-11-27 工具目录的入口每一趟都被重选，就是这样跑不完的。所以这里不依赖规划器守规矩：没有新文件就停。
    const fresh = sources.filter((source) => !excludePaths.has(source.path));
    if (fresh.length === 0) {
      if (partitions.length === 0) throw new Error("No supported source files found");
      console.warn("[analysis] a partition brought no file that earlier partitions had not taken; stopping the partition loop", { planned: partitions.length });
      break;
    }
    // slice.files 对齐真实窗口：assertEvidence 的允许集来自 slice.files，
    // 被硬顶排除的文件不得留在允许集（AI 引用未进 prompt 的路径应视为越界）。
    const includedPaths = new Set(fresh.map((source) => source.path));
    const trimmedSlice = { ...result.slice, files: result.slice.files.filter((file) => includedPaths.has(file.path)) };
    partitions.push({ slice: trimmedSlice, sources: fresh });
    for (const source of fresh) excludePaths.add(source.path);
  }
  return { partitions, index, partitionsCapped, excluded: [...excluded.values()] };
}

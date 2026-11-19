import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildAnalysisMessages, parseAnalysisContent } from "../ai";
import { CONTRACT_VERSION, type ExtractionWorkOrder } from "../extraction-contract";
import { mergeChunkResults } from "../extraction-merge";
import type { StructuredCompletionClient } from "../llm-client";
import { sanitizeEvidence } from "../extraction-pass";
import type { AnalysisPartition } from "../remote-analysis";
import { createRemoteSourceIndex, type SourceScopeRoot } from "../remote-source-index";
import { resolveGitSnapshot, createLocalGitBackend } from "./git-backend";
import { buildSnapshotReportData } from "./report-data";
import { renderSnapshotHtml } from "./report-html";
import { resolveSnapshotTarget } from "./target";
import { createSnapshotPresentation } from "./presentation";
import type { SnapshotIdentity } from "./types";
import { finalizeSnapshotAnalysis, prepareSnapshotAnalysis, type PreparedSnapshotAnalysis, type PrepareSnapshotAnalysisOptions, type SnapshotExecution } from "./workflow";

interface SnapshotManifest {
  contractVersion: string;
  identity: SnapshotIdentity;
  repositoryRoot: string;
  cleanupRoot: string | null;
  outputLanguage: "zh-CN" | "en";
  scopeRoots: SourceScopeRoot[];
  workOrderIds: string[];
  modelName: string;
}

export interface PrepareSnapshotWorkspaceOptions extends Omit<PrepareSnapshotAnalysisOptions, "backend" | "identity" | "productName"> {
  directory: string;
  target: string;
  ref?: string;
  modelName?: string;
}

async function writeAtomically(path: string, content: string, force: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    if (force) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readManifest(directory: string): Promise<SnapshotManifest> {
  return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as SnapshotManifest;
}

export async function prepareSnapshotWorkspace(options: PrepareSnapshotWorkspaceOptions): Promise<{ manifest: SnapshotManifest }> {
  const manifestPath = join(options.directory, "manifest.json");
  let existing: SnapshotManifest | null = null;
  try {
    existing = await readManifest(options.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    const target = await resolveSnapshotTarget(options.target, options.ref);
    if (existing.identity.target !== target.identity.target || existing.identity.revision !== target.identity.revision || existing.outputLanguage !== options.outputLanguage) {
      await target.cleanup();
      throw new Error("workspace_target_mismatch");
    }
    if (existing.repositoryRoot !== target.repositoryRoot) {
      const previousCleanupRoot = existing.cleanupRoot;
      existing.repositoryRoot = target.repositoryRoot;
      existing.cleanupRoot = target.identity.source === "github" ? dirname(target.repositoryRoot) : null;
      await writeAtomically(manifestPath, JSON.stringify(existing, null, 2), true);
      if (previousCleanupRoot && previousCleanupRoot !== existing.cleanupRoot) await rm(previousCleanupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return { manifest: existing };
  }

  const target = await resolveSnapshotTarget(options.target, options.ref);
  const prepared = await prepareSnapshotAnalysis({
    backend: target.backend,
    identity: target.identity,
    productName: target.identity.name,
    ...options,
  });
  const manifest: SnapshotManifest = {
    contractVersion: CONTRACT_VERSION,
    identity: target.identity,
    repositoryRoot: target.repositoryRoot,
    cleanupRoot: target.identity.source === "github" ? dirname(target.repositoryRoot) : null,
    outputLanguage: options.outputLanguage,
    scopeRoots: options.scopeRoots ?? [],
    workOrderIds: prepared.workOrders.map((workOrder) => workOrder.id),
    modelName: options.modelName ?? "Host current model",
  };
  for (const workOrder of prepared.workOrders) {
    await writeAtomically(join(options.directory, "work-orders", `${workOrder.id}.json`), JSON.stringify(workOrder, null, 2), true);
  }
  await mkdir(join(options.directory, "results"), { recursive: true });
  await writeAtomically(manifestPath, JSON.stringify(manifest, null, 2), true);
  return { manifest };
}

export async function writeSnapshotResult(directory: string, workOrderId: string, content: string) {
  const manifest = await readManifest(directory);
  if (!manifest.workOrderIds.includes(workOrderId)) throw new Error(`Unknown work order: ${workOrderId}`);
  await writeAtomically(join(directory, "results", `${workOrderId}.json`), content, false);
}

async function preparedFromManifest(directory: string, manifest: SnapshotManifest): Promise<PreparedSnapshotAnalysis> {
  const snapshot = await resolveGitSnapshot(manifest.repositoryRoot, manifest.identity.revision, { checkDirty: false, allowLazyFetch: true, requireExactRoot: true });
  const backend = createLocalGitBackend(snapshot);
  const index = await createRemoteSourceIndex({ owner: manifest.identity.owner ?? "local", repo: manifest.identity.name, revision: manifest.identity.revision }, {
    access: {},
    scopeRoots: manifest.scopeRoots,
    backend,
  });
  const workOrders = await Promise.all(manifest.workOrderIds.map(async (id) => JSON.parse(await readFile(join(directory, "work-orders", `${id}.json`), "utf8")) as ExtractionWorkOrder));
  return {
    identity: manifest.identity,
    language: manifest.outputLanguage,
    partitions: workOrders.map((workOrder) => ({
      sources: workOrder.sources,
      slice: { files: workOrder.allowPaths.map((path) => ({ path })) },
    })) as AnalysisPartition[],
    index,
    workOrders,
    enumerateSurface: (await import("../analysis-coverage")).enumerateImplementationSurface,
    now: () => new Date(),
  };
}

async function readSnapshotExecutions(directory: string, prepared: PreparedSnapshotAnalysis): Promise<SnapshotExecution[]> {
  const executions: SnapshotExecution[] = [];
  const missing: string[] = [];
  for (const workOrder of prepared.workOrders) {
    try {
      const content = await readFile(join(directory, "results", `${workOrder.id}.json`), "utf8");
      const result = parseAnalysisContent(content);
      const sanitize = sanitizeEvidence(result, new Set(workOrder.allowPaths), `snapshot/${workOrder.id}`);
      executions.push({ result, pass: { retries: 0, sanitize } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.push(workOrder.id);
      else throw new Error(`${workOrder.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (missing.length > 0) throw new Error(`Missing snapshot results: ${missing.join(", ")}`);
  return executions;
}

async function readStoredPresentation(directory: string): Promise<unknown> {
  try {
    const content = await readFile(join(directory, "presentation.json"), "utf8");
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function finalizeSnapshotWorkspace(directory: string) {
  const manifest = await readManifest(directory);
  if (manifest.contractVersion !== CONTRACT_VERSION) throw new Error(`Unsupported extraction contract version: ${manifest.contractVersion}`);
  const prepared = await preparedFromManifest(directory, manifest);
  const executions = await readSnapshotExecutions(directory, prepared);
  const storedPresentation = await readStoredPresentation(directory);
  const analysis = await finalizeSnapshotAnalysis(prepared, executions, { modelName: manifest.modelName, ...(storedPresentation !== undefined ? { presentation: storedPresentation } : {}) });
  const report = buildSnapshotReportData(analysis);
  const html = renderSnapshotHtml(report);
  const outputPath = join(directory, "radar.html");
  await writeAtomically(outputPath, html, true);
  // BYO 导入物（设计 2026-11-18-radar-import-byo §4.1）：report-data 已含 identity/features/
  // presentation/coverage/warnings 全部导入所需字段，补 artifactKind/exportVersion/contractVersion
  // 即为确定性导出。同 work dir 重复 finalize 必须产出逐字节相同的 snapshot.json。
  const snapshotExportPath = join(directory, "snapshot.json");
  await writeAtomically(snapshotExportPath, JSON.stringify({
    artifactKind: "codelphi-radar-snapshot",
    exportVersion: 1,
    contractVersion: manifest.contractVersion,
    identity: report.snapshot,
    language: report.language,
    modelName: report.modelName,
    product: report.product,
    features: report.features,
    presentation: report.presentation,
    codebaseNavigation: report.codebaseNavigation,
    evidenceSnippets: report.evidenceSnippets,
    coverage: report.coverage,
    effectiveCoverage: report.effectiveCoverage,
    warnings: report.warnings,
    analysis: report.analysis,
  }), true);
  if (manifest.cleanupRoot) await rm(manifest.cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
  return { analysis, report, html, outputPath, snapshotExportPath };
}

/** 收敛趟数（W2 客户端语义，2026-11-19）：识别零产出工作单——该分区提取没有带锚定的场景。
 *  调用方删除这些结果后重跑 complete，即为一轮定向重提取；边际产出 < ε 时停止。 */
export async function readZeroYieldWorkOrderIds(directory: string): Promise<string[]> {
  const manifest = await readManifest(directory);
  const zero: string[] = [];
  for (const id of manifest.workOrderIds) {
    try {
      const result = parseAnalysisContent(await readFile(join(directory, "results", `${id}.json`), "utf8"));
      if ((result.features?.length ?? 0) === 0) zero.push(id);
    } catch {
      // 缺失/不可解析结果由 complete 自身的重试与失败计数负责，这里跳过
    }
  }
  return zero;
}

export async function readSnapshotWorkOrder(directory: string, workOrderId: string) {
  const manifest = await readManifest(directory);
  if (!manifest.workOrderIds.includes(workOrderId)) throw new Error(`Unknown work order: ${workOrderId}`);
  const workOrder = JSON.parse(await readFile(join(directory, "work-orders", `${workOrderId}.json`), "utf8")) as ExtractionWorkOrder;
  const previousFeatureNames: string[] = [];
  for (const id of manifest.workOrderIds) {
    if (id === workOrderId) break;
    try {
      const result = parseAnalysisContent(await readFile(join(directory, "results", `${id}.json`), "utf8"));
      for (const feature of result.features ?? []) previousFeatureNames.push(String(feature.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    ...workOrder,
    messages: buildAnalysisMessages(workOrder.sources, workOrder.change, { ...workOrder.context, previousFeatureNames }),
  };
}

export interface CompleteSnapshotWorkspaceOptions {
  directory: string;
  /** 完成通道（standalone / 宿主桥 / 宿主 headless CLI），由 resolveCompletionBackend 探测得出。 */
  client: StructuredCompletionClient;
  concurrency?: number;
  retries?: number;
  retryDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface CompleteSnapshotWorkspaceOutcome {
  completed: string[];
  failed: string[];
  skippedExisting: number;
  presentation: "completed" | "reused" | "fallback" | "not_ready";
}

/**
 * 用完成通道批量填完工作单并落盘 results。每个分区先经 parseAnalysisContent 预检
 * （与 finalize 同一校验：schema、别名归一、场景帽），不合格即重试；已有结果的分区跳过，
 * 断点可续。命名连续性由 readSnapshotWorkOrder 从已完成结果注入。
 */
export async function completeSnapshotWorkspace(options: CompleteSnapshotWorkspaceOptions): Promise<CompleteSnapshotWorkspaceOutcome> {
  const manifest = await readManifest(options.directory);
  const skippedExisting: string[] = [];
  const todo: string[] = [];
  for (const id of manifest.workOrderIds) {
    try {
      await readFile(join(options.directory, "results", `${id}.json`), "utf8");
      skippedExisting.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      todo.push(id);
    }
  }
  const completed: string[] = [];
  const failed: string[] = [];
  const retries = Math.max(1, options.retries ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 3_000;
  let cursor = 0;
  const runOne = async (id: string): Promise<boolean> => {
    const workOrder = await readSnapshotWorkOrder(options.directory, id);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const content = await options.client.complete(workOrder.messages);
        parseAnalysisContent(content);
        await writeSnapshotResult(options.directory, id, content);
        options.onProgress?.(`${id}: completed`);
        return true;
      } catch (error) {
        options.onProgress?.(`${id}: attempt ${attempt}/${retries} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return false;
  };
  const worker = async () => {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      if (await runOne(id)) completed.push(id);
      else failed.push(id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 4), todo.length || 1) }, () => worker()));
  let presentation: CompleteSnapshotWorkspaceOutcome["presentation"] = "not_ready";
  if (failed.length === 0) {
    if (await readStoredPresentation(options.directory) !== undefined) {
      presentation = "reused";
    } else {
      try {
        const manifest = await readManifest(options.directory);
        const prepared = await preparedFromManifest(options.directory, manifest);
        const executions = await readSnapshotExecutions(options.directory, prepared);
        const result = mergeChunkResults(executions.map((execution) => ({ result: execution.result })));
        const value = await createSnapshotPresentation({ result, language: manifest.outputLanguage, client: options.client });
        await writeAtomically(join(options.directory, "presentation.json"), JSON.stringify(value, null, 2), true);
        presentation = "completed";
        options.onProgress?.("presentation: completed");
      } catch (error) {
        presentation = "fallback";
        options.onProgress?.(`presentation: fallback: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { completed, failed, skippedExisting: skippedExisting.length, presentation };
}

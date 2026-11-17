import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildAnalysisMessages, parseAnalysisContent } from "../ai";
import { CONTRACT_VERSION, type ExtractionWorkOrder } from "../extraction-contract";
import { sanitizeEvidence } from "../extraction-pass";
import type { AnalysisPartition } from "../remote-analysis";
import { createRemoteSourceIndex, type SourceScopeRoot } from "../remote-source-index";
import { resolveGitSnapshot, createLocalGitBackend } from "./git-backend";
import { buildSnapshotReportData } from "./report-data";
import { renderSnapshotHtml } from "./report-html";
import { resolveSnapshotTarget } from "./target";
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

export async function finalizeSnapshotWorkspace(directory: string) {
  const manifest = await readManifest(directory);
  if (manifest.contractVersion !== CONTRACT_VERSION) throw new Error(`Unsupported extraction contract version: ${manifest.contractVersion}`);
  const prepared = await preparedFromManifest(directory, manifest);
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
  const analysis = await finalizeSnapshotAnalysis(prepared, executions, { modelName: manifest.modelName });
  const report = buildSnapshotReportData(analysis);
  const html = renderSnapshotHtml(report);
  const outputPath = join(directory, "radar.html");
  await writeAtomically(outputPath, html, true);
  if (manifest.cleanupRoot) await rm(manifest.cleanupRoot, { recursive: true, force: true }).catch(() => undefined);
  return { analysis, report, html, outputPath };
}

export async function readSnapshotWorkOrder(directory: string, workOrderId: string) {
  const manifest = await readManifest(directory);
  if (!manifest.workOrderIds.includes(workOrderId)) throw new Error(`Unknown work order: ${workOrderId}`);
  const workOrder = JSON.parse(await readFile(join(directory, "work-orders", `${workOrderId}.json`), "utf8")) as ExtractionWorkOrder;
  const previousFeatureNames: string[] = [];
  for (const id of manifest.workOrderIds) {
    if (id === workOrderId) break;
    try {
      const result = JSON.parse(await readFile(join(directory, "results", `${id}.json`), "utf8"));
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

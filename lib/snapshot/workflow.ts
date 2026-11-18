import type { AnalysisResult, analyzeWithAI } from "../ai";
import { computeCoverageReceipt, enumerateImplementationSurface } from "../analysis-coverage";
import { buildExtractionWorkOrder, type ExtractionWorkOrder } from "../extraction-contract";
import { extractPassWithRetry } from "../extraction-pass";
import type { StructuredCompletionClient } from "../llm-client";
import { analysisSliceBudgets, getPartitionedAnalysisSources } from "../remote-analysis";
import { createSlicePlanner } from "../slice-planner";
import { computeEffectiveSnapshotCoverage } from "./effective-coverage";
import { createSnapshotPresentation, fallbackSnapshotPresentation, parseSnapshotPresentation } from "./presentation";
import type { SnapshotAnalysis, SnapshotAnalysisPass, SnapshotProgressEvent, SnapshotWarning } from "./types";
import type { AnalyzeProductSnapshotOptions } from "./analyze";

export interface PrepareSnapshotAnalysisOptions extends Omit<AnalyzeProductSnapshotOptions, "client" | "analyze"> {}

export interface PreparedSnapshotAnalysis {
  identity: PrepareSnapshotAnalysisOptions["identity"];
  language: PrepareSnapshotAnalysisOptions["outputLanguage"];
  partitions: Awaited<ReturnType<typeof getPartitionedAnalysisSources>>["partitions"];
  index: Awaited<ReturnType<typeof getPartitionedAnalysisSources>>["index"];
  workOrders: ExtractionWorkOrder[];
  enumerateSurface: typeof enumerateImplementationSurface;
  now: () => Date;
  onProgress?: (event: SnapshotProgressEvent) => void;
}

export interface SnapshotExecution {
  result: AnalysisResult;
  pass: SnapshotAnalysisPass;
}

export async function prepareSnapshotAnalysis(options: PrepareSnapshotAnalysisOptions): Promise<PreparedSnapshotAnalysis> {
  const now = options.now ?? (() => new Date());
  const scopeRoots = options.scopeRoots?.length ? options.scopeRoots : [{ path: "", role: "shared" as const }];
  const loadPartitions = options.loadPartitions ?? getPartitionedAnalysisSources;
  const { partitions, index } = await loadPartitions({
    product: { id: 0, slug: "snapshot", name: options.productName },
    repository: {
      owner: options.identity.owner ?? "local",
      repo: options.identity.name,
      revision: options.identity.revision,
    },
    access: {},
    scopeRoots,
    backend: options.backend,
  }, {
    planner: createSlicePlanner({ now: () => now().getTime() }),
    budgets: analysisSliceBudgets,
  });
  options.onProgress?.({ stage: "plan", status: "complete", total: partitions.length });
  const change = {
    message: options.identity.message,
    committedAt: options.identity.committedAt,
    url: options.identity.repositoryUrl ? `${options.identity.repositoryUrl}/commit/${options.identity.revision}` : "",
    files: [],
  };
  const workOrders = partitions.map((partition, partitionIndex) => buildExtractionWorkOrder({
    id: `partition-${String(partitionIndex + 1).padStart(3, "0")}`,
    sources: partition.sources,
    change,
    context: {
      previousFeatureNames: [],
      outputLanguage: options.outputLanguage,
      ...(partitions.length > 1 ? { partition: { index: partitionIndex + 1, total: partitions.length } } : {}),
    },
  }));

  return {
    identity: { ...options.identity },
    language: options.outputLanguage,
    partitions,
    index,
    workOrders,
    enumerateSurface: options.enumerateSurface ?? enumerateImplementationSurface,
    now,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}

export async function executeSnapshotWorkOrder(workOrder: ExtractionWorkOrder, options: {
  client: StructuredCompletionClient;
  previousFeatureNames: string[];
  analyze?: typeof analyzeWithAI;
  onRetry?: (error: Error) => void;
}): Promise<SnapshotExecution> {
  const extracted = await extractPassWithRetry({
    sources: workOrder.sources,
    change: workOrder.change,
    context: {
      ...workOrder.context,
      previousFeatureNames: options.previousFeatureNames,
      client: options.client,
    },
    allowSet: new Set(workOrder.allowPaths),
    label: `snapshot/${workOrder.id}`,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.analyze ? { analyze: options.analyze } : {}),
  });
  return { result: extracted.result, pass: extracted.pass };
}

export async function finalizeSnapshotAnalysis(prepared: PreparedSnapshotAnalysis, executions: SnapshotExecution[], options: {
  modelName: string;
  client?: StructuredCompletionClient;
  presentation?: unknown;
}): Promise<SnapshotAnalysis> {
  if (executions.length === 0) {
    const { SnapshotAnalysisError } = await import("./analyze");
    throw new SnapshotAnalysisError("no_valid_spec", "No evidence-backed product features were extracted from this snapshot");
  }
  const { mergeChunkResults } = await import("../extraction-merge");
  let mergeStats = { changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 };
  const result = mergeChunkResults(executions.map((execution) => ({ result: execution.result })), (stats) => { mergeStats = stats; });
  if (result.features.length === 0) {
    const { SnapshotAnalysisError } = await import("./analyze");
    throw new SnapshotAnalysisError("no_valid_spec", "No evidence-backed product features were extracted from this snapshot");
  }

  let presentation = fallbackSnapshotPresentation(result, prepared.language);
  let presentationFallback = false;
  if (options.presentation !== undefined) {
    try {
      presentation = parseSnapshotPresentation(typeof options.presentation === "string" ? options.presentation : JSON.stringify(options.presentation), result);
    } catch {
      presentationFallback = true;
    }
  } else if (options.client) {
    const presentationStartedAt = Date.now();
    prepared.onProgress?.({ stage: "presentation", status: "start" });
    try {
      presentation = await createSnapshotPresentation({ result, language: prepared.language, client: options.client });
      prepared.onProgress?.({ stage: "presentation", status: "complete", durationMs: Date.now() - presentationStartedAt });
    } catch {
      presentationFallback = true;
      prepared.onProgress?.({ stage: "presentation", status: "fallback", durationMs: Date.now() - presentationStartedAt });
    }
  } else {
    presentationFallback = true;
  }

  const implSurface = await prepared.enumerateSurface(prepared.index);
  const coverage = computeCoverageReceipt({
    index: prepared.index,
    partitions: prepared.partitions,
    implSurface,
  });
  const effectiveCoverage = computeEffectiveSnapshotCoverage({ partitions: prepared.partitions, implementationSurface: implSurface });
  const warnings: SnapshotWarning[] = [];
  if (prepared.identity.workingTreeDirty) warnings.push({ code: "working_tree_dirty" });
  if (presentationFallback) warnings.push({ code: "presentation_fallback" });
  const passes = executions.map((execution) => execution.pass);
  const retries = passes.reduce((total, pass) => total + pass.retries, 0);
  if (retries > 0) warnings.push({ code: "extraction_retry", values: { count: retries } });
  const emptyPasses = passes.filter((pass) => pass.sanitize.empty).length;
  if (emptyPasses > 0) warnings.push({ code: "empty_pass", values: { count: emptyPasses } });
  const droppedScenarios = passes.reduce((total, pass) => total + pass.sanitize.droppedScenarios, 0);
  if (droppedScenarios > 0) warnings.push({ code: "evidence_dropped", values: { count: droppedScenarios } });
  const rejectedPasses = passes.filter((pass) => pass.sanitize.allCandidatesRejected).length;
  if (rejectedPasses > 0) warnings.push({ code: "all_candidates_rejected", values: { count: rejectedPasses } });
  if (mergeStats.scenariosDeduped > 0) warnings.push({ code: "scenarios_deduplicated", values: { count: mergeStats.scenariosDeduped } });
  if (mergeStats.featuresFolded > 0) warnings.push({ code: "features_folded", values: { count: mergeStats.featuresFolded } });

  return {
    identity: { ...prepared.identity },
    language: prepared.language,
    generatedAt: prepared.now().toISOString(),
    modelName: options.modelName,
    result,
    partitions: prepared.partitions,
    index: prepared.index,
    coverage,
    warnings,
    passes,
    mergeStats,
    presentation,
    effectiveCoverage,
  };
}

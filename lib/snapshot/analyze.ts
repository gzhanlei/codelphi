import type { analyzeWithAI } from "../ai";
import { computeCoverageReceipt, enumerateImplementationSurface } from "../analysis-coverage";
import { evidenceAllowSet, extractPassWithRetry } from "../extraction-pass";
import type { StructuredCompletionClient } from "../llm-client";
import { createSnapshotPresentation, fallbackSnapshotPresentation } from "./presentation";
import { computeEffectiveSnapshotCoverage } from "./effective-coverage";
import { analysisSliceBudgets, getPartitionedAnalysisSources } from "../remote-analysis";
import type { RemoteSourceBackend, SourceScopeRoot } from "../remote-source-index";
import { createSlicePlanner } from "../slice-planner";
import type { SnapshotAnalysis, SnapshotAnalysisPass, SnapshotIdentity, SnapshotProgressEvent, SnapshotWarning } from "./types";

export class SnapshotAnalysisError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotAnalysisError";
  }
}

export interface AnalyzeProductSnapshotOptions {
  backend: RemoteSourceBackend;
  identity: SnapshotIdentity;
  productName: string;
  scopeRoots?: SourceScopeRoot[];
  outputLanguage: "zh-CN" | "en";
  client: StructuredCompletionClient;
  analyze?: typeof analyzeWithAI;
  loadPartitions?: typeof getPartitionedAnalysisSources;
  enumerateSurface?: typeof enumerateImplementationSurface;
  now?: () => Date;
  onProgress?: (event: SnapshotProgressEvent) => void;
}

export async function analyzeProductSnapshot(options: AnalyzeProductSnapshotOptions): Promise<SnapshotAnalysis> {
  const now = options.now ?? (() => new Date());
  const scopeRoots = options.scopeRoots?.length ? options.scopeRoots : [{ path: "", role: "shared" as const }];
  const loadPartitions = options.loadPartitions ?? getPartitionedAnalysisSources;
  const enumerateSurface = options.enumerateSurface ?? enumerateImplementationSurface;
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
  const chunks = [];
  const passes: SnapshotAnalysisPass[] = [];
  const knownFeatureNames = new Set<string>();
  for (const [partitionIndex, partition] of partitions.entries()) {
    const current = partitionIndex + 1;
    const startedAt = Date.now();
    options.onProgress?.({ stage: "partition", status: "start", current, total: partitions.length });
    const extracted = await extractPassWithRetry({
      sources: partition.sources,
      change,
      context: {
        client: options.client,
        previousFeatureNames: [...knownFeatureNames],
        outputLanguage: options.outputLanguage,
        ...(partitions.length > 1 ? { partition: { index: partitionIndex + 1, total: partitions.length } } : {}),
      },
      allowSet: evidenceAllowSet(partition, change),
      label: `snapshot/${partitionIndex + 1}`,
      onRetry: (error) => options.onProgress?.({ stage: "partition", status: "retry", current, total: partitions.length, message: error.message.slice(0, 200) }),
      ...(options.analyze ? { analyze: options.analyze } : {}),
    });
    options.onProgress?.({ stage: "partition", status: "complete", current, total: partitions.length, durationMs: Date.now() - startedAt, retries: extracted.pass.retries });
    for (const feature of extracted.result.features) knownFeatureNames.add(feature.name);
    chunks.push({ result: extracted.result });
    passes.push(extracted.pass);
  }

  const { mergeChunkResults } = await import("../extraction-merge");
  let mergeStats = { changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 };
  const result = mergeChunkResults(chunks, (stats) => { mergeStats = stats; });
  if (result.features.length === 0) {
    throw new SnapshotAnalysisError("no_valid_spec", "No evidence-backed product features were extracted from this snapshot");
  }

  let presentation = fallbackSnapshotPresentation(result, options.outputLanguage);
  let presentationFallback = false;
  const presentationStartedAt = Date.now();
  options.onProgress?.({ stage: "presentation", status: "start" });
  try {
    presentation = await createSnapshotPresentation({ result, language: options.outputLanguage, client: options.client });
    options.onProgress?.({ stage: "presentation", status: "complete", durationMs: Date.now() - presentationStartedAt });
  } catch {
    presentationFallback = true;
    options.onProgress?.({ stage: "presentation", status: "fallback", durationMs: Date.now() - presentationStartedAt });
  }

  const implSurface = await enumerateSurface(index);
  const coverage = computeCoverageReceipt({
    index,
    partitions,
    implSurface,
  });
  const effectiveCoverage = computeEffectiveSnapshotCoverage({ partitions, implementationSurface: implSurface });
  const warnings: SnapshotWarning[] = [];
  if (options.identity.workingTreeDirty) warnings.push({ code: "working_tree_dirty" });
  if (presentationFallback) warnings.push({ code: "presentation_fallback" });
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
    identity: { ...options.identity },
    language: options.outputLanguage,
    generatedAt: now().toISOString(),
    modelName: options.client.displayName ?? "Configured model",
    result,
    partitions,
    index,
    coverage,
    warnings,
    passes,
    mergeStats,
    presentation,
    effectiveCoverage,
  };
}

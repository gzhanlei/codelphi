import type { analyzeWithAI } from "../ai";
import type { StructuredCompletionClient } from "../llm-client";
import type { RemoteSourceBackend, SourceScopeRoot } from "../remote-source-index";
import type { SnapshotAnalysis, SnapshotIdentity, SnapshotProgressEvent } from "./types";
import { executeSnapshotWorkOrder, finalizeSnapshotAnalysis, prepareSnapshotAnalysis } from "./workflow";

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
  loadPartitions?: typeof import("../remote-analysis").getPartitionedAnalysisSources;
  enumerateSurface?: typeof import("../analysis-coverage").enumerateImplementationSurface;
  now?: () => Date;
  onProgress?: (event: SnapshotProgressEvent) => void;
  /** 客户端分析：每个提示词加上「不输出源码」的约束（修订稿 §4.2）。 */
  noSourceOutput?: boolean;
}

export async function analyzeProductSnapshot(options: AnalyzeProductSnapshotOptions): Promise<SnapshotAnalysis> {
  const prepared = await prepareSnapshotAnalysis(options);
  const executions = [];
  const knownFeatureNames = new Set<string>();
  for (const [partitionIndex, workOrder] of prepared.workOrders.entries()) {
    const current = partitionIndex + 1;
    const startedAt = Date.now();
    options.onProgress?.({ stage: "partition", status: "start", current, total: prepared.workOrders.length });
    const execution = await executeSnapshotWorkOrder(workOrder, {
      client: options.client,
      previousFeatureNames: [...knownFeatureNames],
      onRetry: (error) => options.onProgress?.({ stage: "partition", status: "retry", current, total: prepared.workOrders.length, message: error.message.slice(0, 200) }),
      ...(options.analyze ? { analyze: options.analyze } : {}),
    });
    options.onProgress?.({ stage: "partition", status: "complete", current, total: prepared.workOrders.length, durationMs: Date.now() - startedAt, retries: execution.pass.retries });
    for (const feature of execution.result.features) knownFeatureNames.add(feature.name);
    executions.push(execution);
  }
  return finalizeSnapshotAnalysis(prepared, executions, {
    modelName: options.client.displayName ?? "Configured model",
    client: options.client,
    ...(prepared.noSourceOutput ? { noSourceOutput: true } : {}),
  });
}

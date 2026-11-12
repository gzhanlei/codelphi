import { pathToFileURL } from "node:url";
import type { LlmBillingContext } from "../lib/ai";
import { regenerateFeatureFlowForWorkbenchFeature } from "../lib/feature-flow-service";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";

export async function runFeatureFlowBackfill(argv: string[], regenerate: (featureId: number, billing?: LlmBillingContext) => Promise<FeatureFlowGraph>) {
  if (argv.length !== 2 || argv[0] !== "--feature-id") return 2;
  const featureId = Number(argv[1]);
  if (!Number.isSafeInteger(featureId) || featureId <= 0) return 2;
  try {
    const graph = await regenerate(featureId, { runId: null, accountId: null, chargeComponent: "main", callKind: "feature_flow_backfill" });
    console.log(`[feature-flow-backfill] featureId=${featureId} nodes=${graph.nodes.length} edges=${graph.edges.length} excluded=${graph.excludedScenarios.length}`);
    return 0;
  } catch (error) {
    console.error(`[feature-flow-backfill] featureId=${featureId} failed`, error);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runFeatureFlowBackfill(process.argv.slice(2), regenerateFeatureFlowForWorkbenchFeature).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error("[feature-flow-backfill] unhandled error", error);
    process.exitCode = 1;
  });
}

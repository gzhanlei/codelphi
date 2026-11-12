import type { LlmBillingContext } from "./ai";
import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { generateFeatureFlowGraph } from "./feature-flow-generation";
import { copyInheritedFeatureFlowGraphs, loadVersionFeatureRecords, saveFeatureFlowGraph } from "./feature-flow-store";
import { scenarioFingerprint, type FeatureFlowGraph } from "./semantic-feature-flow";
import { specFeatureKey, type SpecFeature, type SpecScenario } from "./spec-diff";

function payloadRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload) && Array.isArray(payload[0])) return payload[0] as T[];
  return (payload ?? []) as T[];
}

interface WorkbenchFeatureRow {
  id: number;
  name: string;
  summary: string;
  source: "generated" | "manual";
  specVersionId: number;
}

interface WorkbenchScenarioRow extends Omit<SpecScenario, "evidence"> {
  evidence: unknown;
}

async function previousVersionId(execute: Execute, repositoryId: number, specVersionId: number) {
  const rows = payloadRows<{ id: number }>(await execute(
    "SELECT id FROM spec_versions WHERE repository_id = ? AND id < ? ORDER BY id DESC LIMIT 1",
    [repositoryId, specVersionId],
  ));
  return rows[0]?.id ?? null;
}

export async function syncFeatureFlowsForVersion(options: { specVersionId: number; repositoryId: number; affectedKeys?: ReadonlySet<string> | null; billing?: LlmBillingContext }) {
  const execute = defaultExecute;
  const { specVersionId, repositoryId, affectedKeys, billing } = options;
  const previousId = await previousVersionId(execute, repositoryId, specVersionId);
  const copied = previousId === null ? 0 : await copyInheritedFeatureFlowGraphs(execute, previousId, specVersionId);
  const records = await loadVersionFeatureRecords(execute, specVersionId);
  const targets = affectedKeys == null ? records : records.filter((record) => affectedKeys.has(record.stableKey));
  let generated = 0;
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      try {
        const graph = await generateFeatureFlowGraph(target.feature, billing);
        await saveFeatureFlowGraph(execute, target.id, graph, scenarioFingerprint(target.feature.scenarios));
        generated += 1;
      } catch (error) {
        failed += 1;
        console.error("[feature-flow] generation failed", {
          specVersionId,
          specFeatureId: target.id,
          stableKey: target.stableKey,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);
  return { generated, copied, failed };
}

export async function regenerateFeatureFlowForWorkbenchFeature(featureId: number, billing?: LlmBillingContext): Promise<FeatureFlowGraph> {
  const execute = defaultExecute;
  const featureRows = payloadRows<WorkbenchFeatureRow>(await execute(
    `SELECT f.id, f.name, f.summary, f.source, latest.spec_version_id AS specVersionId
     FROM features f
     JOIN products p ON p.id = f.product_id
     JOIN releases latest ON latest.product_id = p.id AND latest.spec_version_id IS NOT NULL
     WHERE f.id = ? AND f.active = 1
     ORDER BY latest.committed_at DESC LIMIT 1`,
    [featureId],
  ));
  const row = featureRows[0];
  if (!row) throw new Error(`WORKBENCH_FEATURE_NOT_FOUND: ${featureId}`);
  const scenarioRows = payloadRows<WorkbenchScenarioRow>(await execute(
    "SELECT reference, context, action, outcome, category, step_order AS step, source, evidence FROM scenarios WHERE feature_id = ? AND active = 1 ORDER BY reference",
    [featureId],
  ));
  const scenarios: SpecScenario[] = scenarioRows.map((scenario) => ({
    reference: scenario.reference,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
    category: scenario.category,
    step: scenario.step,
    source: scenario.source,
    evidence: evidenceItems(scenario.evidence),
  }));
  const feature: SpecFeature = { name: row.name, summary: row.summary, source: row.source, scenarios };
  const records = await loadVersionFeatureRecords(execute, row.specVersionId);
  const record = records.find((candidate) => candidate.stableKey === specFeatureKey(row.name));
  if (!record) throw new Error(`SPEC_FEATURE_NOT_FOUND: ${featureId}@${row.specVersionId}`);
  const graph = await generateFeatureFlowGraph(feature, billing);
  await saveFeatureFlowGraph(execute, record.id, graph, scenarioFingerprint(scenarios));
  return graph;
}

import type { Execute } from "./db";
import { evidenceItems } from "./evidence";
import { parseJsonValue } from "./json";
import { scenarioFingerprint, validateFeatureFlowGraph, type FeatureFlowGraph } from "./semantic-feature-flow";
import { specFeatureKey, type SpecFeature, type SpecScenario } from "./spec-diff";

export interface SpecFeatureRecord {
  id: number;
  stableKey: string;
  feature: SpecFeature;
}

interface FeatureDbRow {
  id: number;
  stableKey: string;
  name: string;
  summary: string;
  parentKey: string | null;
  source: "generated" | "manual";
}

interface ScenarioDbRow extends Omit<SpecScenario, "evidence"> {
  featureId: number;
  evidence: unknown;
}

interface FlowDbRow {
  stableKey: string;
  graphJson: unknown;
  fingerprint: string;
}

function payloadRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload) && Array.isArray(payload[0])) return payload[0] as T[];
  return (payload ?? []) as T[];
}

function scenarioFromRow(row: ScenarioDbRow): SpecScenario {
  return {
    reference: row.reference,
    context: row.context,
    action: row.action,
    outcome: row.outcome,
    category: row.category,
    step: row.step === null || row.step === undefined ? null : Number(row.step),
    source: row.source,
    evidence: evidenceItems(row.evidence),
  };
}

export async function loadVersionFeatureRecords(execute: Execute, versionId: number): Promise<SpecFeatureRecord[]> {
  const featureRows = payloadRows<FeatureDbRow>(await execute(
    "SELECT id, stable_key AS stableKey, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id = ? ORDER BY position",
    [versionId],
  ));
  if (featureRows.length === 0) return [];
  const ids = featureRows.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const scenarioRows = payloadRows<ScenarioDbRow>(await execute(
    `SELECT spec_feature_id AS featureId, reference, context, action, outcome, category, step_order AS step, source, evidence FROM spec_scenarios WHERE spec_feature_id IN (${placeholders})`,
    ids,
  ));
  return featureRows.map((row) => ({
    id: row.id,
    stableKey: row.stableKey,
    feature: {
      name: row.name,
      summary: row.summary,
      parentKey: row.parentKey,
      source: row.source,
      scenarios: scenarioRows.filter((scenario) => scenario.featureId === row.id).map(scenarioFromRow),
    },
  }));
}

export async function saveFeatureFlowGraph(execute: Execute, specFeatureId: number, graph: FeatureFlowGraph, fingerprint: string) {
  await execute(
    `INSERT INTO spec_feature_flows (spec_feature_id, graph_json, scenario_fingerprint)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE graph_json = VALUES(graph_json), scenario_fingerprint = VALUES(scenario_fingerprint), updated_at = CURRENT_TIMESTAMP(3)`,
    [specFeatureId, JSON.stringify(graph), fingerprint],
  );
}

async function loadFlowRows(execute: Execute, versionId: number) {
  return payloadRows<FlowDbRow>(await execute(
    `SELECT sf.stable_key AS stableKey, ff.graph_json AS graphJson, ff.scenario_fingerprint AS fingerprint
     FROM spec_feature_flows ff JOIN spec_features sf ON sf.id = ff.spec_feature_id
     WHERE sf.spec_version_id = ?`,
    [versionId],
  ));
}

function graphFromRow(row: FlowDbRow, feature: SpecFeature) {
  if (row.fingerprint !== scenarioFingerprint(feature.scenarios)) return null;
  try {
    return validateFeatureFlowGraph(parseJsonValue(row.graphJson), feature.scenarios);
  } catch {
    return null;
  }
}

export async function loadFeatureFlowGraphs(execute: Execute, versionId: number, features: SpecFeature[]) {
  const result = new Map<string, FeatureFlowGraph>();
  if (features.length === 0) return result;
  const rows = await loadFlowRows(execute, versionId);
  const rowsByKey = new Map(rows.map((row) => [row.stableKey, row]));
  for (const feature of features) {
    const key = specFeatureKey(feature.name);
    const row = rowsByKey.get(key);
    if (!row) continue;
    const graph = graphFromRow(row, feature);
    if (graph) result.set(key, graph);
  }
  return result;
}

export async function copyInheritedFeatureFlowGraphs(execute: Execute, previousVersionId: number, nextVersionId: number) {
  if (previousVersionId === nextVersionId) return 0;
  const [previousFeatures, nextFeatures, previousFlows] = await Promise.all([
    loadVersionFeatureRecords(execute, previousVersionId),
    loadVersionFeatureRecords(execute, nextVersionId),
    loadFlowRows(execute, previousVersionId),
  ]);
  const previousByKey = new Map(previousFeatures.map((record) => [record.stableKey, record]));
  const flowsByKey = new Map(previousFlows.map((row) => [row.stableKey, row]));
  let copied = 0;
  for (const next of nextFeatures) {
    const previous = previousByKey.get(next.stableKey);
    const row = flowsByKey.get(next.stableKey);
    if (!previous || !row) continue;
    const nextFingerprint = scenarioFingerprint(next.feature.scenarios);
    if (scenarioFingerprint(previous.feature.scenarios) !== nextFingerprint || row.fingerprint !== nextFingerprint) continue;
    const graph = graphFromRow(row, next.feature);
    if (!graph) continue;
    await saveFeatureFlowGraph(execute, next.id, graph, nextFingerprint);
    copied += 1;
  }
  return copied;
}

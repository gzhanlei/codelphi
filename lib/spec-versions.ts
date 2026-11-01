import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "./ai";
import type { RunContext } from "./analysis";
import { evidenceItems } from "./evidence";
import { diffSpec, mergeSpecSources, specFeatureKey, type SpecChange, type SpecFeature, type SpecScenario } from "./spec-diff";

interface FeatureRow {
  id: number;
  name: string;
  summary: string;
  parentKey?: string | null;
  source: "generated" | "manual";
}

interface ScenarioRow {
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: SpecScenario["category"];
  source: "generated" | "manual";
  evidence: unknown;
}

function featuresFromRows(featureRows: FeatureRow[], scenarioRows: ScenarioRow[]): SpecFeature[] {
  return featureRows.map((feature) => ({
    ...feature,
    scenarios: scenarioRows.filter((scenario) => scenario.featureId === feature.id).map((scenario) => ({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category,
      source: scenario.source,
      evidence: evidenceItems(scenario.evidence),
    })),
  }));
}

async function loadManualSpec(connection: PoolConnection, productId: number) {
  const [featureRows] = await connection.execute(
    `SELECT id, name, summary, source FROM features
     WHERE product_id = ? AND active = 1 AND (
       source = 'manual' OR EXISTS (
         SELECT 1 FROM scenarios s WHERE s.feature_id = features.id AND s.source = 'manual' AND s.active = 1
       )
     )`,
    [productId],
  );
  const features = featureRows as FeatureRow[];
  if (features.length === 0) return [];
  const ids = features.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const [scenarioRows] = await connection.execute(
    `SELECT feature_id AS featureId, reference, context, action, outcome, category, source, evidence
     FROM scenarios WHERE source = 'manual' AND active = 1 AND feature_id IN (${placeholders})`,
    ids,
  );
  return featuresFromRows(features, scenarioRows as ScenarioRow[]);
}

async function loadPreviousSpec(connection: PoolConnection, run: RunContext) {
  const [versions] = await connection.execute(
    "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
    [run.repositoryId],
  );
  const version = (versions as Array<{ id: number }>)[0];
  if (!version) return null;

  const [featureRows] = await connection.execute("SELECT id, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id = ? ORDER BY position", [version.id]);
  const features = featureRows as FeatureRow[];
  if (features.length === 0) return { id: version.id, features: [] };
  const ids = features.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const [scenarioRows] = await connection.execute(
    `SELECT spec_feature_id AS featureId, reference, context, action, outcome, category, source, evidence
     FROM spec_scenarios WHERE spec_feature_id IN (${placeholders})`,
    ids,
  );
  return { id: version.id, features: featuresFromRows(features, scenarioRows as ScenarioRow[]) };
}

async function insertFeatures(connection: PoolConnection, versionId: number, features: SpecFeature[]) {
  for (const [position, feature] of features.entries()) {
    const [featureResult] = await connection.execute(
      `INSERT INTO spec_features (spec_version_id, stable_key, name, summary, parent_key, source, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [versionId, specFeatureKey(feature.name), feature.name, feature.summary, feature.parentKey ?? null, feature.source ?? "generated", position],
    );
    const featureId = Number((featureResult as { insertId: number }).insertId);
    for (const scenario of feature.scenarios) {
      await connection.execute(
        `INSERT INTO spec_scenarios
          (spec_feature_id, reference, context, action, outcome, category, source, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, scenario.source ?? "generated", JSON.stringify(scenario.evidence)],
      );
    }
  }
}

async function insertChanges(connection: PoolConnection, versionId: number, baseVersionId: number | null, changes: SpecChange[]) {
  for (const change of changes) {
    await connection.execute(
      `INSERT INTO spec_changes
        (spec_version_id, base_spec_version_id, entity_type, kind, feature_key, feature_name,
         scenario_reference, summary, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        versionId,
        baseVersionId,
        change.entityType,
        change.kind,
        specFeatureKey(change.featureName),
        change.featureName,
        change.scenarioReference ?? "",
        change.summary,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
      ],
    );
  }
}

export async function insertSpecVersion(connection: PoolConnection, run: RunContext, result: AnalysisResult) {
  const [previous, manual] = await Promise.all([loadPreviousSpec(connection, run), loadManualSpec(connection, run.productId)]);
  const features = mergeSpecSources(result.features, manual);
  const changes = diffSpec(previous?.features ?? null, features);
  const [versionResult] = await connection.execute(
    "INSERT INTO spec_versions (product_id, repository_id, analysis_run_id, sha) VALUES (?, ?, ?, ?)",
    [run.productId, run.repositoryId, run.id, run.afterSha],
  );
  const versionId = Number((versionResult as { insertId: number }).insertId);
  await insertFeatures(connection, versionId, features);
  await insertChanges(connection, versionId, previous?.id ?? null, changes);
  return versionId;
}

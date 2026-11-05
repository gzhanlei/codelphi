import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "./ai";
import type { RunContext } from "./analysis";
import { evidenceItems } from "./evidence";
import { diffSpec, mergeSpecSources, specFeatureKey, specScenarioKey, type SpecChange, type SpecFeature, type SpecScenario, type SpecTombstones } from "./spec-diff";

interface FeatureRow {
  id: number;
  name: string;
  summary: string;
  parentId?: number | null;
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

export function featureParentKey(feature: { parentId?: number | null; parentKey?: string | null }, parentNames: Map<number, string>) {
  if (feature.parentId) {
    const parentName = parentNames.get(feature.parentId);
    if (parentName !== undefined) return parentName;
  }
  return feature.parentKey === undefined ? null : feature.parentKey;
}

function featuresFromRows(featureRows: FeatureRow[], scenarioRows: ScenarioRow[]): SpecFeature[] {
  const parentNames = new Map(featureRows.map((feature) => [feature.id, feature.name]));
  return featureRows.map((feature) => ({
    ...feature,
    parentKey: featureParentKey(feature, parentNames),
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

async function loadScenarioRows(connection: PoolConnection, features: FeatureRow[], kind: "manual" | "version") {
  if (features.length === 0) return [];
  const ids = features.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const config = kind === "manual"
    ? { table: "scenarios", column: "feature_id", condition: `source = 'manual' AND active = 1 AND feature_id IN (${placeholders})` }
    : { table: "spec_scenarios", column: "spec_feature_id", condition: `spec_feature_id IN (${placeholders})` };
  const [rows] = await connection.execute(
    `SELECT ${config.column} AS featureId, reference, context, action, outcome, category, source, evidence
     FROM ${config.table} WHERE ${config.condition}`,
    ids,
  );
  return rows as ScenarioRow[];
}

async function loadFeatureSpec(connection: PoolConnection, kind: "manual" | "version", query: string, parameters: number[]) {
  const [featureRows] = await connection.execute(query, parameters);
  const features = featureRows as FeatureRow[];
  return featuresFromRows(features, await loadScenarioRows(connection, features, kind));
}

async function loadManualSpec(connection: PoolConnection, productId: number) {
  return loadFeatureSpec(
    connection,
    "manual",
    `SELECT features.id, features.name, features.summary, features.parent_id AS parentId, parents.name AS parentKey, features.source
     FROM features LEFT JOIN features parents ON parents.id = features.parent_id AND parents.active = 1
     WHERE features.product_id = ? AND features.active = 1 AND (
       features.source = 'manual' OR EXISTS (
         SELECT 1 FROM scenarios s WHERE s.feature_id = features.id AND s.source = 'manual' AND s.active = 1
       ) OR EXISTS (
         SELECT 1 FROM features child WHERE child.parent_id = features.id AND child.active = 1
       )
     )`,
    [productId],
  );
}

async function loadManualTombstones(connection: PoolConnection, productId: number): Promise<SpecTombstones> {
  const [featureResult, scenarioResult] = await Promise.all([
    connection.execute("SELECT name FROM features WHERE product_id = ? AND active = 0 AND source = 'manual'", [productId]),
    connection.execute("SELECT f.name AS featureName, s.reference FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? AND s.active = 0 AND s.source = 'manual'", [productId]),
  ]);
  const featureRows = featureResult[0] as Array<{ name: string }>;
  const scenarioRows = scenarioResult[0] as Array<{ featureName: string; reference: string }>;
  return {
    featureKeys: new Set(featureRows.map((feature) => specFeatureKey(feature.name))),
    scenarioKeys: new Set(scenarioRows.map((scenario) => specScenarioKey(scenario.featureName, scenario.reference))),
  };
}

async function loadVersionFeatures(connection: PoolConnection, versionId: number) {
  return loadFeatureSpec(connection, "version", "SELECT id, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id = ? ORDER BY position", [versionId]);
}

async function loadPreviousSpec(connection: PoolConnection, run: RunContext) {
  const [versions] = await connection.execute(
    "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
    [run.repositoryId],
  );
  const version = (versions as Array<{ id: number }>)[0];
  if (!version) return null;
  const features = await loadVersionFeatures(connection, version.id);
  return { id: version.id, features };
}

async function insertFeatures(connection: PoolConnection, versionId: number, features: SpecFeature[]) {
  for (const [position, feature] of features.entries()) {
    const [featureResult] = await connection.execute(
      `INSERT INTO spec_features (spec_version_id, stable_key, name, summary, parent_key, source, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [versionId, specFeatureKey(feature.name), feature.name, feature.summary, feature.parentKey === undefined ? null : feature.parentKey, feature.source === undefined ? "generated" : feature.source, position],
    );
    const featureId = Number((featureResult as { insertId: number }).insertId);
    for (const scenario of feature.scenarios) {
      await connection.execute(
        `INSERT INTO spec_scenarios
          (spec_feature_id, reference, context, action, outcome, category, source, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, scenario.source === undefined ? "generated" : scenario.source, JSON.stringify(scenario.evidence)],
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
        change.scenarioReference === null ? "" : change.scenarioReference,
        change.summary,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
      ],
    );
  }
}

export async function insertSpecVersion(connection: PoolConnection, run: RunContext, result: AnalysisResult) {
  const [previous, manual, tombstones] = await Promise.all([loadPreviousSpec(connection, run), loadManualSpec(connection, run.productId), loadManualTombstones(connection, run.productId)]);
  const features = mergeSpecSources(result.features, manual, tombstones);
  const changes = diffSpec(previous === null ? null : previous.features, features);
  const [versionResult] = await connection.execute(
    "INSERT INTO spec_versions (product_id, repository_id, analysis_run_id, sha) VALUES (?, ?, ?, ?)",
    [run.productId, run.repositoryId, run.id, run.afterSha],
  );
  const versionId = Number((versionResult as { insertId: number }).insertId);
  await insertFeatures(connection, versionId, features);
  await insertChanges(connection, versionId, previous === null ? null : previous.id, changes);
  return versionId;
}

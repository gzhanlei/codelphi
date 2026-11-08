import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult, SpecAnchorFeature } from "./ai";
import type { RunContext } from "./analysis";
import { defaultExecute, type Execute } from "./db";
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

/** 批量读取多个 spec 版本的完整规格（发布变化视图的折叠明细重算用），key 为版本 id。 */
export async function loadVersionFeatureMap(execute: Execute, versionIds: number[]): Promise<Map<number, SpecFeature[]>> {
  const featureMap = new Map<number, SpecFeature[]>();
  if (versionIds.length === 0) return featureMap;
  const placeholders = versionIds.map(() => "?").join(",");
  const [featureResult, scenarioResult] = await Promise.all([
    execute(`SELECT id, spec_version_id AS versionId, name, summary, parent_key AS parentKey, source FROM spec_features WHERE spec_version_id IN (${placeholders}) ORDER BY position`, versionIds),
    execute(
      `SELECT sf.spec_version_id AS versionId, ss.spec_feature_id AS featureId, ss.reference, ss.context, ss.action, ss.outcome, ss.category, ss.source, ss.evidence
       FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id
       WHERE sf.spec_version_id IN (${placeholders})`,
      versionIds,
    ),
  ]);
  const featureRows = (Array.isArray(featureResult) ? featureResult[0] : []) as Array<FeatureRow & { versionId: number }>;
  const scenarioRows = (Array.isArray(scenarioResult) ? scenarioResult[0] : []) as Array<ScenarioRow & { versionId: number }>;

  const featuresByVersion = new Map<number, FeatureRow[]>();
  for (const row of featureRows) {
    const list = featuresByVersion.get(Number(row.versionId)) ?? [];
    list.push(row);
    featuresByVersion.set(Number(row.versionId), list);
  }
  for (const [versionId, rows] of featuresByVersion) {
    featureMap.set(versionId, featuresFromRows(rows, scenarioRows.filter((scenario) => scenario.versionId === versionId)));
  }
  return featureMap;
}

/** 读取每个 spec 版本在同仓库下的前一版本 id（diffSpec 的 base）；首个版本无 base 返回 null。 */
export async function loadBaseVersionMap(execute: Execute, versionIds: number[]): Promise<Map<number, number | null>> {
  const baseMap = new Map<number, number | null>();
  if (versionIds.length === 0) return baseMap;
  const placeholders = versionIds.map(() => "?").join(",");
  const result = await execute(
    `SELECT v.id AS versionId,
            (SELECT prev.id FROM spec_versions prev WHERE prev.repository_id = v.repository_id AND prev.id < v.id ORDER BY prev.id DESC LIMIT 1) AS baseVersionId
     FROM spec_versions v WHERE v.id IN (${placeholders})`,
    versionIds,
  );
  // mysql2 execute resolve 值是 [rows, fields] 元组；先取行数组再使用。
  const payload = Array.isArray(result) ? result[0] : [];
  for (const row of (Array.isArray(payload) ? payload : []) as Array<{ versionId: number; baseVersionId: number | null }>) {
    baseMap.set(Number(row.versionId), row.baseVersionId === null ? null : Number(row.baseVersionId));
  }
  return baseMap;
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

export async function insertSpecVersion(connection: PoolConnection, run: RunContext, result: AnalysisResult, options: { affectedKeys?: ReadonlySet<string>; behavioralChangePaths?: ReadonlySet<string> } = {}): Promise<{ specVersionId: number; features: ReturnType<typeof mergeSpecSources>; collapse: SpecVersionCollapse | null }> {
  const [previous, manual, tombstones] = await Promise.all([loadPreviousSpec(connection, run), loadManualSpec(connection, run.productId), loadManualTombstones(connection, run.productId)]);
  // M9 增量模式：受影响集之外的 generated 条目原样沿用上一版（三分合并：carried 种子 < AI < manual）。
  const affectedKeys = options.affectedKeys;
  const carried = affectedKeys && previous
    ? previous.features.filter((feature) => !affectedKeys.has(specFeatureKey(feature.name)))
    : [];
  const features = mergeSpecSources(result.features, manual, tombstones, carried);
  const changes = diffSpec(previous === null ? null : previous.features, features, options.behavioralChangePaths ? { behavioralChangePaths: options.behavioralChangePaths } : undefined);
  const collapse = detectSpecCollapse(previous, features);
  const [versionResult] = await connection.execute(
    "INSERT INTO spec_versions (product_id, repository_id, analysis_run_id, sha) VALUES (?, ?, ?, ?)",
    [run.productId, run.repositoryId, run.id, run.afterSha],
  );
  const versionId = Number((versionResult as { insertId: number }).insertId);
  await insertFeatures(connection, versionId, features);
  await insertChanges(connection, versionId, previous === null ? null : previous.id, changes);
  // 合并后的完整 spec 一并返回：M9 影子对比必须以 carry-forward 之后的规格为对象。
  return { specVersionId: versionId, features, collapse };
}

/** 规格坍缩（护栏）：新版场景数较上一版骤降超过阈值。生产 v95（2026-11-08）178→83 即此形态。 */
export interface SpecVersionCollapse {
  previousScenarios: number;
  currentScenarios: number;
}

export const SPEC_COLLAPSE_RATIO = 0.7;
/** 低于该规模的新版不做坍缩判定，避免小规格的正常增删触发误报。 */
export const SPEC_COLLAPSE_MIN_PREVIOUS = 20;

function countScenarios(features: SpecFeature[]) {
  return features.reduce((total, feature) => total + feature.scenarios.length, 0);
}

/** 坍缩纯判定，导出供测试复用；insertSpecVersion 落库前调用。 */
export function detectSpecCollapse(previous: { features: SpecFeature[] } | null, features: SpecFeature[]): SpecVersionCollapse | null {
  if (!previous) return null;
  const before = countScenarios(previous.features);
  const after = countScenarios(features);
  if (before < SPEC_COLLAPSE_MIN_PREVIOUS) return null;
  if (after >= before * SPEC_COLLAPSE_RATIO) return null;
  return { previousScenarios: before, currentScenarios: after };
}

/** B：读取最新 spec 版本的功能名清单（分析前调用，供 prompt 命名连续性约束）。 */
export async function loadPreviousFeatureNames(repositoryId: number, execute: Execute = defaultExecute) {
  const result = await execute(
    `SELECT sf.name FROM spec_features sf
     WHERE sf.spec_version_id = (SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1)
     ORDER BY sf.id`,
    [repositoryId],
  );
  // mysql2 execute resolve 值是 [rows, fields] 元组；先取行数组再使用。
  const payload = Array.isArray(result) ? result[0] : [];
  const rows = (Array.isArray(payload) ? payload : []) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export type { SpecAnchorFeature };

/** P0 措辞锚定：读取最新 spec 版本的场景级全文（分析前调用，未变行为要求 AI 逐字沿用）。加载失败由调用方降级处理。 */
export async function loadPreviousSpecText(repositoryId: number, execute: Execute = defaultExecute): Promise<SpecAnchorFeature[]> {
  const versionResult = await execute(
    "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
    [repositoryId],
  );
  const versionPayload = Array.isArray(versionResult) ? versionResult[0] : [];
  const version = (Array.isArray(versionPayload) ? versionPayload : [])[0] as { id: number } | undefined;
  if (!version) return [];

  const featureResult = await execute(
    "SELECT id, name, summary FROM spec_features WHERE spec_version_id = ? ORDER BY position",
    [version.id],
  );
  const featurePayload = Array.isArray(featureResult) ? featureResult[0] : [];
  const featureRows = (Array.isArray(featurePayload) ? featurePayload : []) as Array<{ id: number; name: string; summary: string }>;
  if (featureRows.length === 0) return [];

  const ids = featureRows.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const scenarioResult = await execute(
    `SELECT spec_feature_id AS featureId, reference, context, action, outcome, category
     FROM spec_scenarios WHERE spec_feature_id IN (${placeholders})`,
    ids,
  );
  const scenarioPayload = Array.isArray(scenarioResult) ? scenarioResult[0] : [];
  const scenarioRows = (Array.isArray(scenarioPayload) ? scenarioPayload : []) as Array<{ featureId: number; reference: string; context: string; action: string; outcome: string; category: string }>;

  return featureRows.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: scenarioRows
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario) => ({ reference: scenario.reference, context: scenario.context, action: scenario.action, outcome: scenario.outcome, category: scenario.category })),
  }));
}

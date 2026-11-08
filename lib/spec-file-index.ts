import type { PoolConnection } from "mysql2/promise";
import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";

interface SpecEvidenceRow {
  specFeatureId: number;
  specScenarioId: number | null;
  evidence: unknown;
}

/**
 * 用最新 spec 快照重建 path → 规格 的反向索引（PR 预演与增量分析共用）。
 * 必须在 insertSpecVersion 的同一事务内调用，保证索引与快照版本一致。
 */
export async function rebuildSpecFileIndex(connection: PoolConnection, repositoryId: number, specVersionId: number) {
  const [rows] = await connection.execute(
    `SELECT sf.id AS specFeatureId, ss.id AS specScenarioId, ss.evidence
     FROM spec_features sf
     LEFT JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id
     WHERE sf.spec_version_id = ?`,
    [specVersionId],
  );

  const seen = new Set<string>();
  const entries: Array<[number, number, number, number | null, string]> = [];
  for (const row of rows as Array<{ specFeatureId: number; specScenarioId: number | null; evidence: unknown }>) {
    for (const item of evidenceItems(row.evidence)) {
      if (!item.path) continue;
      const key = `${row.specScenarioId}:${item.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push([repositoryId, specVersionId, row.specFeatureId, row.specScenarioId, item.path]);
    }
  }

  await connection.execute("DELETE FROM spec_file_index WHERE repository_id = ?", [repositoryId]);
  for (const entry of entries) {
    await connection.execute(
      "INSERT INTO spec_file_index (repository_id, spec_version_id, spec_feature_id, spec_scenario_id, path) VALUES (?, ?, ?, ?, ?)",
      entry,
    );
  }
}

export interface AffectedFeatureKeys {
  keys: Set<string>;
  names: string[];
}

/** M9：diff 触碰的文件 ∩ 反向索引 → 受影响的规格功能（stable_key 集合 + 名称清单）。 */
export async function loadAffectedFeatureKeys(repositoryId: number, paths: string[], execute: Execute = defaultExecute): Promise<AffectedFeatureKeys> {
  if (paths.length === 0) return { keys: new Set(), names: [] };
  const placeholders = paths.map(() => "?").join(",");
  const result = await execute(
    `SELECT DISTINCT sf.stable_key AS stableKey, sf.name
     FROM spec_file_index i
     JOIN spec_features sf ON sf.id = i.spec_feature_id
     WHERE i.repository_id = ? AND i.path IN (${placeholders})
     ORDER BY sf.name`,
    [repositoryId, ...paths],
  );
  const payload = Array.isArray(result) ? result[0] : [];
  const rows = (Array.isArray(payload) ? payload : []) as Array<{ stableKey: string; name: string }>;
  return { keys: new Set(rows.map((row) => row.stableKey)), names: [...new Set(rows.map((row) => row.name))] };
}

export interface AffectedScenario {
  reference: string | null;
  evidencePath: string;
  context: string | null;
  action: string | null;
  outcome: string | null;
}

export interface AffectedFeatureImpact {
  featureId: number;
  feature: string;
  /** 版本层 stable_key，供 stable-links 解析到工作台层 feature（影响面结果链接用）。 */
  stableKey: string;
  scenarios: AffectedScenario[];
}

/** C2 事前影响分析 spike：给定文件清单，反查最新规格里受影响的功能与场景（PR 预演同源索引）。 */
export async function loadAffectedScenarios(repositoryId: number, paths: string[], execute: Execute = defaultExecute): Promise<AffectedFeatureImpact[]> {
  if (paths.length === 0) return [];
  const placeholders = paths.map(() => "?").join(",");
  const result = await execute(
    `SELECT sf.id AS featureId, sf.name AS feature, sf.stable_key AS stableKey, ss.reference AS reference, i.path AS evidencePath,
            ss.context AS context, ss.action AS action, ss.outcome AS outcome
     FROM spec_file_index i
     JOIN spec_features sf ON sf.id = i.spec_feature_id
     LEFT JOIN spec_scenarios ss ON ss.id = i.spec_scenario_id
     WHERE i.repository_id = ? AND i.path IN (${placeholders})
     ORDER BY sf.name, ss.reference`,
    [repositoryId, ...paths],
  );
  const payload = Array.isArray(result) ? result[0] : [];
  const rows = (Array.isArray(payload) ? payload : []) as Array<{ featureId: number; feature: string; stableKey: string; reference: string | null; evidencePath: string; context: string | null; action: string | null; outcome: string | null }>;
  const byFeature = new Map<string, AffectedFeatureImpact>();
  for (const row of rows) {
    let impact = byFeature.get(row.feature);
    if (!impact) {
      impact = { featureId: Number(row.featureId), feature: row.feature, stableKey: row.stableKey, scenarios: [] };
      byFeature.set(row.feature, impact);
    }
    impact.scenarios.push({ reference: row.reference, evidencePath: row.evidencePath, context: row.context, action: row.action, outcome: row.outcome });
  }
  return [...byFeature.values()];
}

import type { PoolConnection } from "mysql2/promise";
import { specFeatureKey } from "./spec-diff";

/**
 * 规格漂移标记：本次分析的行为变化触及了哪些条目，其 manual 内容可能已过时。
 * 打点粒度 = 变化粒度：feature 级变化（身份/摘要）打点 manual 功能；scenario 级变化
 * 只打点 manual 场景——generated 场景的提取抖动不牵连同功能的 manual 条目
 * （generated 内容由 AI 维护、下轮自愈，与人工规格是否过时无关）。
 * 只打元数据（stale_since/stale_change_id），不改变 source，不参与覆盖判定。
 * 必须在 saveResult 事务内 insertSpecVersion 之后调用。
 */
export async function markSpecDrift(connection: PoolConnection, productId: number, specVersionId: number) {
  const [changeRows] = await connection.execute(
    "SELECT id, entity_type AS entityType, feature_key AS featureKey, scenario_reference AS scenarioReference FROM spec_changes WHERE spec_version_id = ?",
    [specVersionId],
  );
  const changes = changeRows as Array<{ id: number; entityType: string; featureKey: string; scenarioReference: string }>;
  if (changes.length === 0) return;

  const [featureRows] = await connection.execute("SELECT id, name, source FROM features WHERE product_id = ? AND active = 1", [productId]);
  const features = featureRows as Array<{ id: number; name: string; source: string }>;
  const [scenarioRows] = await connection.execute(
    `SELECT s.id, s.feature_id AS featureId, s.reference, s.source FROM scenarios s
     JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND s.active = 1 AND f.active = 1`,
    [productId],
  );
  const scenarios = scenarioRows as Array<{ id: number; featureId: number; reference: string; source: string }>;

  const featureIdByKey = new Map(features.map((feature) => [specFeatureKey(feature.name), feature]));
  for (const change of changes) {
    const feature = featureIdByKey.get(change.featureKey);
    if (!feature) continue;
    if (feature.source === "manual" && change.entityType === "feature") {
      await connection.execute(
        "UPDATE features SET stale_since = CURRENT_TIMESTAMP(3), stale_change_id = ? WHERE id = ? AND source = 'manual'",
        [change.id, feature.id],
      );
    }
    if (change.entityType !== "scenario" || !change.scenarioReference) continue;
    for (const scenario of scenarios) {
      if (scenario.featureId !== feature.id || scenario.reference !== change.scenarioReference || scenario.source !== "manual") continue;
      await connection.execute(
        "UPDATE scenarios SET stale_since = CURRENT_TIMESTAMP(3), stale_change_id = ? WHERE id = ? AND source = 'manual'",
        [change.id, scenario.id],
      );
    }
  }
}

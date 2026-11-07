import { defaultExecute, type Execute } from "./db";

/**
 * M3 稳定引用：stable_key → 最新 spec 版本条目 → 活跃 live spec 条目。
 * stable_key 指向「包含该条目的最新 spec_version」（migration 002 的唯一索引按版本生效），
 * 再映射到 live features/scenarios，跳转后由产品页 spec 视图渲染。
 */

async function latestSpecFeatureName(stableKey: string, productId: number, execute: Execute) {
  const [rows] = await execute(
    `SELECT sf.name, sf.spec_version_id AS specVersionId
     FROM spec_features sf
     JOIN spec_versions v ON v.id = sf.spec_version_id
     JOIN repositories r ON r.id = v.repository_id
     WHERE sf.stable_key = ? AND r.product_id = ?
     ORDER BY sf.spec_version_id DESC
     LIMIT 1`,
    [stableKey, productId],
  ) as [Array<{ name: string; specVersionId: number }>, unknown];
  return rows[0] ?? null;
}

/** 返回 live feature id；条目从未存在或已从最新规格退役时返回 null。 */
export async function resolveFeatureByStableKey(productId: number, stableKey: string, execute: Execute = defaultExecute): Promise<number | null> {
  const specFeature = await latestSpecFeatureName(stableKey, productId, execute);
  if (!specFeature) return null;
  const [rows] = await execute(
    "SELECT f.id FROM features f WHERE f.product_id = ? AND f.name = ? AND f.active = 1 LIMIT 1",
    [productId, specFeature.name],
  ) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number((rows[0] as { id: number }).id) : null;
}

/** 返回场景所在 live feature id；场景未知时返回 null。 */
export async function resolveScenarioByStableKey(productId: number, stableKey: string, reference: string, execute: Execute = defaultExecute): Promise<number | null> {
  const specFeature = await latestSpecFeatureName(stableKey, productId, execute);
  if (!specFeature) return null;
  const [rows] = await execute(
    `SELECT f.id FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND f.name = ? AND f.active = 1 AND s.active = 1 AND s.reference = ?
     LIMIT 1`,
    [productId, specFeature.name, reference],
  ) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number((rows[0] as { id: number }).id) : null;
}

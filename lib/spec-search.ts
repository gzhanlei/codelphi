import { defaultExecute, type Execute } from "./db";

export interface SpecSearchResult {
  features: Array<{ id: number; name: string; summary: string }>;
  scenarios: Array<{ id: number; featureId: number; featureName: string; reference: string; context: string; action: string; outcome: string }>;
}

function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** M3 产品内搜索：LIKE 起步（功能名/摘要、场景四段文本、证据路径），数据量证明需要后再上 FULLTEXT。 */
export async function searchSpec(productId: number, query: string, execute: Execute = defaultExecute): Promise<SpecSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { features: [], scenarios: [] };
  const pattern = likePattern(trimmed);
  const [featureRows] = await execute(
    `SELECT f.id, f.name, f.summary FROM features f
     WHERE f.product_id = ? AND f.active = 1 AND (f.name LIKE ? OR f.summary LIKE ?)
     ORDER BY f.name LIMIT 20`,
    [productId, pattern, pattern],
  ) as [SpecSearchResult["features"], unknown];
  const [scenarioRows] = await execute(
    `SELECT s.id, f.id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome
     FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND f.active = 1 AND s.active = 1
       AND (s.reference LIKE ? OR s.context LIKE ? OR s.action LIKE ? OR s.outcome LIKE ? OR s.evidence LIKE ?)
     ORDER BY f.name, s.reference LIMIT 30`,
    [productId, pattern, pattern, pattern, pattern, pattern],
  ) as [SpecSearchResult["scenarios"], unknown];
  return { features: featureRows, scenarios: scenarioRows };
}

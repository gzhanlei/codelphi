import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { specFeatureKey } from "./spec-diff";
import type { Evidence } from "./types";

export interface SpecSearchResult {
  features: Array<{ id: number; name: string; summary: string; stableKey: string }>;
  scenarios: Array<{ id: number; featureId: number; featureName: string; featureStableKey: string; reference: string; context: string; action: string; outcome: string; evidence: Evidence[] }>;
}

export function likePattern(query: string) {
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
  type ScenarioSource = Omit<SpecSearchResult["scenarios"][number], "evidence"> & { evidence: unknown };
  const [scenarioRows] = await execute(
    `SELECT s.id, f.id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.evidence
     FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND f.active = 1 AND s.active = 1
       AND (s.reference LIKE ? OR s.context LIKE ? OR s.action LIKE ? OR s.outcome LIKE ? OR s.evidence LIKE ?)
     ORDER BY f.name, s.reference LIMIT 30`,
    [productId, pattern, pattern, pattern, pattern, pattern],
  ) as [ScenarioSource[], unknown];
  // evidence 在 DB 是 JSON 列：在这里一次性解析，调用方（搜索 / 检索式问答 / 未来的 MCP）拿到的都是结构化证据。
  // stableKey 让 MCP 调用方可以拿搜索结果直接寻址 get_feature / get_scenario，不必自行拼归一化约定。
  return {
    features: featureRows.map((feature) => ({ ...feature, stableKey: specFeatureKey(feature.name) })),
    scenarios: scenarioRows.map((row) => ({ ...row, featureStableKey: specFeatureKey(row.featureName), evidence: evidenceItems(row.evidence) })),
  };
}

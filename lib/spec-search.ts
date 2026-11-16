import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { specFeatureKey, type SpecScenario } from "./spec-diff";
import type { Evidence } from "./types";

export interface SpecSearchResult {
  features: Array<{ id: number; name: string; summary: string; stableKey: string }>;
  scenarios: Array<{ id: number; featureId: number; featureName: string; featureStableKey: string; reference: string; context: string; action: string; outcome: string; evidence: Evidence[] }>;
}

export interface ReleaseBehaviorResult {
  source: "release";
  releaseId: number;
  sha: string;
  committedAt: Date;
  specChangeId: number;
  kind: string;
  featureName: string;
  scenarioReference: string | null;
  summary: string;
  before: SpecScenario | null;
  after: SpecScenario | null;
}

export interface BehaviorSearchResult extends SpecSearchResult {
  history: ReleaseBehaviorResult[];
}

export type BehaviorSearchScope = "current" | "history" | "fallback" | "all";

export function likePattern(query: string) {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function queryVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = [trimmed];
  if (trimmed.includes("助手")) variants.push(trimmed.replaceAll("助手", "助理"));
  if (/i18n|localization/i.test(trimmed)) variants.push("国际化", "中英文");
  if (trimmed.includes("国际化")) variants.push("i18n", "localization");
  return [...new Set(variants)];
}

/** M3 产品内搜索：LIKE 起步（功能名/摘要、场景四段文本、证据路径），数据量证明需要后再上 FULLTEXT。 */
export async function searchSpec(productId: number, query: string, execute: Execute = defaultExecute): Promise<SpecSearchResult> {
  const variants = queryVariants(query).filter(Boolean);
  if (variants.length === 0) return { features: [], scenarios: [] };
  const featureConditions = variants.map(() => "(f.name LIKE ? OR f.summary LIKE ?)").join(" OR ");
  const featureParams = variants.flatMap((variant) => [likePattern(variant), likePattern(variant)]);
  const [featureRows] = await execute(
    `SELECT f.id, f.name, f.summary FROM features f
     WHERE f.product_id = ? AND f.active = 1 AND (${featureConditions})
     ORDER BY f.name LIMIT 20`,
    [productId, ...featureParams],
  ) as [SpecSearchResult["features"], unknown];
  type ScenarioSource = Omit<SpecSearchResult["scenarios"][number], "evidence"> & { evidence: unknown };
  const scenarioConditions = variants.map(() => "(s.reference LIKE ? OR s.context LIKE ? OR s.action LIKE ? OR s.outcome LIKE ? OR s.evidence LIKE ?)").join(" OR ");
  const scenarioParams = variants.flatMap((variant) => {
    const pattern = likePattern(variant);
    return [pattern, pattern, pattern, pattern, pattern];
  });
  const [scenarioRows] = await execute(
    `SELECT s.id, f.id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.evidence
     FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND f.active = 1 AND s.active = 1
       AND (${scenarioConditions})
     ORDER BY f.name, s.reference LIMIT 30`,
    [productId, ...scenarioParams],
  ) as [ScenarioSource[], unknown];
  // evidence 在 DB 是 JSON 列：在这里一次性解析，调用方（搜索 / 检索式问答 / 未来的 MCP）拿到的都是结构化证据。
  // stableKey 让 MCP 调用方可以拿搜索结果直接寻址 get_feature / get_scenario，不必自行拼归一化约定。
  return {
    features: featureRows.map((feature) => ({ ...feature, stableKey: specFeatureKey(feature.name) })),
    scenarios: scenarioRows.map((row) => ({ ...row, featureStableKey: specFeatureKey(row.featureName), evidence: evidenceItems(row.evidence) })),
  };
}

async function searchReleaseHistory(productId: number, query: string, execute: Execute): Promise<ReleaseBehaviorResult[]> {
  const variants = queryVariants(query).filter(Boolean);
  if (variants.length === 0) return [];
  const conditions = variants.map(() => "(c.feature_name LIKE ? OR c.summary LIKE ? OR c.before_json LIKE ? OR c.after_json LIKE ?)").join(" OR ");
  const params = variants.flatMap((variant) => {
    const pattern = likePattern(variant);
    return [pattern, pattern, pattern, pattern];
  });
  const [rows] = await execute(
    `SELECT r.id AS releaseId, r.sha, r.committed_at AS committedAt,
            c.id AS specChangeId, c.kind, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary,
            c.before_json AS \`before\`, c.after_json AS \`after\`
     FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND c.entity_type = 'scenario' AND (${conditions})
     ORDER BY r.committed_at DESC, c.id DESC LIMIT 30`,
    [productId, ...params],
  ) as [Array<Omit<ReleaseBehaviorResult, "source">>, unknown];
  return rows.map((row) => ({ ...row, source: "release" }));
}

export async function searchBehavior(productId: number, query: string, execute: Execute = defaultExecute, scope: BehaviorSearchScope = "fallback"): Promise<BehaviorSearchResult> {
  if (!query.trim()) return { features: [], scenarios: [], history: [] };
  const current = scope === "history" ? { features: [], scenarios: [] } : await searchSpec(productId, query, execute);
  const includeHistory = scope === "history" || scope === "all" || (scope === "fallback" && current.scenarios.length === 0);
  const history = includeHistory ? await searchReleaseHistory(productId, query, execute) : [];
  return { ...current, history };
}

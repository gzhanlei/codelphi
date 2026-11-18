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

/**
 * 召回变体：完整查询优先，随后按分隔符拆词；只扩召回不改行为身份（与 EC-2 同义变体同向）。
 * - 分词让多词查询（「登录 OAuth 会话」）任一词命中即可召回，不再要求整串连续出现；
 * - CJK 长词补前后 2 字 gram（「反馈裁决」→ 反馈/裁决），弥补无分词器时复合词整串不中；
 * - 上限 12 个变体，完整查询永远保留（单词与旧语义逐字节一致）。
 */
export function queryVariants(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pieces = [trimmed, ...trimmed.split(/[\s,，;；、/|()（）\[\]【】]+/).filter((token) => token.length >= 2)];
  const variants: string[] = [];
  for (const piece of pieces) {
    variants.push(piece);
    if (piece.includes("助手")) variants.push(piece.replaceAll("助手", "助理"));
    if (/i18n|localization/i.test(piece)) variants.push("国际化", "中英文");
    if (piece.includes("国际化")) variants.push("i18n", "localization");
    if (/^\p{Script=Han}+$/u.test(piece) && piece.length >= 3) {
      variants.push(piece.slice(0, 2), piece.slice(-2));
    }
  }
  return [...new Set(variants)].slice(0, 12);
}

/** 命中变体数（相关性粗排）：SQL 只负责召回池，排序在内存里按命中变体数稳定重排。 */
function relevanceScore(texts: Array<string | null | undefined>, variants: string[]): number {
  const haystack = texts.filter(Boolean).join("\n").toLowerCase();
  return variants.reduce((sum, variant) => sum + (haystack.includes(variant.toLowerCase()) ? 1 : 0), 0);
}

function rankByVariants<T>(rows: T[], score: (row: T) => number): T[] {
  return rows
    .map((row, index) => ({ row, index, score: score(row) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ row }) => row);
}

/** M3 产品内搜索：LIKE 起步（功能名/摘要、场景四段文本、证据路径），分词扩召回 + 命中变体数排序；数据量证明需要后再上 FULLTEXT。 */
export async function searchSpec(productId: number, query: string, execute: Execute = defaultExecute): Promise<SpecSearchResult> {
  const variants = queryVariants(query);
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
  const scenarios = scenarioRows.map((row) => ({ ...row, featureStableKey: specFeatureKey(row.featureName), evidence: evidenceItems(row.evidence) }));
  return {
    features: rankByVariants(
      featureRows.map((feature) => ({ ...feature, stableKey: specFeatureKey(feature.name) })),
      (feature) => relevanceScore([feature.name, feature.summary], variants),
    ),
    scenarios: rankByVariants(
      scenarios,
      (scenario) => relevanceScore([scenario.reference, scenario.context, scenario.action, scenario.outcome, ...scenario.evidence.map((item) => String((item as { path?: string }).path ?? ""))], variants),
    ),
  };
}

async function searchReleaseHistory(productId: number, query: string, execute: Execute): Promise<ReleaseBehaviorResult[]> {
  const variants = queryVariants(query);
  if (variants.length === 0) return [];
  const conditions = variants.map(() => "(c.feature_name LIKE ? OR c.summary LIKE ? OR c.before_json LIKE ? OR c.after_json LIKE ?)").join(" OR ");
  const params = variants.flatMap((variant) => {
    const pattern = likePattern(variant);
    return [pattern, pattern, pattern, pattern];
  });
  // 变体兴替去重池：同一 (feature, scenario reference) 的增删改兴替只保留最新一条，超采 2 倍保证去重后仍可能填满 30 条。
  const [rows] = await execute(
    `SELECT r.id AS releaseId, r.sha, r.committed_at AS committedAt,
            c.id AS specChangeId, c.kind, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary,
            c.before_json AS \`before\`, c.after_json AS \`after\`
     FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND c.entity_type = 'scenario' AND (${conditions})
     ORDER BY r.committed_at DESC, c.id DESC LIMIT 60`,
    [productId, ...params],
  ) as [Array<Omit<ReleaseBehaviorResult, "source">>, unknown];
  const seenGroups = new Set<string>();
  const deduped: Array<Omit<ReleaseBehaviorResult, "source">> = [];
  for (const row of rows) {
    const groupKey = row.scenarioReference ? `${row.featureName}#${row.scenarioReference}` : `change#${row.specChangeId}`;
    if (seenGroups.has(groupKey)) continue;
    seenGroups.add(groupKey);
    deduped.push(row);
    if (deduped.length >= 30) break;
  }
  return deduped.map((row) => ({ ...row, source: "release" }));
}

export async function searchBehavior(productId: number, query: string, execute: Execute = defaultExecute, scope: BehaviorSearchScope = "fallback"): Promise<BehaviorSearchResult> {
  if (!query.trim()) return { features: [], scenarios: [], history: [] };
  const current = scope === "history" ? { features: [], scenarios: [] } : await searchSpec(productId, query, execute);
  const includeHistory = scope === "history" || scope === "all" || (scope === "fallback" && current.scenarios.length === 0);
  const history = includeHistory ? await searchReleaseHistory(productId, query, execute) : [];
  return { ...current, history };
}

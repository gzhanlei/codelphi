import { specFeatureKey } from "./spec-diff";
import { defaultExecute, type Execute } from "./db";

/**
 * 功能行为变迁史（user-personas.md CTO 缺口「按功能的时间线视图」）：
 * 按功能的稳定键取跨发布的行为变化（wording_only=0），时间倒序分组——
 * 复盘「这个行为最后一次变化是哪个版本、证据是什么」的数据面。
 */

export interface FeatureHistoryEntry {
  releaseId: number;
  title: string;
  sha: string;
  url: string | null;
  committedAt: Date;
  changes: Array<{ kind: string; scenarioReference: string; summary: string; highlightType: string | null }>;
}

export async function loadFeatureHistory(execute: Execute = defaultExecute, productId: number, featureName: string, limit = 15): Promise<FeatureHistoryEntry[]> {
  const result = await execute(
    `SELECT r.id AS releaseId, r.title, r.sha, r.url, r.committed_at AS committedAt,
            c.kind, c.scenario_reference AS scenarioReference, c.summary, c.highlight_type AS highlightType
     FROM spec_changes c
     JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND c.feature_key = ? AND c.wording_only = 0
     ORDER BY r.committed_at DESC, c.id
     LIMIT ${limit}`,
    [productId, specFeatureKey(featureName)],
  ) as unknown;
  const rows = (Array.isArray(result) ? result[0] : result) as Array<{
    releaseId: number; title: string; sha: string; url: string | null; committedAt: Date;
    kind: string; scenarioReference: string; summary: string; highlightType: string | null;
  }>;
  const byRelease = new Map<number, FeatureHistoryEntry>();
  for (const row of rows) {
    let entry = byRelease.get(Number(row.releaseId));
    if (!entry) {
      entry = { releaseId: Number(row.releaseId), title: row.title, sha: row.sha, url: row.url, committedAt: row.committedAt, changes: [] };
      byRelease.set(Number(row.releaseId), entry);
    }
    entry.changes.push({ kind: row.kind, scenarioReference: row.scenarioReference, summary: row.summary, highlightType: row.highlightType });
  }
  return [...byRelease.values()];
}

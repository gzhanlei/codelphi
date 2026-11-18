import type { BehaviorSearchResult } from "../spec-search";

export interface CanonicalScenarioInput {
  id: number;
  featureName: string;
  reference: string | null;
  specReference: string;
  evidencePaths: string[];
}

/** MCP 搜索输出压缩上限：召回池仍按排序取优，但默认只回摘要与定位锚点。 */
export const SEARCH_FEATURE_LIMIT = 8;
export const SEARCH_SCENARIO_LIMIT = 10;
export const SEARCH_HISTORY_LIMIT = 10;

/**
 * MCP 搜索投影（输出压缩，2026-11-19 价值试点产出）：
 * 分词召回会放大响应体，默认只回 top-K 摘要与定位锚点（featureStableKey + reference + 证据路径），
 * 场景全文经 get_scenario、发布行为 before/after 经 get_release 按需展开——控制 agent 上下文负担。
 * 排序在 spec-search 已完成，这里只裁剪不重排。
 */
export function compactSearchProjection(result: BehaviorSearchResult) {
  const features = result.features.slice(0, SEARCH_FEATURE_LIMIT);
  const scenarios = result.scenarios.slice(0, SEARCH_SCENARIO_LIMIT).map((scenario) => ({
    id: scenario.id,
    featureName: scenario.featureName,
    featureStableKey: scenario.featureStableKey,
    reference: scenario.reference,
    evidence: scenario.evidence.slice(0, 5).map((item) => ({
      path: item.path,
      ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
    })),
  }));
  const history = result.history.slice(0, SEARCH_HISTORY_LIMIT).map((entry) => ({
    source: entry.source,
    releaseId: entry.releaseId,
    sha: entry.sha,
    committedAt: entry.committedAt,
    specChangeId: entry.specChangeId,
    kind: entry.kind,
    featureName: entry.featureName,
    scenarioReference: entry.scenarioReference,
    summary: entry.summary,
  }));
  const truncated = result.features.length > features.length
    || result.scenarios.length > scenarios.length
    || result.history.length > history.length;
  return {
    features,
    scenarios,
    history,
    detailHint: "摘要投影：场景全文与完整证据经 get_scenario(stableKey, reference) 深入；发布行为 before/after 经 get_release(releaseId) 展开",
    ...(truncated ? { truncated: true } : {}),
  };
}


function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function canonicalizeScenarios(rows: CanonicalScenarioInput[]) {
  const groups = new Map<string, CanonicalScenarioInput[]>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const key = JSON.stringify([nameKey(row.featureName), row.reference ?? "", row.specReference, [...row.evidencePaths].sort()]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const identities = new Map<string, Set<string>>();
  for (const [key, group] of groups) {
    const first = group[0];
    const identityKey = JSON.stringify([nameKey(first.featureName), first.reference ?? ""]);
    const groupKeys = identities.get(identityKey) ?? new Set<string>();
    groupKeys.add(key);
    identities.set(identityKey, groupKeys);
  }
  const scenarios = [...groups.entries()].map(([, group]) => {
    const first = group[0];
    const identityKey = JSON.stringify([nameKey(first.featureName), first.reference ?? ""]);
    const unresolved = (identities.get(identityKey)?.size ?? 0) > 1;
    return {
      stableKey: nameKey(first.featureName),
      scenarioIdentity: first.reference,
      displayName: first.featureName,
      aliases: [] as string[],
      rawRecordIds: group.map((row) => row.id),
      specReferences: [...new Set(group.map((row) => row.specReference))].sort(),
      evidencePaths: [...new Set(group.flatMap((row) => row.evidencePaths))].sort(),
      identityStatus: unresolved ? "unresolved" as const : "proven" as const,
      identityScope: unresolved ? "unresolved" as const : first.specReference,
    };
  });
  return {
    rawCount: rows.length,
    canonicalCount: scenarios.length,
    collapsedCount: rows.length - scenarios.length,
    scenarios,
  };
}

export function paginateById<T extends { id: number }>(changes: T[], options: { offset?: number; limit?: number }) {
  const hasLimit = options.limit !== undefined;
  if (!hasLimit && options.offset !== undefined) throw new Error("offset requires limit");
  const limit = options.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100) ) throw new Error("limit must be between 1 and 100");
  const offset = options.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  const sorted = [...changes].sort((a, b) => a.id - b.id);
  return {
    changes: limit === null ? sorted : sorted.slice(offset, offset + limit),
    offset,
    limit,
    total: sorted.length,
    hasMore: limit === null ? false : offset + limit < sorted.length,
  };
}

export function projectFileRisks(input: {
  requestedPaths: string[];
  snapshotSha: string | null;
  rows: Array<{
    stableKey: string;
    source: string;
    changeIds: number[];
    evidencePaths: string[];
  }>;
}) {
  const uniqueRows = new Map<string, (typeof input.rows)[number]>();
  for (const row of input.rows) {
    const key = row.changeIds.slice().sort((a, b) => a - b).join(",");
    const existing = uniqueRows.get(key);
    if (existing) {
      existing.evidencePaths = [...new Set([...existing.evidencePaths, ...row.evidencePaths])].sort();
      if (row.source === "manual") existing.source = "manual";
    } else {
      uniqueRows.set(key, { ...row, evidencePaths: [...row.evidencePaths] });
    }
  }
  const rows = [...uniqueRows.values()];
  const covered = new Set(rows.flatMap((row) => row.evidencePaths));
  const severityRank = { high: 0, medium: 1, low: 2 } as const;
  const risks = rows.map((row) => ({
    severity: row.source === "manual" ? "high" as const : "medium" as const,
    stableKey: row.stableKey,
    changeIds: row.changeIds,
    evidencePaths: row.evidencePaths,
    reasonCode: row.source === "manual" ? "manual_behavior_evidence" : "generated_behavior_evidence",
    reason: row.source === "manual" ? "人工维护的行为证据，修改前必须优先复核" : "生成的行为证据，修改前需要复核",
    coverageType: row.changeIds.length > 0 ? "scenario" as const : "file_path" as const,
  })).sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
    || a.stableKey.localeCompare(b.stableKey)
    || a.changeIds[0] - b.changeIds[0]
    || a.evidencePaths.join(",").localeCompare(b.evidencePaths.join(",")));
  const limited = risks.slice(0, 10).map((risk, index) => ({ ...risk, rank: index + 1 }));
  return {
    snapshotSha: input.snapshotSha,
    rawScenarioCount: rows.length,
    canonicalScenarioCount: canonicalizeScenarios(rows.map((row) => ({
      id: row.changeIds[0],
      featureName: row.stableKey,
      reference: "",
      specReference: input.snapshotSha ?? "unknown",
      evidencePaths: row.evidencePaths,
    }))).canonicalCount,
    coveredPaths: input.requestedPaths.filter((path) => covered.has(path)),
    uncoveredPaths: input.requestedPaths.filter((path) => !covered.has(path)),
    risks: limited,
    returnedCount: limited.length,
    totalCount: risks.length,
    hasMore: risks.length > limited.length,
  };
}

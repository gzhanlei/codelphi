export interface CanonicalScenarioInput {
  id: number;
  featureName: string;
  reference: string | null;
  specReference: string;
  evidencePaths: string[];
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

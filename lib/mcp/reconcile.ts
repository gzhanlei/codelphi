export interface ReconcileChange {
  id: number;
  featureName: string;
  featureKey?: string;
  entityType: string;
  scenarioReference: string | null;
  before: unknown;
  after: unknown;
}

export interface ExpectedIntent {
  stableKey?: string;
  paths?: string[];
  note?: string;
}

export interface ReconcileReleaseInput {
  releaseId: number;
  slug: string;
  sha: string | null;
  changes: ReconcileChange[];
  releaseFilePaths: string[];
  analysis: {
    status: "complete" | "partial" | "failed" | "unknown";
    runId: number | null;
    error: string | null;
  };
  expectedIntents?: ExpectedIntent[];
  legacySourceIssueCount?: number;
}

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function featureKeyOf(change: ReconcileChange): string {
  return change.featureKey ?? nameKey(change.featureName);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function evidencePathsFromSubject(subject: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const record = subject as { evidence?: unknown; scenarios?: unknown };
  const direct = Array.isArray(record.evidence)
    ? record.evidence.map((item) => normalizePath(String((item as { path?: string }).path ?? "")).trim()).filter(Boolean)
    : [];
  const nested = Array.isArray(record.scenarios) ? record.scenarios.flatMap(evidencePathsFromSubject) : [];
  return [...new Set([...direct, ...nested])];
}

interface DuplicateCluster {
  clusterKey: string;
  kind: "duplicate_scenario_identity" | "duplicate_projection";
  stableKey: string | null;
  scenarioIdentity: string | null;
  sourceIds: number[];
  changeIds: number[];
  evidencePaths: string[];
  reasonCode: string;
  reason: string;
}

export function reconcileRelease(input: ReconcileReleaseInput) {
  const changes = [...input.changes].sort((a, b) => a.id - b.id);
  const coveredPaths = new Set([...input.releaseFilePaths.map(normalizePath), ...changes.flatMap((change) => [...evidencePathsFromSubject(change.before), ...evidencePathsFromSubject(change.after)])]);
  const matchedIds = new Set<number>();
  const intentResults = (input.expectedIntents ?? []).map((intent, intentIndex) => {
    const stableKey = intent.stableKey ? nameKey(intent.stableKey) : null;
    const paths = [...new Set((intent.paths ?? []).map(normalizePath).filter(Boolean))];
    const identityMatches = stableKey === null ? null : changes.some((change) => featureKeyOf(change) === stableKey);
    const unmatchedPaths = paths.filter((path) => !coveredPaths.has(path));
    const identityCandidates = stableKey === null ? changes : changes.filter((change) => featureKeyOf(change) === stableKey);
    const releasePaths = input.releaseFilePaths.map(normalizePath);
    const matchedChangeIds = identityCandidates.filter((change) => paths.every((path) => stableKey !== null
      ? evidencePathsFromSubject(change.before).includes(path) || evidencePathsFromSubject(change.after).includes(path)
      : releasePaths.includes(path))).map((change) => change.id);
    const pathMatches = intent.paths === undefined ? null
      : paths.length === 0 ? true
      : stableKey !== null ? matchedChangeIds.length > 0 && matchedChangeIds.length === identityCandidates.length
      : unmatchedPaths.length === 0;
    for (const id of matchedChangeIds) matchedIds.add(id);
    const reasonCodes = stableKey ? ["exact_name"] : [];
    const status = stableKey && !identityMatches ? "missing"
      : identityMatches && pathMatches === false ? "partial"
      : pathMatches === false ? "missing"
      : stableKey === null && pathMatches ? "unverified"
      : "matched";
    return {
      intentIndex,
      stableKey,
      identityMatched: identityMatches,
      pathMatched: pathMatches,
      matchedChangeIds,
      unmatchedPaths,
      status,
      reasonCodes,
    };
  });
  const missingExpected = intentResults.filter((result) => result.status === "missing").map((result) => ({
    intentIndex: result.intentIndex,
    stableKey: result.stableKey,
    reasonCodes: [result.stableKey ? "identity_not_found" : "paths_not_covered"],
  }));
  const unexpected = !input.expectedIntents ? [] : changes.filter((change) => !matchedIds.has(change.id)).map((change) => ({
    changeId: change.id,
    stableKey: featureKeyOf(change),
    evidencePaths: [...new Set([...evidencePathsFromSubject(change.before), ...evidencePathsFromSubject(change.after)])],
    beforePaths: evidencePathsFromSubject(change.before),
    afterPaths: evidencePathsFromSubject(change.after),
    releaseFilePaths: input.releaseFilePaths.map(normalizePath),
    reasonCode: "not_covered_by_intents",
  }));

  const projectionGroups = new Map<number, ReconcileChange[]>();
  const scenarioGroups = new Map<string, ReconcileChange[]>();
  for (const change of changes) {
    const projection = projectionGroups.get(change.id) ?? [];
    projection.push(change);
    projectionGroups.set(change.id, projection);
    if (change.entityType === "scenario" && change.scenarioReference) {
      const key = JSON.stringify([featureKeyOf(change), change.scenarioReference]);
      const group = scenarioGroups.get(key) ?? [];
      group.push(change);
      scenarioGroups.set(key, group);
    }
  }
  const duplicateClusters: DuplicateCluster[] = [];
  for (const [id, group] of projectionGroups) {
    if (group.length < 2) continue;
    duplicateClusters.push({
      clusterKey: `projection:${id}`,
      kind: "duplicate_projection",
      stableKey: nameKey(group[0].featureName),
      scenarioIdentity: group[0].scenarioReference,
      sourceIds: group.map((change) => change.id),
      changeIds: group.map((change) => change.id),
      evidencePaths: [...new Set(group.flatMap((change) => evidencePathsFromSubject(change.after)))],
      reasonCode: "duplicate_change_id",
      reason: "同一 spec_change_id 出现多条投影记录",
    });
  }
  for (const [key, group] of scenarioGroups) {
    if (group.length < 2 || new Set(group.map((change) => change.id)).size === 1) continue;
    const [stableKey, scenarioIdentity] = JSON.parse(key) as [string, string];
    duplicateClusters.push({
      clusterKey: `scenario:${key}`,
      kind: "duplicate_scenario_identity",
      stableKey,
      scenarioIdentity,
      sourceIds: group.map((change) => change.id),
      changeIds: group.map((change) => change.id),
      evidencePaths: [...new Set(group.flatMap((change) => evidencePathsFromSubject(change.after)))],
      reasonCode: "duplicate_scenario_in_version",
      reason: "同一规格版本内相同功能与场景引用出现多条记录",
    });
  }

  const evidenceGroups = new Map<string, { stableKeys: Set<string>; changeIds: number[] }>();
  for (const change of changes) {
    for (const path of new Set([...evidencePathsFromSubject(change.before), ...evidencePathsFromSubject(change.after)])) {
      const group = evidenceGroups.get(path) ?? { stableKeys: new Set<string>(), changeIds: [] };
      group.stableKeys.add(featureKeyOf(change));
      group.changeIds.push(change.id);
      evidenceGroups.set(path, group);
    }
  }
  const sharedEvidenceWarnings = [...evidenceGroups.entries()]
    .filter(([, group]) => group.stableKeys.size > 1)
    .map(([evidencePath, group]) => ({
      evidencePath,
      stableKeys: [...group.stableKeys].sort(),
      changeIds: group.changeIds,
      reasonCode: "shared_evidence_is_not_duplicate_proof",
    }));

  const hasPartial = intentResults.some((result) => result.status === "partial" || result.status === "unverified");
  const reasons: string[] = [];
  if (missingExpected.length > 0) reasons.push("expected_intents_missing");
  if (unexpected.length > 0) reasons.push("unexpected_changes_present");
  if (input.analysis.status !== "complete") reasons.push("analysis_incomplete");
  if (!input.expectedIntents) reasons.push("no_expected_intents");
  if (hasPartial) reasons.push("intent_match_unverified");
  if (duplicateClusters.length > 0) reasons.push("duplicate_records_present");
  if ((input.legacySourceIssueCount ?? 0) > 0) reasons.push("legacy_source_links_present");
  if (sharedEvidenceWarnings.length > 0) reasons.push("shared_evidence_requires_review");

  let verdict: "pass" | "warning" | "failed" | "review";
  if (missingExpected.length > 0 || unexpected.length > 0) verdict = "failed";
  else if (input.analysis.status !== "complete" || !input.expectedIntents || hasPartial) verdict = "review";
  else if (duplicateClusters.length > 0 || (input.legacySourceIssueCount ?? 0) > 0 || sharedEvidenceWarnings.length > 0) verdict = "warning";
  else verdict = "pass";
  return {
    releaseId: input.releaseId,
    slug: input.slug,
    sha: input.sha,
    analysis: input.analysis,
    evidenceComplete: input.analysis.status === "complete",
    intentResults,
    missingExpected,
    unexpected,
    duplicateClusters,
    sharedEvidenceWarnings,
    verdict,
    reasons,
  };
}

export type ReconcileReleaseResult = ReturnType<typeof reconcileRelease>;

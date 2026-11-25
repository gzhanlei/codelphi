import { searchBehavior, type BehaviorSearchScope } from "../spec-search";
import { lookupFilesImpact } from "../feature-connections";
import { loadCoverageReceipt } from "../analysis-coverage";
import { defaultExecute, type Execute } from "../db";
import { compactSearchProjection, projectFileRisks } from "../mcp/projections";
import { loadLedgerFreshnessForServer } from "../mcp/freshness";
import { queryRows, resolveEvidenceSource, resolveOrgProduct, type LedgerProduct } from "../mcp/ledger-queries";

export interface BehaviorQueryInput {
  slug: string;
  question: string;
  paths?: string[];
  scope?: BehaviorSearchScope;
}

interface BehaviorRuntime {
  execute?: Execute;
  identity: { organizationId: number };
  search?: typeof searchBehavior;
  lookupImpact?: typeof lookupFilesImpact;
  coverage?: typeof loadCoverageReceipt;
  freshness?: typeof loadLedgerFreshnessForServer;
}

export interface BehaviorAnswer {
  schemaVersion: "codelphi.behavior.v1";
  status: "success" | "partial" | "empty";
  question: string;
  directAnswer: string;
  facts: Array<Record<string, unknown>>;
  observedOutcomes: Array<{ stableKey: string; reference: string; text: string }>;
  impacts: Array<Record<string, unknown>>;
  unknowns: Array<Record<string, unknown>>;
  productDecisions: never[];
  decisionPolicy: "not_inferred";
  coverage: Record<string, unknown>;
  suggestedQueries: string[];
}

export async function queryBehavior(runtime: BehaviorRuntime, input: BehaviorQueryInput, preloaded?: { product: LedgerProduct; source: Awaited<ReturnType<typeof resolveEvidenceSource>> }): Promise<BehaviorAnswer | Record<string, never>> {
  const execute = runtime.execute ?? defaultExecute;
  const question = input.question.trim();
  if (!question) throw new Error("question must be a non-empty string");
  if (question.length > 4000) throw new Error("question must contain at most 4000 characters");
  const scope = input.scope ?? "fallback";
  if (!["current", "history", "fallback", "all"].includes(scope)) throw new Error("invalid scope");
  const paths = (input.paths ?? []).map((path) => path.trim()).filter(Boolean);
  if (paths.length > 20) throw new Error("paths must contain at most 20 file paths");
  if (paths.some((path) => path.startsWith("/") || path.split("/").includes(".."))) throw new Error("paths must be relative repository paths");

  const product = preloaded?.product ?? await resolveOrgProduct(execute, runtime.identity.organizationId, input.slug);
  if (!product) return {};
  const source = preloaded?.source ?? await resolveEvidenceSource(execute, product.id);
  const search = await (runtime.search ?? searchBehavior)(product.id, question, execute, scope);
  const freshness = await loadFreshness(runtime, product.id);
  const projection = compactSearchProjection(search, { freshness: freshness.block, staleEvidencePaths: freshness.changedBehavioralPaths });
  const latestRelease = await loadLatestRelease(execute, product.id);
  const evidenceCoverage = latestRelease?.specVersionId
    ? await (runtime.coverage ?? loadCoverageReceipt)(execute as unknown as (sql: string, params?: unknown[]) => Promise<unknown>, latestRelease.specVersionId)
    : null;
  const impact = paths.length > 0 ? await loadImpact(runtime, execute, product.id, paths, source?.repo.sha ?? null, freshness.block) : null;

  const facts: Array<Record<string, unknown>> = search.scenarios.map((scenario) => ({
    kind: "scenario",
    stableKey: scenario.featureStableKey,
    reference: scenario.reference,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
    evidence: scenario.evidence.map((item) => ({
      path: item.path,
      startLine: item.startLine ?? null,
      endLine: item.endLine ?? null,
      snapshotSha: source?.repo.sha ?? null,
      status: freshness.changedBehavioralPaths?.has(item.path) ? "stale" : "current",
      url: source && item.path ? source.blobUrl(item.path, item.startLine) : null,
    })),
  }));
  facts.push(...search.history.map((entry) => ({
    kind: "release_change",
    source: entry.source,
    releaseId: entry.releaseId,
    sha: entry.sha,
    committedAt: entry.committedAt,
    specChangeId: entry.specChangeId,
    changeKind: entry.kind,
    featureName: entry.featureName,
    scenarioReference: entry.scenarioReference,
    summary: entry.summary,
  })));

  const unknowns: Array<Record<string, unknown>> = [];
  if (search.scenarios.length === 0 && search.history.length === 0) unknowns.push({ code: "no_matching_behavior" });
  const coveredPaths = impact?.coveredPaths ?? [];
  const uncoveredPaths = impact?.uncoveredPaths ?? [];
  if (uncoveredPaths.length > 0) unknowns.push({ code: "uncovered_paths", paths: uncoveredPaths });
  if (freshness.block.available !== true) unknowns.push({ code: "freshness_unavailable" });
  if ((freshness.changedBehavioralPaths?.size ?? 0) > 0) unknowns.push({ code: "stale_snapshot" });
  if (projection.truncated) unknowns.push({ code: "detail_truncated" });

  const evidenceBackedScenarioCount = search.scenarios.filter((scenario) => scenario.evidence.length > 0).length;
  const status = facts.length === 0 && (impact?.risks.length ?? 0) === 0
    ? "empty"
    : unknowns.length > 0 ? "partial" : "success";
  const directAnswer = status === "empty"
    ? "未召回到相关行为知识；这不表示该行为不存在。"
    : `找到 ${search.scenarios.length} 个当前场景、${search.history.length} 条历史变化和 ${impact?.risks.length ?? 0} 项文件影响；请结合证据与 unknown 判断。`;

  const suggestedQueries = [
    ...search.scenarios.slice(0, 3).map((scenario) => `get_scenario(stableKey=${scenario.featureStableKey}, reference=${scenario.reference})`),
    ...search.history.slice(0, 3).map((entry) => `get_release(releaseId=${entry.releaseId})`),
    ...uncoveredPaths.map((path) => `直接阅读未覆盖源码 ${path}`),
  ];

  return {
    schemaVersion: "codelphi.behavior.v1",
    status,
    question,
    directAnswer,
    facts,
    observedOutcomes: search.scenarios.map((scenario) => ({ stableKey: scenario.featureStableKey, reference: scenario.reference, text: scenario.outcome })),
    impacts: impact?.risks ?? [],
    unknowns,
    productDecisions: [],
    decisionPolicy: "not_inferred",
    coverage: {
      snapshotSha: source?.repo.sha ?? null,
      requestedPathCount: paths.length,
      matchedPathCount: coveredPaths.length,
      uncoveredPathCount: uncoveredPaths.length,
      uncoveredPaths,
      matchedScenarioCount: search.scenarios.length,
      historyChangeCount: search.history.length,
      evidenceBackedScenarioCount,
      evidenceCoverage,
      freshness: freshness.block,
      searchTruncated: projection.truncated === true,
    },
    suggestedQueries,
  };
}

async function loadLatestRelease(execute: Execute, productId: number) {
  const rows = await queryRows<{ id: number; title: string; sha: string; committedAt: Date; specVersionId: number | null }>(
    execute("SELECT id, title, sha, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? AND is_current = 1 ORDER BY analysis_run_id DESC, id DESC LIMIT 1", [productId]),
  );
  return rows[0] ?? null;
}

async function loadFreshness(runtime: BehaviorRuntime, productId: number) {
  try {
    const data = await (runtime.freshness ?? loadLedgerFreshnessForServer)(productId);
    return { block: data.block as unknown as Record<string, unknown>, changedBehavioralPaths: data.changedBehavioralPaths };
  } catch (error) {
    return { block: { available: false, reason: error instanceof Error ? error.message.slice(0, 160) : "unknown_error" }, changedBehavioralPaths: undefined };
  }
}

async function loadImpact(runtime: BehaviorRuntime, execute: Execute, productId: number, paths: string[], snapshotSha: string | null, freshness: Record<string, unknown>) {
  const files = await (runtime.lookupImpact ?? lookupFilesImpact)(execute, productId, paths, { scenarioCap: Number.MAX_SAFE_INTEGER });
  return projectFileRisks({
    requestedPaths: paths,
    snapshotSha,
    rows: files.flatMap((entry) => entry.features.flatMap((feature) => feature.scenarios.map((scenario) => ({
      stableKey: feature.stableKey,
      source: scenario.source,
      changeIds: [scenario.id],
      evidencePaths: Array.isArray(scenario.evidence) ? scenario.evidence.map((item) => String((item as { path?: string }).path ?? "")).filter(Boolean) : [],
    })))),
  });
}

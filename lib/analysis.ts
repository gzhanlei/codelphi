import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { analyzeWithAI, type AnalysisResult } from "./ai";
import { resolveAnalysisTarget, type ChangeContext, type CodeHostingProvider } from "./code-hosting";
import { analysisSliceBudgets, getRemoteAnalysisSources, parseSourceRoots } from "./remote-analysis";
import { createSlicePlanner } from "./slice-planner";
import { insertSpecVersion, loadPreviousFeatureNames } from "./spec-versions";
import { loadAffectedFeatureKeys, rebuildSpecFileIndex } from "./spec-file-index";
import { resolveAnalysisMode } from "./incremental";
import { markSpecDrift } from "./spec-drift";

export interface RunContext {
  id: number;
  repositoryId: number;
  productId: number;
  owner: string;
  name: string;
  beforeSha: string | null;
  afterSha: string;
  connectionId: number | null;
  provider: CodeHostingProvider;
  organizationId: number;
  productSlug: string;
  productName: string;
  analyzeMode?: "full" | "incremental";
}

export function assertEvidence(result: AnalysisResult, sources: Set<string>) {
  const invalid: string[] = [];
  const check = (path: string) => {
    if (!sources.has(path)) invalid.push(path);
  };
  for (const item of result.product.evidence) check(item.path);
  for (const feature of result.features) {
    for (const scenario of feature.scenarios) scenario.evidence.forEach((item) => check(item.path));
  }
  for (const change of result.changes) change.evidence.forEach((item) => check(item.path));
  if (invalid.length > 0) throw new Error(`AI returned unknown evidence paths: ${[...new Set(invalid)].join(", ")}`);
}

export async function assertLatestRun(connection: PoolConnection, run: RunContext) {
  const [rows] = await connection.execute("SELECT id FROM analysis_runs WHERE repository_id = ? ORDER BY id DESC LIMIT 1", [run.repositoryId]);
  const latestRun = (rows as Array<{ id: number }>)[0];
  const latestRunId = latestRun ? Number(latestRun.id) : 0;
  if (latestRunId !== run.id) throw new Error(`Analysis superseded by run ${latestRunId}`);
}

async function upsertFeature(connection: PoolConnection, run: RunContext, feature: AnalysisResult["features"][number]) {
  const [featureResult] = await connection.execute(
    `INSERT INTO features (product_id, name, summary, source, active)
     VALUES (?, ?, ?, 'generated', 1)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       summary = IF(source = 'generated', VALUES(summary), summary),
       active = IF(source = 'generated', 1, active)`,
    [run.productId, feature.name, feature.summary],
  );
  const featureId = Number((featureResult as { insertId: number }).insertId);
  for (const scenario of feature.scenarios) {
    await connection.execute(
      `INSERT INTO scenarios
         (feature_id, reference, context, action, outcome, category, source, active, evidence)
       VALUES (?, ?, ?, ?, ?, ?, 'generated', 1, ?)
       ON DUPLICATE KEY UPDATE
         context = IF(source = 'generated', VALUES(context), context),
         action = IF(source = 'generated', VALUES(action), action),
         outcome = IF(source = 'generated', VALUES(outcome), outcome),
         category = IF(source = 'generated', VALUES(category), category),
         evidence = IF(source = 'generated', VALUES(evidence), evidence),
         active = IF(source = 'generated', 1, active)`,
      [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, JSON.stringify(scenario.evidence)],
    );
  }
}

export async function upsertGeneratedSpec(connection: PoolConnection, run: RunContext, result: AnalysisResult) {
  await connection.execute(
    `UPDATE features f
     LEFT JOIN features child ON child.parent_id = f.id AND child.active = 1
     SET f.active = 0
     WHERE f.product_id = ? AND f.source = 'generated'
       AND NOT EXISTS (SELECT 1 FROM scenarios WHERE feature_id = f.id AND source = 'manual' AND active = 1)
       AND child.id IS NULL`,
    [run.productId],
  );
  await connection.execute(
    `UPDATE scenarios s JOIN features f ON f.id = s.feature_id
     SET s.active = 0 WHERE f.product_id = ? AND s.source = 'generated'`,
    [run.productId],
  );
  for (const feature of result.features) await upsertFeature(connection, run, feature);
}

export async function upsertRelease(connection: PoolConnection, run: RunContext, result: AnalysisResult, change: ChangeContext, specVersionId: number | null = null) {
  await connection.execute(
    `INSERT INTO releases
       (product_id, repository_id, analysis_run_id, spec_version_id, sha, title, summary, url, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE analysis_run_id = VALUES(analysis_run_id), spec_version_id = VALUES(spec_version_id)`,
    [run.productId, run.repositoryId, run.id, specVersionId, run.afterSha, result.release.title, result.release.summary, change.url, new Date(change.committedAt)],
  );
  const [existing] = await connection.execute("SELECT id FROM releases WHERE repository_id = ? AND sha = ?", [run.repositoryId, run.afterSha]);
  const releaseId = Number((existing as Array<{ id: number }>)[0].id);
  const [changeRows] = await connection.execute("SELECT COUNT(*) AS count FROM changes WHERE release_id = ?", [releaseId]);
  const hasChanges = Number((changeRows as Array<{ count: number }>)[0].count) > 0;
  if (hasChanges) return;

  for (const item of result.changes) {
    await connection.execute(
      `INSERT INTO changes (release_id, feature_name, kind, description, user_impact, evidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [releaseId, item.featureName, item.kind, item.description, item.userImpact, JSON.stringify(item.evidence)],
    );
  }
}

async function saveResult(run: RunContext, result: AnalysisResult, change: ChangeContext, affectedKeys: ReadonlySet<string> | null = null) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    await assertLatestRun(connection, run);
    await connection.execute(
      "UPDATE products SET description = ?, description_source = 'generated', description_evidence = ? WHERE id = ? AND description = ''",
      [result.product.description, JSON.stringify(result.product.evidence), run.productId],
    );
    const specVersionId = await insertSpecVersion(connection, run, result, affectedKeys ? { affectedKeys } : {});
    await rebuildSpecFileIndex(connection, run.repositoryId, specVersionId);
    await markSpecDrift(connection, run.productId, specVersionId);
    await upsertGeneratedSpec(connection, run, result);
    await upsertRelease(connection, run, result, change, specVersionId);
    await connection.execute("UPDATE analysis_runs SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [run.id]);
    await connection.commit();
    return specVersionId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function queueAnalysis(repositoryId: number, beforeSha: string | null, afterSha: string, trigger: "manual" | "push") {
  const db = getDb();
  const [existing] = await db.execute(
    "SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ? AND status IN ('queued', 'running') LIMIT 1",
    [repositoryId, afterSha],
  );
  const current = (existing as Array<{ id: number }>)[0];
  if (current) return current.id;

  const [result] = await db.execute(
    "INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, ?, ?, ?, 'queued')",
    [repositoryId, trigger, beforeSha, afterSha],
  );
  return Number((result as { insertId: number }).insertId);
}

async function loadRun(runId: number) {
  const [rows] = await getDb().execute(
    `SELECT r.id, r.repository_id AS repositoryId, p.id AS productId, p.slug AS productSlug, p.name AS productName,
            repo.owner, repo.name, r.before_sha AS beforeSha, r.after_sha AS afterSha, repo.connection_id AS connectionId,
            repo.provider, p.organization_id AS organizationId, p.analyze_mode AS analyzeMode
     FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id
     JOIN products p ON p.id = repo.product_id
     WHERE r.id = ? AND r.status IN ('queued', 'failed')`,
    [runId],
  );
  return (rows as RunContext[])[0];
}

async function loadSourceRoots(productId: number) {
  const [rows] = await getDb().execute("SELECT source_roots AS sourceRoots FROM products WHERE id = ?", [productId]);
  const product = (rows as Array<{ sourceRoots: unknown }>)[0];
  return parseSourceRoots(product?.sourceRoots);
}

async function performAnalysis(run: RunContext) {
  await getDb().execute("UPDATE analysis_runs SET status = 'running', started_at = CURRENT_TIMESTAMP(3), error_message = NULL WHERE id = ?", [run.id]);
  const target = resolveAnalysisTarget(run);
  const repo = await target.adapter.getRepository({ owner: run.owner, name: run.name, defaultBranch: "main" }, target.access);
  const [change, sourceRoots] = await Promise.all([
    target.adapter.getChangeContext(repo, run.beforeSha, run.afterSha, target.access),
    loadSourceRoots(run.productId),
  ]);
  const planner = createSlicePlanner({ now: Date.now });
  const scopeRoots = sourceRoots.length > 0 ? sourceRoots : [{ path: "", role: "shared" as const }];
  const remote = await getRemoteAnalysisSources({
    product: target.product,
    repository: { owner: repo.owner, repo: repo.name, revision: run.afterSha },
    access: target.access,
    provider: target.adapter.provider,
    scopeRoots,
  }, { planner, budgets: analysisSliceBudgets });
  const sources = remote.sources;
  const executeWrapper = (statement: string, parameters: Array<string | number | null>) => getDb().execute(statement, parameters);
  const previousFeatureNames = await loadPreviousFeatureNames(run.repositoryId, executeWrapper);
  // M9：增量模式下计算受影响集并做保守放行判定；任一条件不满足即回退全量。
  let affectedKeys: ReadonlySet<string> | null = null;
  let affectedFeatureNames: string[] | undefined;
  if (run.analyzeMode === "incremental") {
    const affected = await loadAffectedFeatureKeys(run.repositoryId, change.files.map((file) => file.path), executeWrapper);
    const resolved = resolveAnalysisMode({
      mode: "incremental",
      hasPreviousSpec: previousFeatureNames.length > 0,
      affectedCount: affected.names.length,
      previousFeatureCount: previousFeatureNames.length,
      diffFileCount: change.files.length,
    });
    if (resolved === "incremental") {
      affectedKeys = affected.keys;
      affectedFeatureNames = affected.names;
    }
  }
  const result = await analyzeWithAI(sources, change, { previousFeatureNames, affectedFeatureNames });
  assertEvidence(result, new Set([
    ...remote.slice.files.map((file) => file.path),
    ...change.files.map((file) => file.path),
  ]));
  await saveResult(run, result, change, affectedKeys);
}

async function runAnalysisSafely(runId: number) {
  const run = await loadRun(runId);
  if (!run) return;
  await performAnalysis(run);
}

export async function runAnalysis(runId: number) {
  await runAnalysisSafely(runId).catch(async (error: unknown) => {
    // message 之外附上堆栈头部：生产排障时 error_message 是唯一现场。
    const message = error instanceof Error
      ? [error.message, ...(error.stack?.split("\n").slice(1, 6) ?? [])].join("\n").slice(0, 8_000)
      : "Unknown analysis error";
    await getDb().execute(
      "UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [message, runId],
    );
  });
}

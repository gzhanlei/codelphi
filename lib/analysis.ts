import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { analyzeWithAI, type AnalysisResult } from "./ai";
import { getChangeContext, getRepository, getSourceSnapshot, type GitHubRepository } from "./github";
import { insertSpecVersion } from "./spec-versions";

export interface RunContext {
  id: number;
  repositoryId: number;
  productId: number;
  owner: string;
  name: string;
  beforeSha: string | null;
  afterSha: string;
  connectionId: number | null;
}

type ChangeContext = Awaited<ReturnType<typeof getChangeContext>>;

export function assertEvidence(result: AnalysisResult, sources: Set<string>) {
  const invalid: string[] = [];
  const check = (path: string) => {
    if (!sources.has(path)) invalid.push(path);
  };
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
     ON DUPLICATE KEY UPDATE analysis_run_id = VALUES(analysis_run_id)`,
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

async function saveResult(run: RunContext, result: AnalysisResult, change: ChangeContext) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    await assertLatestRun(connection, run);
    const specVersionId = await insertSpecVersion(connection, run, result);
    await upsertGeneratedSpec(connection, run, result);
    await upsertRelease(connection, run, result, change, specVersionId);
    await connection.execute("UPDATE analysis_runs SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [run.id]);
    await connection.commit();
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
    `SELECT r.id, r.repository_id AS repositoryId, p.id AS productId,
            repo.owner, repo.name, r.before_sha AS beforeSha, r.after_sha AS afterSha, repo.connection_id AS connectionId
     FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id
     JOIN products p ON p.id = repo.product_id
     WHERE r.id = ? AND r.status IN ('queued', 'failed')`,
    [runId],
  );
  return (rows as RunContext[])[0];
}

async function performAnalysis(run: RunContext) {
  await getDb().execute("UPDATE analysis_runs SET status = 'running', started_at = CURRENT_TIMESTAMP(3), error_message = NULL WHERE id = ?", [run.id]);
  const repo: GitHubRepository = await getRepository({ owner: run.owner, name: run.name, defaultBranch: "main" }, { connectionId: run.connectionId });
  const access = { connectionId: run.connectionId };
  const [change, sources] = await Promise.all([
    getChangeContext(repo, run.beforeSha, run.afterSha, access),
    getSourceSnapshot(repo, run.afterSha, access),
  ]);
  if (sources.length === 0) throw new Error("No supported source files found");
  const result = await analyzeWithAI(sources, change);
  assertEvidence(result, new Set([...sources.map((file) => file.path), ...change.files.map((file) => file.path)]));
  await saveResult(run, result, change);
}

async function runAnalysisSafely(runId: number) {
  const run = await loadRun(runId);
  if (!run) return;
  await performAnalysis(run);
}

export async function runAnalysis(runId: number) {
  await runAnalysisSafely(runId).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message.slice(0, 8_000) : "Unknown analysis error";
    await getDb().execute(
      "UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [message, runId],
    );
  });
}

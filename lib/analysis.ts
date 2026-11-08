import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { analyzeWithAI, type AnalysisResult } from "./ai";
import { capture, enqueueRunWithReservation, hasActiveReservation, heartbeat, release, reserveForNewRun } from "./billing/core";
import { FIRST_RUN_UNITS, HEARTBEAT_INTERVAL_MS } from "./billing/constants";
import { resolveAnalysisTarget, type ChangeContext, type CodeHostingProvider } from "./code-hosting";
import { analysisSliceBudgets, getRemoteAnalysisSources, parseSourceRoots } from "./remote-analysis";
import { createSlicePlanner } from "./slice-planner";
import { insertSpecVersion, loadPreviousFeatureNames, loadPreviousSpecText } from "./spec-versions";
import { loadAffectedFeatureKeys, rebuildSpecFileIndex } from "./spec-file-index";
import { resolveAnalysisMode } from "./incremental";
import { compareIncrementalShadow } from "./incremental-shadow";
import { incrementalShadowEnabled } from "./env";
import type { SpecFeature } from "./spec-diff";
import type { SpecAnchorFeature } from "./spec-versions";
import { markSpecDrift } from "./spec-drift";
import { deliverAnalysisNotifications } from "./notifications";
import { ensureRegressionTasks } from "./regression-tasks";
import { behavioralChangePaths } from "./patch-scan";

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
  /** 计费账户（= organization_id），run 创建时固化；结算禁止执行期读 cookie（契约 §4.8/B13）。 */
  accountId?: number | null;
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
       verified_at = IF(source = 'generated' AND summary <> VALUES(summary), NULL, verified_at),
       verified_by = IF(source = 'generated' AND summary <> VALUES(summary), NULL, verified_by),
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
         verified_at = IF(source = 'generated' AND (context <> VALUES(context) OR action <> VALUES(action) OR outcome <> VALUES(outcome) OR category <> VALUES(category)), NULL, verified_at),
         verified_by = IF(source = 'generated' AND (context <> VALUES(context) OR action <> VALUES(action) OR outcome <> VALUES(outcome) OR category <> VALUES(category)), NULL, verified_by),
         active = IF(source = 'generated', 1, active)`,
      [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, JSON.stringify(scenario.evidence)],
    );
  }
}

export async function upsertGeneratedSpec(connection: PoolConnection, run: RunContext, features: SpecFeature[]) {
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
  for (const feature of features) await upsertFeature(connection, run, feature);
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
  // P0：发布改动文件清单落库，供回归任务的影响面映射（文件 → 证据路径 → 场景）离线复算。
  // 行为性标志（patch-scan）：注释/空白变动的文件不构成行为变更，渲染期折叠重算与
  // tests-only 门禁共用该标志。
  const behavioralPaths = behavioralChangePaths(change.files);
  if (change.files.length > 0) {
    await connection.execute("DELETE FROM release_files WHERE release_id = ?", [releaseId]);
    for (const file of change.files) {
      await connection.execute(
        "INSERT IGNORE INTO release_files (release_id, path, behavioral_change) VALUES (?, ?, ?)",
        [releaseId, file.path, behavioralPaths.has(file.path) ? 1 : 0],
      );
    }
  }
  const [changeRows] = await connection.execute("SELECT COUNT(*) AS count FROM changes WHERE release_id = ?", [releaseId]);
  const hasChanges = Number((changeRows as Array<{ count: number }>)[0]?.count ?? 0) > 0;
  if (hasChanges) {
    await ensureRegressionTasks(connection, releaseId);
    return;
  }

  for (const item of result.changes) {
    await connection.execute(
      `INSERT INTO changes (release_id, feature_name, kind, description, user_impact, evidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [releaseId, item.featureName, item.kind, item.description, item.userImpact, JSON.stringify(item.evidence)],
    );
  }
  await ensureRegressionTasks(connection, releaseId);
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
    const behavioralPaths = behavioralChangePaths(change.files);
    const { specVersionId, features: mergedFeatures } = await insertSpecVersion(connection, run, result, { ...(affectedKeys ? { affectedKeys } : {}), behavioralChangePaths: behavioralPaths });
    await rebuildSpecFileIndex(connection, run.repositoryId, specVersionId);
    await markSpecDrift(connection, run.productId, specVersionId);
    // P0(I1):下线基准必须是 carry-forward 合并后的完整规格——用 AI 原始输出会让
    // 增量模式把未受影响的 generated 功能全部下线,工作台坍缩为本次触及的功能。
    await upsertGeneratedSpec(connection, run, mergedFeatures);
    await upsertRelease(connection, run, result, change, specVersionId);
    await connection.execute("UPDATE analysis_runs SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [run.id]);
    await connection.commit();
    return { specVersionId, features: mergedFeatures };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

const ACTIVE_RUN_QUERY = "SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ? AND status IN ('queued', 'running') LIMIT 1";

/**
 * 入队（契约 §9 组合）：单事务「锁 account → INSERT run（account_id 固化）→ 预留」；
 * 闸门拒绝抛 BillingError（quota_exceeded / billing_state_conflict / reconciliation_hold），
 * 由路由层映射 402/409；非阻塞复用（同 sha 活跃 run）返回既有 runId。
 */
export async function queueAnalysis(repositoryId: number, beforeSha: string | null, afterSha: string, trigger: "manual" | "push") {
  const result = await enqueueRunWithReservation({
    repositoryId,
    beforeSha,
    afterSha,
    trigger,
    requestId: randomUUID(),
  });
  return result.runId;
}

async function loadRun(runId: number) {
  const [rows] = await getDb().execute(
    `SELECT r.id, r.repository_id AS repositoryId, p.id AS productId, p.slug AS productSlug, p.name AS productName,
            repo.owner, repo.name, r.before_sha AS beforeSha, r.after_sha AS afterSha, repo.connection_id AS connectionId,
            repo.provider, p.organization_id AS organizationId, r.account_id AS accountId, p.analyze_mode AS analyzeMode
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
  // 执行入口预留检查（契约 §6.6/§9）：failed run 重试 / 恢复重派发时无 active 预留 → 重新预留
  // （封死免费重试漏洞）；有则沿用原预留。额度被拒的 BillingError 冒泡为失败原因。
  await ensureReservation(run);
  const stopHeartbeat = startHeartbeat(run.id);
  try {
    await runAnalysisBody(run);
  } finally {
    stopHeartbeat();
  }
}

/** 执行入口预留检查：无 active 预留 → reserveForNewRun（新 requestId = 新 attempt，完整闸门）。 */
async function ensureReservation(run: RunContext) {
  if (run.accountId == null) {
    // 防御路径：归属已由 031 回填，此处兜底不预留（契约遗留数据策略）
    console.warn("[billing] run has no account ownership; skipping reservation", { runId: run.id });
    return;
  }
  if (await hasActiveReservation(run.id)) return; // B5：恢复沿用原预留
  await reserveForNewRun(run.id, run.accountId, FIRST_RUN_UNITS, randomUUID());
}

/** 心跳（契约 §6.3）：执行期间每 60s 续期预留；finally 由调用方清除。 */
function startHeartbeat(runId: number) {
  const timer = setInterval(() => {
    heartbeat(runId).catch((error) => console.error("[billing] heartbeat failed", error));
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function runAnalysisBody(run: RunContext) {
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
  // P0 措辞锚定：把上一版场景全文喂给 prompt，未变行为逐字沿用；加载失败降级为仅命名约束，不阻塞分析。
  let previousSpecText: SpecAnchorFeature[];
  try {
    previousSpecText = await loadPreviousSpecText(run.repositoryId, executeWrapper);
  } catch (error) {
    console.error("[analysis] load previous spec text failed; anchoring disabled for this run", error);
    previousSpecText = [];
  }
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
  const result = await analyzeWithAI(sources, change, {
    previousFeatureNames,
    previousSpec: previousSpecText,
    affectedFeatureNames,
    // 调用级成本回执（契约 M0-T2）：usage 即时落库，平台 shadow 单独记账不计 SAU
    billing: { runId: run.id, accountId: run.accountId ?? null, chargeComponent: "main" },
  });
  assertEvidence(result, new Set([
    ...remote.slice.files.map((file) => file.path),
    ...change.files.map((file) => file.path),
  ]));
  const { specVersionId, features: mergedFeatures } = await saveResult(run, result, change, affectedKeys);
  // 结算捕获（契约 §9/§6.4）：主事务已提交，捕获失败不得改写 run 分析状态（D15）——
  // 只告警，sweep 扫描二会按 run 级结算请求缺失恢复结算。
  try {
    await capture(run.id, FIRST_RUN_UNITS);
  } catch (error) {
    console.error("[billing] capture failed; sweep will recover settlement", error);
  }
  // M1 通知分发：分析事务提交后 best-effort 投递；失败只记日志，不影响分析结果。
  try {
    await deliverAnalysisNotifications({ run, releaseUrl: change.url, specVersionId });
  } catch (error) {
    console.error("[notifications] delivery failed", error);
  }
  // M9 影子对比：增量落库成功后额外跑一次全量提取，只对比不落库（放行门槛 ≥98% 一致率的数据来源）。
  // 对比对象必须是 carry-forward 合并后的完整规格——增量 AI 输出本就只含受影响功能，
  // 直接与全量输出比较会恒等失败（missingKeys = 全部未受影响功能）。
  if (affectedKeys && incrementalShadowEnabled()) {
    try {
      const shadow = await analyzeWithAI(sources, change, {
        previousFeatureNames,
        billing: { runId: run.id, accountId: run.accountId ?? null, chargeComponent: "platform_shadow" },
      });
      if (process.env.INCREMENTAL_SHADOW_DEBUG === "true") {
        console.log("[incremental-shadow-debug]", JSON.stringify({
          changeFiles: change.files.map((file) => file.path),
          affected: [...affectedKeys],
          merged: mergedFeatures,
          shadow: shadow.features,
        }));
      }
      console.log("[incremental-shadow]", JSON.stringify(compareIncrementalShadow({ features: mergedFeatures, changes: result.changes }, shadow)));
    } catch (error) {
      console.error("[incremental-shadow] shadow analysis failed", error);
    }
  }
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
    // 失败释放（契约 §6.6）：独立短事务置 failed 后调用；释放失败由 M1-T6 sweep 兜底。
    try {
      await release(runId, "analysis_failed");
    } catch (billingError) {
      console.error("[billing] release failed; sweep will recover the reservation", billingError);
    }
  });
}

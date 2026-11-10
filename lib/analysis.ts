import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { analyzeWithAI, type AnalysisResult } from "./ai";
import { BillingError, capture, enqueueRunWithReservation, hasActiveReservation, heartbeat, release, reserveForNewRun } from "./billing/core";
import { FIRST_RUN_UNITS, HEARTBEAT_INTERVAL_MS } from "./billing/constants";
import { enqueueBillingNotification } from "./billing/notifications";
import { resolveAnalysisTarget, type ChangeContext, type CodeHostingProvider } from "./code-hosting";
import { analysisSliceBudgets, getPartitionedAnalysisSources, getRemoteAnalysisSources, parseSourceRoots, type AnalysisPartition } from "./remote-analysis";
import { createSlicePlanner } from "./slice-planner";
import { insertSpecVersion, loadPreviousFeatureNames, loadPreviousSpecText } from "./spec-versions";
import { loadAffectedFeatureKeys, rebuildSpecFileIndex } from "./spec-file-index";
import { resolveAnalysisMode } from "./incremental";
import { compareIncrementalShadow } from "./incremental-shadow";
import { analysisMaxPartitions, incrementalShadowEnabled } from "./env";
import { computeCoverageReceipt, enumerateImplementationSurface, saveCoverageReceipt, type AnalysisCoverageReceipt } from "./analysis-coverage";
import { mergeChunkResults, type ExtractionChunk } from "./extraction-merge";
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

/**
 * 证据清洗（替代整趟失败，2026-11-10 生产 run 185/186）：模型偶发引用「真实存在但本趟
 * 未读」的文件（相邻目录命名先验 / 公开仓库训练记忆），整趟作废会让其余分区的干净产出
 * 陪葬。只保留可溯源声明：不可溯源的场景 / 变化 / 功能整条剔除并留 warn 日志（红线不变：
 * 进规格的事实必须带可追溯证据）。清洗后为空 = 本趟无行为变化窗口，按既有语义接受
 * （空版本由坍缩护栏下游告警），不在此处抛错。
 */
export function sanitizeEvidence(result: AnalysisResult, sources: Set<string>, label: string) {
  const droppedPaths = new Set<string>();
  const keep = (items: AnalysisResult["product"]["evidence"]) =>
    items.filter((item) => {
      if (sources.has(item.path)) return true;
      droppedPaths.add(item.path);
      return false;
    });
  result.product.evidence = keep(result.product.evidence);
  result.changes = result.changes.filter((change) => {
    change.evidence = keep(change.evidence);
    return change.evidence.length > 0;
  });
  result.features = result.features.filter((feature) => {
    feature.scenarios = feature.scenarios.filter((scenario) => {
      scenario.evidence = keep(scenario.evidence);
      return scenario.evidence.length > 0;
    });
    return feature.scenarios.length > 0;
  });
  if (droppedPaths.size > 0) {
    console.warn("[analysis] dropped evidence-untraceable claims", { label, paths: [...droppedPaths], keptFeatures: result.features.length });
  }
}

/** 分区局部证据允许集：AI 只能引用本分区窗口与 diff 文件（逐趟口径校验）。 */
function evidenceAllowSet(partition: AnalysisPartition, change: ChangeContext) {
  return new Set([
    ...partition.slice.files.map((file) => file.path),
    ...change.files.map((file) => file.path),
  ]);
}

/**
 * 单趟提取失败重试一次：硬失败（解析 / 网络 / 网关）先重试一次而不是让整个 run 作废——
 * 重试调用的 LLM receipt 照常落库（成本如实记账），两次都失败才让 run 失败。证据路径
 * 清洗本身不再触发整趟作废（见 sanitizeEvidence；清洗后为空按无行为变化窗口接受）。
 */
async function extractPassWithRetry(options: {
  sources: AnalysisPartition["sources"];
  change: ChangeContext;
  context: Parameters<typeof analyzeWithAI>[2];
  allowSet: Set<string>;
  label: string;
}): Promise<AnalysisResult> {
  try {
    const result = await analyzeWithAI(options.sources, options.change, options.context);
    sanitizeEvidence(result, options.allowSet, options.label);
    return result;
  } catch (firstError) {
    console.warn("[analysis] extraction pass failed; retrying once", {
      label: options.label,
      error: firstError instanceof Error ? firstError.message.slice(0, 200) : String(firstError),
    });
    const result = await analyzeWithAI(options.sources, options.change, options.context);
    sanitizeEvidence(result, options.allowSet, `${options.label}/retry`);
    return result;
  }
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

async function saveResult(run: RunContext, result: AnalysisResult, change: ChangeContext, affectedKeys: ReadonlySet<string> | null = null, coverage?: AnalysisCoverageReceipt) {
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    await assertLatestRun(connection, run);
    await connection.execute(
      "UPDATE products SET description = ?, description_source = 'generated', description_evidence = ? WHERE id = ? AND description = ''",
      [result.product.description, JSON.stringify(result.product.evidence), run.productId],
    );
    const behavioralPaths = behavioralChangePaths(change.files);
    const { specVersionId, features: mergedFeatures, collapse } = await insertSpecVersion(connection, run, result, { ...(affectedKeys ? { affectedKeys } : {}), behavioralChangePaths: behavioralPaths });
    await rebuildSpecFileIndex(connection, run.repositoryId, specVersionId);
    await markSpecDrift(connection, run.productId, specVersionId);
    // B1：覆盖率回执与规格版本同事务落库（append-only，历史版本可回溯）
    if (coverage) await saveCoverageReceipt(connection, specVersionId, coverage);
    // P0(I1):下线基准必须是 carry-forward 合并后的完整规格——用 AI 原始输出会让
    // 增量模式把未受影响的 generated 功能全部下线,工作台坍缩为本次触及的功能。
    await upsertGeneratedSpec(connection, run, mergedFeatures);
    await upsertRelease(connection, run, result, change, specVersionId);
    await connection.execute("UPDATE analysis_runs SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [run.id]);
    await connection.commit();
    return { specVersionId, features: mergedFeatures, collapse };
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
  const remoteAnalysisRequest = {
    product: target.product,
    repository: { owner: repo.owner, repo: repo.name, revision: run.afterSha },
    access: target.access,
    provider: target.adapter.provider,
    scopeRoots,
    // W0-7：窗口 diff 文件必选装配（行为证据一手面，保证分区覆盖 diff 面）
    diffPaths: change.files.map((file) => file.path),
  };
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
    } else if (previousFeatureNames.length > 0) {
      // RC2（生产 run 125，2026-11-08）：全量回退不再裸跑——按行为变更集（patch-scan）
      // 重新算受影响面，证据文件本次无行为性行变更的既有功能原样沿用，只重提取行为性
      // 触及的功能。宽 diff 下 160KB 窗口丢场景曾致 v95 规格坍缩（178→83）。
      // 行为集为空或未命中任何既有功能时保持全量：可能是索引未覆盖的新功能，需 AI 看新代码。
      const behavioral = await loadAffectedFeatureKeys(run.repositoryId, [...behavioralChangePaths(change.files)], executeWrapper);
      if (behavioral.names.length > 0) {
        affectedKeys = behavioral.keys;
        affectedFeatureNames = behavioral.names;
      }
    }
  }
  // 多趟提取：实现面超出单窗口时按分区逐趟提取后确定性合并，全量与增量 / RC2-carry
  // 同一提取层（W0-6：按实现面而非运行模式决定是否分片；单窗仓库仍返回 1 个分区，
  // 行为与旧单窗路径一致）。SAU 结算仍为每 run 一次，各趟成本经 llm_call_receipts
  // （同 runId 多行，契约 M0-T2）如实记账。
  let result: AnalysisResult;
  let singleWindowSources: AnalysisPartition["sources"] | null = null;
  const { partitions, index: sourceIndex } = await getPartitionedAnalysisSources(remoteAnalysisRequest, { planner, budgets: analysisSliceBudgets }, { maxPartitions: analysisMaxPartitions() });
  console.log("[analysis] partitioned extraction", { runId: run.id, partitions: partitions.length, mode: affectedKeys === null ? "full" : "incremental-carry" });
  // B1 覆盖披露回执：装配面 vs 索引全树实现面（元数据级枚举，不读文件内容），
  // 落 analysis_coverage_receipts，append-only 可回溯；口径与 measure-first-analysis.ts 一致。
  const coverage = computeCoverageReceipt({
    index: sourceIndex,
    partitions,
    maxPartitions: analysisMaxPartitions(),
    implSurface: await enumerateImplementationSurface(sourceIndex),
  });
  if (partitions.length === 1) {
    const single = partitions[0];
    singleWindowSources = single.sources;
    result = await extractPassWithRetry({
      sources: single.sources,
      change,
      context: {
        previousFeatureNames,
        previousSpec: previousSpecText,
        ...(affectedKeys !== null ? { affectedFeatureNames } : {}),
        billing: { runId: run.id, accountId: run.accountId ?? null, chargeComponent: "main" },
      },
      allowSet: evidenceAllowSet(single, change),
      label: `single/${run.id}`,
    });
  } else {
    const chunks: ExtractionChunk[] = [];
    const knownFeatureNames = new Set(previousFeatureNames);
    for (const [index, partition] of partitions.entries()) {
      const chunkResult = await extractPassWithRetry({
        sources: partition.sources,
        change,
        context: {
          previousFeatureNames: [...knownFeatureNames],
          previousSpec: previousSpecText,
          ...(affectedKeys !== null ? { affectedFeatureNames } : {}),
          partition: { index: index + 1, total: partitions.length },
          billing: { runId: run.id, accountId: run.accountId ?? null, chargeComponent: "main" },
        },
        allowSet: evidenceAllowSet(partition, change),
        label: `pass${index + 1}/${run.id}`,
      });
      for (const feature of chunkResult.features) knownFeatureNames.add(feature.name);
      chunks.push({ result: chunkResult });
    }
    result = mergeChunkResults(chunks);
  }
  const { specVersionId, features: mergedFeatures, collapse } = await saveResult(run, result, change, affectedKeys, coverage);
  // 坍缩护栏：新版场景数骤降只告警不阻断（版本 append-only，可回溯）；通知带警告供人工核实。
  if (collapse) {
    console.error("[spec] suspected spec collapse", { runId: run.id, specVersionId, ...collapse });
  }
  // 结算捕获（契约 §9/§6.4）：主事务已提交，捕获失败不得改写 run 分析状态（D15）——
  // 只告警，sweep 扫描二会按 run 级结算请求缺失恢复结算。
  try {
    await capture(run.id, FIRST_RUN_UNITS, {
      notify: async (event) => {
        if (run.accountId == null) return;
        const type = event.type === "partially_settled" ? "settlement_partially_settled" : "settlement_unfunded";
        await enqueueBillingNotification({
          accountId: run.accountId,
          billingPeriod: new Date().toISOString().slice(0, 10),
          type,
          threshold: run.id,
          subject: `[CoDelphi] 分析已完成但额度结算不完整（缺少 ${event.unfundedUnits} SAU）`,
          body: "本次分析结果已保留；缺少的额度结算记录已进入人工对账队列，稍后会有专人与你确认处理方式。",
        });
      },
    });
  } catch (error) {
    console.error("[billing] capture failed; sweep will recover settlement", error);
  }
  // M1 通知分发：分析事务提交后 best-effort 投递；失败只记日志，不影响分析结果。
  try {
    await deliverAnalysisNotifications({ run, releaseUrl: change.url, specVersionId, collapse });
  } catch (error) {
    console.error("[notifications] delivery failed", error);
  }
  // M9 影子对比：增量落库成功后额外跑一次全量提取，只对比不落库（放行门槛 ≥98% 一致率的数据来源）。
  // 对比对象必须是 carry-forward 合并后的完整规格——增量 AI 输出本就只含受影响功能，
  // 直接与全量输出比较会恒等失败（missingKeys = 全部未受影响功能）。
  if (affectedKeys && incrementalShadowEnabled()) {
    try {
      // 影子对比保持单窗口径（W0-6 要点 5）：单窗 run 直接复用提取时的窗口；
      // 增量多趟 run 没有单一窗口，显式另取一份单窗切片，不得静默用空输入。
      let shadowSources = singleWindowSources;
      if (!shadowSources) {
        const shadowWindow = await getRemoteAnalysisSources(remoteAnalysisRequest, { planner, budgets: analysisSliceBudgets });
        shadowSources = shadowWindow.sources;
        console.log("[incremental-shadow] multi-pass run; shadow uses a separate single-window slice");
      }
      const shadow = await analyzeWithAI(shadowSources, change, {
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
    if (error instanceof BillingError) {
      // 账务拒绝不是终态（执行入口预留被拒，契约 §6.6）：保持 queued 等额度/订阅恢复后
      // 由 sweep 补跑，绝不标 failed。仅回收未落库的执行——结果已结算落库（succeeded）
      // 时条件不匹配即无操作；无 active 预留可释放，遗留预留由 reservation-ttl sweep 兜底。
      console.warn("[analysis] dispatch gated by billing; run re-queued", { runId });
      await getDb().execute(
        "UPDATE analysis_runs SET status = 'queued', started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'running'",
        [runId],
      );
      return;
    }
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

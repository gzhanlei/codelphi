import type { PoolConnection } from "mysql2/promise";
import { defaultExecute, type Execute } from "./db";
import {
  planRegressionTasks,
  type FeatureScenario,
  type IndexHit,
  type PlannedChange,
  type PlannedReason,
  type PlannedTask,
  type RegressionHitType,
  type RegressionTaskStatus,
  type RegressionTaskView,
  type TaskSubject,
} from "./regression-task-view";

export { planRegressionTasks, renderRegressionTaskMarkdown, hitTypeLabels, regressionStatusLabels, type FeatureScenario, type IndexHit, type PlannedChange, type PlannedReason, type PlannedTask, type RegressionHitType, type RegressionTaskStatus, type RegressionTaskView, type TaskSubject } from "./regression-task-view";

export async function ensureRegressionTasks(connection: Pick<PoolConnection, "execute">, releaseId: number) {
  const [releaseRows, changeRows, fileRows] = await Promise.all([
    connection.execute("SELECT id, spec_version_id AS specVersionId, repository_id AS repositoryId FROM releases WHERE id = ?", [releaseId]),
    connection.execute(
      `SELECT c.id, c.entity_type AS entityType, c.kind, c.feature_key AS featureKey, c.feature_name AS featureName,
              c.scenario_reference AS scenarioReference, sf.id AS featureId, ss.id AS scenarioId
       FROM spec_changes c
       JOIN spec_features sf ON sf.spec_version_id = c.spec_version_id AND sf.stable_key = c.feature_key
       LEFT JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id AND ss.reference = c.scenario_reference
       WHERE c.spec_version_id = (SELECT spec_version_id FROM releases WHERE id = ?)
       ORDER BY c.id`,
      [releaseId],
    ),
    connection.execute("SELECT path FROM release_files WHERE release_id = ?", [releaseId]),
  ]);
  const release = (releaseRows as [Array<{ specVersionId: number | null; repositoryId: number }>, unknown])[0][0];
  if (!release?.specVersionId) return;

  const changes: PlannedChange[] = (changeRows as [Array<{ id: number; entityType: string; kind: string; featureKey: string; featureName: string; scenarioReference: string; featureId: number; scenarioId: number | null }>, unknown])[0]
    .map((row) => ({
      id: Number(row.id),
      entityType: row.entityType as PlannedChange["entityType"],
      kind: row.kind,
      featureId: Number(row.featureId),
      featureKey: row.featureKey,
      featureName: row.featureName,
      scenarioReference: row.scenarioReference,
      scenarioId: row.scenarioId === null ? null : Number(row.scenarioId),
    }));

  const paths = (fileRows as [Array<{ path: string }>, unknown])[0].map((row) => row.path);
  const [hitRows, featureScenarioRows, existingRows] = await Promise.all([
    paths.length === 0 ? Promise.resolve([[], null]) : connection.execute(
      `SELECT i.path, sf.id AS featureId, sf.stable_key AS featureKey, sf.name AS featureName, i.spec_scenario_id AS scenarioId, ss.reference
       FROM spec_file_index i
       JOIN spec_features sf ON sf.id = i.spec_feature_id
       LEFT JOIN spec_scenarios ss ON ss.id = i.spec_scenario_id
       WHERE i.spec_version_id = ? AND i.path IN (${paths.map(() => "?").join(",")})`,
      [release.specVersionId, ...paths],
    ),
    connection.execute(
      `SELECT sf.id AS featureId, ss.id AS scenarioId, ss.reference
       FROM spec_features sf JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id
       WHERE sf.spec_version_id = ? ORDER BY sf.id, ss.reference`,
      [release.specVersionId],
    ),
    connection.execute(
      `SELECT t.id AS taskId, t.spec_scenario_id AS specScenarioId, t.spec_change_id AS specChangeId,
              s.spec_change_id AS sourceChangeId, r.hit_type AS hitType, r.matched_path AS matchedPath
       FROM regression_tasks t
       LEFT JOIN regression_task_sources s ON s.task_id = t.id
       LEFT JOIN regression_task_reasons r ON r.task_id = t.id
       WHERE t.release_id = ?`,
      [releaseId],
    ),
  ]);

  const fileHits: IndexHit[] = ((hitRows as [Array<{ path: string; featureId: number; featureKey: string; featureName: string; scenarioId: number | null; reference: string | null }>, unknown])[0] ?? []).map((row) => ({
    path: row.path,
    featureId: Number(row.featureId),
    featureKey: row.featureKey,
    featureName: row.featureName,
    scenarioId: row.scenarioId === null ? null : Number(row.scenarioId),
    reference: row.reference,
  }));
  const featureScenarios = new Map<number, FeatureScenario[]>();
  for (const row of (featureScenarioRows as [Array<{ featureId: number; scenarioId: number; reference: string }>, unknown])[0]) {
    const featureId = Number(row.featureId);
    const list = featureScenarios.get(featureId) ?? [];
    list.push({ scenarioId: Number(row.scenarioId), reference: row.reference });
    featureScenarios.set(featureId, list);
  }

  // 已有任务与其理由/来源，保证重复执行幂等。
  const existing = new Map<string, { taskId: number; sources: Set<number>; reasons: Set<string> }>();
  for (const row of (existingRows as [Array<{ taskId: number; specScenarioId: number | null; specChangeId: number | null; sourceChangeId: number | null; hitType: string | null; matchedPath: string | null }>, unknown])[0]) {
    const key = row.specScenarioId !== null ? `s${Number(row.specScenarioId)}` : `c${Number(row.specChangeId)}`;
    let entry = existing.get(key);
    if (!entry) {
      entry = { taskId: Number(row.taskId), sources: new Set(), reasons: new Set() };
      existing.set(key, entry);
    }
    if (row.sourceChangeId !== null) entry.sources.add(Number(row.sourceChangeId));
    if (row.hitType !== null) entry.reasons.add(`${row.hitType}:${row.matchedPath ?? ""}`);
  }

  for (const planned of planRegressionTasks({ changes, fileHits, featureScenarios })) {
    const key = planned.subject.kind === "scenario" ? `s${planned.subject.scenarioId}` : `c${planned.subject.changeId}`;
    let entry = existing.get(key);
    if (!entry) {
      const scenarioId = planned.subject.kind === "scenario" ? planned.subject.scenarioId : null;
      const changeId = planned.subject.kind === "change" ? planned.subject.changeId : null;
      const result = await connection.execute(
        `INSERT INTO regression_tasks (release_id, spec_scenario_id, spec_change_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [releaseId, scenarioId, changeId],
      );
      const insertId = (result as unknown as [{ insertId?: number }])[0]?.insertId;
      entry = { taskId: Number(insertId ?? 0), sources: new Set(), reasons: new Set() };
      existing.set(key, entry);
    }
    const taskId = entry.taskId;
    if (!taskId) continue;
    for (const source of planned.sources) {
      if (entry.sources.has(source)) continue;
      entry.sources.add(source);
      await connection.execute("INSERT IGNORE INTO regression_task_sources (task_id, spec_change_id) VALUES (?, ?)", [taskId, source]);
    }
    for (const reason of planned.reasons) {
      const marked = `${reason.hitType}:${reason.matchedPath ?? ""}`;
      if (entry.reasons.has(marked)) continue;
      entry.reasons.add(marked);
      await connection.execute(
        `INSERT INTO regression_task_reasons (task_id, hit_type, matched_path, spec_feature_id, spec_scenario_id)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM regression_task_reasons WHERE task_id = ? AND hit_type = ? AND matched_path <=> ?)`,
        [taskId, reason.hitType, reason.matchedPath, reason.featureId, reason.scenarioId, taskId, reason.hitType, reason.matchedPath],
      );
    }
  }
}

export async function loadRegressionTasks(productId: number, execute: Execute = defaultExecute): Promise<RegressionTaskView[]> {
  const [rows] = await execute(
    `SELECT t.id AS taskId, t.release_id AS releaseId, t.status, t.checked_by AS checkedBy, t.checked_at AS checkedAt,
            t.skip_reason AS skipReason, t.failure_note AS failureNote,
            t.spec_scenario_id AS specScenarioId, t.spec_change_id AS specChangeId,
            COALESCE(ss.reference, c.scenario_reference, NULL) AS reference,
            COALESCE(sf.name, c.feature_name) AS featureName,
            ss.context AS scenarioContext, ss.action AS scenarioAction,
            (SELECT s.spec_change_id FROM regression_task_sources s
             JOIN spec_changes pc ON pc.id = s.spec_change_id AND pc.entity_type = 'scenario' AND pc.kind <> 'removed'
             WHERE s.task_id = t.id LIMIT 1) AS primaryChangeId
     FROM regression_tasks t
     JOIN releases r ON r.id = t.release_id
     LEFT JOIN spec_scenarios ss ON ss.id = t.spec_scenario_id
     LEFT JOIN spec_features sf ON sf.id = ss.spec_feature_id
     LEFT JOIN spec_changes c ON c.id = t.spec_change_id
     WHERE r.product_id = ?
     ORDER BY r.committed_at DESC, sf.name, ss.reference, t.id`,
    [productId],
  ) as [Array<{ taskId: number; releaseId: number; status: RegressionTaskStatus; checkedBy: string | null; checkedAt: Date | null; skipReason: string | null; failureNote: string | null; specScenarioId: number | null; specChangeId: number | null; reference: string | null; featureName: string | null; scenarioContext: string | null; scenarioAction: string | null; primaryChangeId: number | null }>, unknown];

  const [sourceRows] = await execute(
    `SELECT s.task_id AS taskId, s.spec_change_id AS changeId FROM regression_task_sources s
     JOIN regression_tasks t ON t.id = s.task_id JOIN releases r ON r.id = t.release_id
     WHERE r.product_id = ? ORDER BY s.spec_change_id`,
    [productId],
  ) as [Array<{ taskId: number; changeId: number }>, unknown];
  const [reasonRows] = await execute(
    `SELECT r.task_id AS taskId, r.hit_type AS hitType, r.matched_path AS matchedPath, r.spec_feature_id AS featureId, r.spec_scenario_id AS scenarioId
     FROM regression_task_reasons r
     JOIN regression_tasks t ON t.id = r.task_id JOIN releases rel ON rel.id = t.release_id
     WHERE rel.product_id = ? ORDER BY r.id`,
    [productId],
  ) as [Array<{ taskId: number; hitType: RegressionHitType; matchedPath: string | null; featureId: number | null; scenarioId: number | null }>, unknown];

  const sourcesByTask = new Map<number, number[]>();
  for (const row of sourceRows) {
    const list = sourcesByTask.get(Number(row.taskId)) ?? [];
    list.push(Number(row.changeId));
    sourcesByTask.set(Number(row.taskId), list);
  }
  const reasonsByTask = new Map<number, PlannedReason[]>();
  for (const row of reasonRows) {
    const list = reasonsByTask.get(Number(row.taskId)) ?? [];
    list.push({ hitType: row.hitType, matchedPath: row.matchedPath, featureId: row.featureId === null ? null : Number(row.featureId), scenarioId: row.scenarioId === null ? null : Number(row.scenarioId) });
    reasonsByTask.set(Number(row.taskId), list);
  }

  return rows.map((row) => ({
    taskId: Number(row.taskId),
    releaseId: Number(row.releaseId),
    subject: row.specScenarioId !== null ? { kind: "scenario" as const, scenarioId: Number(row.specScenarioId) } : { kind: "change" as const, changeId: Number(row.specChangeId) },
    status: row.status,
    checkedBy: row.checkedBy,
    checkedAt: row.checkedAt,
    skipReason: row.skipReason,
    failureNote: row.failureNote,
    featureName: row.featureName ?? "",
    reference: row.reference,
    primaryChangeId: row.primaryChangeId === null ? null : Number(row.primaryChangeId),
    scenarioContext: row.scenarioContext,
    scenarioAction: row.scenarioAction,
    sources: sourcesByTask.get(Number(row.taskId)) ?? [],
    reasons: reasonsByTask.get(Number(row.taskId)) ?? [],
  }));
}

export interface RegressionTaskInput {
  productId: number;
  taskId: number;
  status: RegressionTaskStatus;
  checkedBy: string | null;
  skipReason?: string | null;
  failureNote?: string | null;
}

/** 更新验证状态；跳过原因仅 skipped 保留，失败备注仅 failed 保留，其余状态清空。 */
export async function setRegressionTask(input: RegressionTaskInput, execute: Execute = defaultExecute) {
  const skipReason = input.status === "skipped" ? input.skipReason?.trim() || null : null;
  const failureNote = input.status === "failed" ? input.failureNote?.trim() || null : null;
  const [result] = await execute(
    `UPDATE regression_tasks t
     JOIN releases r ON r.id = t.release_id
     SET t.status = ?, t.skip_reason = ?, t.failure_note = ?, t.checked_by = ?, t.checked_at = CURRENT_TIMESTAMP(3)
     WHERE t.id = ? AND r.product_id = ?`,
    [input.status, skipReason, failureNote, input.checkedBy, input.taskId, input.productId],
  ) as [{ affectedRows?: number }, unknown];
  if (!result.affectedRows) throw new Error("regression_task_invalid");
}

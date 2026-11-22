import { randomUUID } from "node:crypto";
import type { Execute } from "../db";
import { makeBatchKey } from "./identity";
import { computePlanSetFingerprint } from "./planner";
import {
  BATCH_PLANNER_VERSION,
  type BatchExecutionAllocation,
  type BatchFallbackAssignment,
  type BatchPlan,
  type BatchPlanSet,
} from "./types";

export type ExecutionBatchErrorCode =
  | "execution_batch_version_conflict"
  | "execution_batch_plan_set_not_ready"
  | "execution_batch_plan_set_exists"
  | "execution_batch_allocation_mismatch"
  | "execution_batch_request_state"
  | "execution_batch_response_persistence_failed"
  | "execution_batch_receipt_conflict"
  | "execution_batch_attempt_state";

export class ExecutionBatchError extends Error {
  constructor(
    readonly code: ExecutionBatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionBatchError";
  }
}

interface Row extends Record<string, unknown> {}

interface PlanSetRow {
  run_id: number;
  plan_set_id: string;
  plan_set_fingerprint: string;
  planner_version: string;
  expected_plan_count: number;
  expected_task_count: number;
  publish_status: string;
  fallback_assignments: string;
}

interface PlanRow {
  run_id: number;
  plan_set_id: string;
  batch_key: string;
  manifest_hash: string;
  planner_version: string;
  ordered_task_keys: string;
  task_alias_map: string;
  grouping_rules_fingerprint: string;
  input_budget_snapshot: string;
}

export interface PublishPlanSetInput {
  runId: number;
  manifestHash: string;
  plannerVersion?: string;
  manifestTaskKeys: readonly string[];
  allocation: BatchExecutionAllocation;
}

function asRows(result: unknown): Row[] {
  return (result as [Row[], unknown])[0] ?? [];
}

function num(value: unknown): number {
  return Number(value);
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function routingMismatchDetail(allocation: BatchExecutionAllocation, manifestTaskKeys: readonly string[]): string | null {
  const routed = [
    ...allocation.batchPlans.flatMap((plan) => plan.orderedTaskKeys),
    ...allocation.fallbackAssignments.map((assignment) => assignment.taskKey),
  ];
  const routedSet = new Set(routed);
  const manifestSet = new Set(manifestTaskKeys);
  if (routed.length !== routedSet.size) return "存在重复路由的 task";
  for (const key of routedSet) if (!manifestSet.has(key)) return `allocation 路由了 manifest 之外的 task: ${key}`;
  for (const key of manifestSet) if (!routedSet.has(key)) return `manifest task 未被路由: ${key}`;
  return null;
}

function rowToPlan(row: PlanRow): BatchPlan {
  return {
    runId: num(row.run_id),
    planSetId: str(row.plan_set_id),
    batchKey: str(row.batch_key),
    manifestHash: str(row.manifest_hash),
    plannerVersion: str(row.planner_version),
    orderedTaskKeys: JSON.parse(str(row.ordered_task_keys)) as string[],
    taskAliasMap: JSON.parse(str(row.task_alias_map)) as Record<string, string>,
    groupingRulesFingerprint: str(row.grouping_rules_fingerprint),
    inputBudgetSnapshot: JSON.parse(str(row.input_budget_snapshot)) as BatchPlan["inputBudgetSnapshot"],
  };
}

/**
 * 两阶段发布（§7 / §23.9）：先落 building 行与全部 plans（building 不可执行），
 * 再读回持久化行重算数量/唯一归属/指纹，全部一致才以一次短条件更新转 ready。
 * 发布前先做 allocation 路由校验（missing/extra/duplicate → 零落库拒绝）；
 * 同 run 已存在 plan set 时拒绝重建（新 planner 只用于新 run）。
 */
export async function publishBehaviorBatchPlanSet(execute: Execute, input: PublishPlanSetInput): Promise<BatchPlanSet> {
  const plannerVersion = input.plannerVersion ?? BATCH_PLANNER_VERSION;
  const mismatch = routingMismatchDetail(input.allocation, input.manifestTaskKeys);
  if (mismatch !== null) {
    throw new ExecutionBatchError("execution_batch_allocation_mismatch", `run ${input.runId} plan set 路由不完整：${mismatch}`);
  }
  const existing = asRows(
    await execute("SELECT plan_set_id FROM analysis_behavior_batch_plan_sets WHERE run_id = ?", [input.runId]),
  );
  if (existing.length > 0) {
    throw new ExecutionBatchError("execution_batch_plan_set_exists", `run ${input.runId} 已存在 plan set，不得重建`);
  }
  const planSetId = randomUUID();
  await execute(
    `INSERT INTO analysis_behavior_batch_plan_sets
       (run_id, plan_set_id, plan_set_fingerprint, planner_version, expected_plan_count, expected_task_count, publish_status, fallback_assignments)
     VALUES (?, ?, ?, ?, ?, ?, 'building', ?)`,
    [
      input.runId,
      planSetId,
      input.allocation.planSetFingerprint,
      plannerVersion,
      input.allocation.batchPlans.length,
      input.manifestTaskKeys.length,
      JSON.stringify(input.allocation.fallbackAssignments),
    ],
  );
  for (const plan of input.allocation.batchPlans) {
    await execute(
      `INSERT INTO analysis_behavior_batch_plans
         (run_id, plan_set_id, batch_key, manifest_hash, planner_version, ordered_task_keys, task_alias_map, grouping_rules_fingerprint, input_budget_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        planSetId,
        plan.batchKey,
        plan.manifestHash,
        plan.plannerVersion,
        JSON.stringify(plan.orderedTaskKeys),
        JSON.stringify(plan.taskAliasMap),
        plan.groupingRulesFingerprint,
        JSON.stringify(plan.inputBudgetSnapshot),
      ],
    );
  }

  const setRows = asRows(
    await execute(
      `SELECT plan_set_id, plan_set_fingerprint, planner_version, expected_plan_count, expected_task_count, fallback_assignments
         FROM analysis_behavior_batch_plan_sets WHERE run_id = ? AND plan_set_id = ?`,
      [input.runId, planSetId],
    ),
  ) as unknown as PlanSetRow[];
  const setRow = setRows[0];
  if (!setRow) throw new ExecutionBatchError("execution_batch_version_conflict", `run ${input.runId} plan set ${planSetId} 发布读回失败`);
  const planRows = (asRows(
    await execute(
      `SELECT batch_key, manifest_hash, planner_version, ordered_task_keys, task_alias_map, grouping_rules_fingerprint, input_budget_snapshot
         FROM analysis_behavior_batch_plans WHERE run_id = ? AND plan_set_id = ? ORDER BY batch_key`,
      [input.runId, planSetId],
    ),
  ) as unknown as PlanRow[]).sort((a, b) => (a.batch_key < b.batch_key ? -1 : 1));
  validateStoredPlanSet(setRow, planRows, input.manifestTaskKeys);

  const [updateResult] = (await execute(
    `UPDATE analysis_behavior_batch_plan_sets SET publish_status = 'ready'
      WHERE run_id = ? AND plan_set_id = ? AND publish_status = 'building'`,
    [input.runId, planSetId],
  )) as [{ affectedRows: number }, unknown];
  if (updateResult.affectedRows !== 1) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${input.runId} plan set ${planSetId} building→ready 条件更新失败`);
  }

  return {
    runId: input.runId,
    planSetId,
    planSetFingerprint: str(setRow.plan_set_fingerprint),
    plannerVersion: str(setRow.planner_version),
    expectedPlanCount: num(setRow.expected_plan_count),
    expectedTaskCount: num(setRow.expected_task_count),
    status: "ready",
    fallbackAssignments: JSON.parse(str(setRow.fallback_assignments)) as BatchFallbackAssignment[],
  };
}

function validateStoredPlanSet(setRow: PlanSetRow, planRows: PlanRow[], manifestTaskKeys: readonly string[]): void {
  const runId = num(setRow.run_id);
  const planSetId = str(setRow.plan_set_id);
  if (planRows.length !== num(setRow.expected_plan_count)) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan set ${planSetId} 持久化 plan 数量不符`);
  }
  const manifestHashes = new Set(planRows.map((row) => str(row.manifest_hash)));
  if (manifestHashes.size > 1) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan set ${planSetId} 混入不同 manifest 的 plan`);
  }
  const storedPlans = planRows.map(rowToPlan);
  for (const plan of storedPlans) {
    const recomputed = makeBatchKey({
      manifestHash: plan.manifestHash,
      plannerVersion: plan.plannerVersion,
      orderedTaskKeys: plan.orderedTaskKeys,
      groupingRulesFingerprint: plan.groupingRulesFingerprint,
    });
    if (recomputed !== plan.batchKey) {
      throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan ${plan.batchKey} 成员或顺序与持久化 batch_key 不符`);
    }
    if (plan.plannerVersion !== str(setRow.planner_version)) {
      throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan ${plan.batchKey} planner 版本与 plan set 不一致`);
    }
    const aliasKeys = Object.keys(plan.taskAliasMap).sort();
    const expectedKeys = [...plan.orderedTaskKeys].sort();
    if (aliasKeys.length !== expectedKeys.length || aliasKeys.some((key, index) => key !== expectedKeys[index])) {
      throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan ${plan.batchKey} T 别名映射与成员不符`);
    }
  }
  const fallbackAssignments = JSON.parse(str(setRow.fallback_assignments)) as BatchFallbackAssignment[];
  const recomputedFingerprint = computePlanSetFingerprint(
    str(setRow.planner_version),
    planRows.length > 0 ? str(planRows[0]!.manifest_hash) : "",
    storedPlans.length > 0 ? storedPlans[0]!.groupingRulesFingerprint : "",
    storedPlans,
    fallbackAssignments,
  );
  if (recomputedFingerprint !== str(setRow.plan_set_fingerprint)) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan set ${planSetId} 指纹重算不符`);
  }
  const mismatch = routingMismatchDetail(
    { batchPlans: storedPlans, fallbackAssignments, planSetFingerprint: str(setRow.plan_set_fingerprint) },
    manifestTaskKeys,
  );
  if (mismatch !== null) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan set ${planSetId} 持久化路由不完整：${mismatch}`);
  }
}

/**
 * 恢复入口：只读 ready plan set 并重算完整性；版本、原因、成员或数量不符抛
 * execution_batch_version_conflict，不得在恢复时重新规划（§23.5 C5.4）。
 */
export async function loadReadyBehaviorBatchAllocation(execute: Execute, runId: number): Promise<BatchExecutionAllocation> {
  const setRows = asRows(
    await execute(
      `SELECT plan_set_id, plan_set_fingerprint, planner_version, expected_plan_count, expected_task_count, fallback_assignments
         FROM analysis_behavior_batch_plan_sets WHERE run_id = ? AND publish_status = 'ready' ORDER BY id DESC LIMIT 1`,
      [runId],
    ),
  ) as unknown as PlanSetRow[];
  const setRow = setRows[0];
  if (!setRow) {
    throw new ExecutionBatchError("execution_batch_plan_set_not_ready", `run ${runId} 没有 ready 的 plan set`);
  }
  const planRows = (asRows(
    await execute(
      `SELECT batch_key, manifest_hash, planner_version, ordered_task_keys, task_alias_map, grouping_rules_fingerprint, input_budget_snapshot
         FROM analysis_behavior_batch_plans WHERE run_id = ? AND plan_set_id = ? ORDER BY batch_key`,
      [runId, str(setRow.plan_set_id)],
    ),
  ) as unknown as PlanRow[]).sort((a, b) => (a.batch_key < b.batch_key ? -1 : 1));
  if (planRows.length !== num(setRow.expected_plan_count)) {
    throw new ExecutionBatchError("execution_batch_version_conflict", `run ${runId} plan set ${str(setRow.plan_set_id)} plan 数量不符`);
  }
  const storedPlans = planRows.map(rowToPlan);
  const fallbackAssignments = JSON.parse(str(setRow.fallback_assignments)) as BatchFallbackAssignment[];
  validateStoredPlanSet(setRow, planRows, [
    ...storedPlans.flatMap((plan) => plan.orderedTaskKeys),
    ...fallbackAssignments.map((assignment) => assignment.taskKey),
  ]);
  return {
    batchPlans: storedPlans.map((plan) => ({ ...plan, runId, planSetId: str(setRow.plan_set_id) })),
    fallbackAssignments,
    planSetFingerprint: str(setRow.plan_set_fingerprint),
  };
}

import { dirname } from "node:path";
import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import { batchFingerprint, makeBatchKey } from "./identity";
import {
  BATCH_PLANNER_VERSION,
  type BatchExecutionAllocation,
  type BatchFallbackAssignment,
  type BatchFallbackReason,
  type BatchPlan,
} from "./types";

/** 初始组批限制（spec §7.1，冻结于 §23.8）：软预算，不是突破模型上下文的依据。 */
export const BATCH_MAX_TASKS = 4;
export const BATCH_MAX_PRIMARY_UTF8_BYTES = 32_000;
export const BATCH_MAX_REGIONS = 24;

/** fallback 原因优先级（冻结）：多重原因时按此序取唯一 reason，路由稳定可复算。 */
const FALLBACK_REASON_PRECEDENCE: BatchFallbackReason[] = ["oversized", "blank_fragment", "unsupported_task_shape"];

export interface PlanTaskInput {
  task: BehaviorExecutionTask;
  /** residual 任务按主文件分组、普通任务按主文件目录分组；residual 判定由编排层按任务身份给出。 */
  isResidual: boolean;
  primaryPath: string;
  primaryUtf8Bytes: number;
  /** 空白 fragment 检测复用提取层导出的纯函数（behavior-unit-extraction.fragmentIsBlank）。 */
  hasBlankFragment: boolean;
  supportedShape: boolean;
}

export interface PlanBatchesInput {
  manifestHash: string;
  plannerVersion?: string;
  tasks: PlanTaskInput[];
}

function groupKeyOf(task: PlanTaskInput): string {
  return task.isResidual ? `file:${task.primaryPath}` : `dir:${dirname(task.primaryPath)}`;
}

function fallbackReasonOf(task: PlanTaskInput): BatchFallbackReason | null {
  const reasons = new Set<BatchFallbackReason>();
  if (task.primaryUtf8Bytes > BATCH_MAX_PRIMARY_UTF8_BYTES || task.task.anchorFragments.length > BATCH_MAX_REGIONS) {
    reasons.add("oversized");
  }
  if (task.hasBlankFragment) reasons.add("blank_fragment");
  if (!task.supportedShape) reasons.add("unsupported_task_shape");
  return FALLBACK_REASON_PRECEDENCE.find((reason) => reasons.has(reason)) ?? null;
}

/** plan set 指纹的规范输入（发布/恢复两侧共用同一构造，成员顺序按 batch_key canonical 化）。 */
export function computePlanSetFingerprint(
  plannerVersion: string,
  manifestHash: string,
  groupingRulesFingerprint: string,
  plans: ReadonlyArray<{
    batchKey: string;
    orderedTaskKeys: readonly string[];
    taskAliasMap: Readonly<Record<string, string>>;
    inputBudgetSnapshot: { primaryUtf8Bytes: number; regionCount: number; estimatedInputTokens: number; expectedOutputTokens: number };
  }>,
  fallbackAssignments: readonly BatchFallbackAssignment[],
): string {
  return batchFingerprint({
    kind: "analysis_behavior_batch_plan_set",
    planner_version: plannerVersion,
    manifest_hash: manifestHash,
    grouping_rules_fingerprint: groupingRulesFingerprint,
    plans: [...plans]
      .sort((a, b) => (a.batchKey < b.batchKey ? -1 : 1))
      .map((plan) => ({
        batch_key: plan.batchKey,
        ordered_task_keys: plan.orderedTaskKeys,
        task_alias_map: plan.taskAliasMap,
        input_budget_snapshot: plan.inputBudgetSnapshot,
      })),
    fallback_assignments: [...fallbackAssignments].sort((a, b) => (a.taskKey < b.taskKey ? -1 : 1)),
  });
}

/**
 * 确定性 planner（§23.2 C2）：相同输入产生相同 plan。residual 按主文件、普通任务按目录分组，
 * 组内按 taskKey 排序后贪心装箱；fallback 任务断开当前 open batch（其后的成员进入新 batch，
 * 局部 T 序列重新从 T1 开始），保证不可组批任务不重排任何 batch 的 T 别名。
 * planner 只产生路由与别名，不改写 task 身份/manifest；单成员 batch 合法（是否发起由编排层决定）。
 */
export function planBehaviorExecutionBatches(input: PlanBatchesInput): BatchExecutionAllocation {
  const plannerVersion = input.plannerVersion ?? BATCH_PLANNER_VERSION;
  const groupingRulesFingerprint = batchFingerprint({
    kind: "analysis_behavior_grouping_rules",
    planner_version: plannerVersion,
    max_tasks_per_batch: BATCH_MAX_TASKS,
    max_primary_utf8_bytes: BATCH_MAX_PRIMARY_UTF8_BYTES,
    max_regions_per_batch: BATCH_MAX_REGIONS,
    fallback_reason_precedence: FALLBACK_REASON_PRECEDENCE,
    grouping: "residual-by-file, normal-by-directory, deterministic greedy, fallback breaks the open batch",
  });

  const sorted = [...input.tasks].sort((a, b) => {
    const groupA = groupKeyOf(a);
    const groupB = groupKeyOf(b);
    if (groupA !== groupB) return groupA < groupB ? -1 : 1;
    if (a.task.taskKey !== b.task.taskKey) return a.task.taskKey < b.task.taskKey ? -1 : 1;
    return 0;
  });

  const fallbackAssignments: BatchFallbackAssignment[] = [];
  const batches: Array<{ tasks: PlanTaskInput[]; primaryUtf8Bytes: number; regions: number }> = [];
  let current: { tasks: PlanTaskInput[]; primaryUtf8Bytes: number; regions: number } | null = null;
  for (const task of sorted) {
    const fallback = fallbackReasonOf(task);
    if (fallback !== null) {
      fallbackAssignments.push({ taskKey: task.task.taskKey, reason: fallback });
      current = null;
      continue;
    }
    if (
      current === null ||
      current.tasks.length >= BATCH_MAX_TASKS ||
      current.primaryUtf8Bytes + task.primaryUtf8Bytes > BATCH_MAX_PRIMARY_UTF8_BYTES ||
      current.regions + task.task.anchorFragments.length > BATCH_MAX_REGIONS
    ) {
      current = {
        tasks: [task],
        primaryUtf8Bytes: task.primaryUtf8Bytes,
        regions: task.task.anchorFragments.length,
      };
      batches.push(current);
      continue;
    }
    current.tasks.push(task);
    current.primaryUtf8Bytes += task.primaryUtf8Bytes;
    current.regions += task.task.anchorFragments.length;
  }
  fallbackAssignments.sort((a, b) => (a.taskKey < b.taskKey ? -1 : 1));

  const batchPlans: BatchPlan[] = batches.map((batch) => {
    const orderedTaskKeys = batch.tasks.map((task) => task.task.taskKey);
    const taskAliasMap: Record<string, string> = {};
    orderedTaskKeys.forEach((taskKey, index) => {
      taskAliasMap[taskKey] = `T${index + 1}`;
    });
    const inputBudgetSnapshot = {
      primaryUtf8Bytes: batch.primaryUtf8Bytes,
      regionCount: batch.regions,
      // 粗估输入 token（~4 字节/token），仅作预算快照；输出预算不做 planner 期断言
      estimatedInputTokens: Math.ceil(batch.primaryUtf8Bytes / 4),
      expectedOutputTokens: 0,
    };
    return {
      // planner 阶段 run/plan set 未定，发布与恢复时填充真实值
      runId: 0,
      planSetId: "",
      batchKey: makeBatchKey({
        manifestHash: input.manifestHash,
        plannerVersion,
        orderedTaskKeys,
        groupingRulesFingerprint,
      }),
      manifestHash: input.manifestHash,
      plannerVersion,
      orderedTaskKeys,
      taskAliasMap,
      groupingRulesFingerprint,
      inputBudgetSnapshot,
    };
  });

  const planSetFingerprint = computePlanSetFingerprint(
    plannerVersion,
    input.manifestHash,
    groupingRulesFingerprint,
    batchPlans,
    fallbackAssignments,
  );

  return { batchPlans, fallbackAssignments, planSetFingerprint };
}

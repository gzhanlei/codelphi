import { describe, expect, it } from "vitest";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import {
  BATCH_MAX_PRIMARY_UTF8_BYTES,
  BATCH_MAX_REGIONS,
  planBehaviorExecutionBatches,
  type PlanTaskInput,
} from "../lib/execution-batch/planner";

const MANIFEST_HASH = "m".repeat(64);

function makeTask(taskKey: string, regionCount: number): BehaviorExecutionTask {
  return {
    taskKey,
    unitKey: `unit|${taskKey}`,
    anchorFragments: Array.from({ length: regionCount }, (_, index) => ({
      anchorKey: `anchor|${taskKey}#${index}`,
      anchorFragmentKey: `fragment|${taskKey}#${index}`,
      ranges: [{ startLine: index * 10 + 1, endLine: index * 10 + 9 }],
    })),
  };
}

interface PlanTaskOptions {
  regions?: number;
  isResidual?: boolean;
  primaryPath?: string;
  primaryUtf8Bytes?: number;
  hasBlankFragment?: boolean;
  supportedShape?: boolean;
}

function planTask(taskKey: string, options: PlanTaskOptions = {}): PlanTaskInput {
  return {
    task: makeTask(taskKey, options.regions ?? 2),
    isResidual: options.isResidual ?? true,
    primaryPath: options.primaryPath ?? "src/a.ts",
    primaryUtf8Bytes: options.primaryUtf8Bytes ?? 1000,
    hasBlankFragment: options.hasBlankFragment ?? false,
    supportedShape: options.supportedShape ?? true,
  };
}

describe("execution batch planner", () => {
  it("packs small same file residual tasks without merging task identities", () => {
    const allocation = planBehaviorExecutionBatches({
      manifestHash: MANIFEST_HASH,
      tasks: [planTask("task|b"), planTask("task|a"), planTask("task|c")],
    });
    expect(allocation.fallbackAssignments).toEqual([]);
    expect(allocation.batchPlans).toHaveLength(1);
    const plan = allocation.batchPlans[0]!;
    expect(plan.orderedTaskKeys).toEqual(["task|a", "task|b", "task|c"]);
    // T 别名映射到原始 taskKey：batch 只包装身份，不合并/不改写 task
    expect(plan.taskAliasMap).toEqual({ "task|a": "T1", "task|b": "T2", "task|c": "T3" });
    expect(plan.batchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.manifestHash).toBe(MANIFEST_HASH);
    // R 别名事实仍锚定在每个 task 自己的 anchorFragments 上（成员层，Task 6 持久化）
    expect(plan.orderedTaskKeys).toHaveLength(3);
    expect(plan.inputBudgetSnapshot.primaryUtf8Bytes).toBe(3000);
    expect(plan.inputBudgetSnapshot.regionCount).toBe(6);
  });

  it("does not renumber T aliases after an unbatchable task", () => {
    const allocation = planBehaviorExecutionBatches({
      manifestHash: MANIFEST_HASH,
      tasks: [
        planTask("task|a"),
        planTask("task|b"),
        planTask("task|c", { primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1 }),
        planTask("task|d"),
        planTask("task|e"),
      ],
    });
    expect(allocation.batchPlans).toHaveLength(2);
    expect(allocation.batchPlans[0]!.orderedTaskKeys).toEqual(["task|a", "task|b"]);
    expect(allocation.batchPlans[0]!.taskAliasMap).toEqual({ "task|a": "T1", "task|b": "T2" });
    // fallback 之后的新 batch 使用自己的局部 T 序列，不延续也不重排前面的别名
    expect(allocation.batchPlans[1]!.orderedTaskKeys).toEqual(["task|d", "task|e"]);
    expect(allocation.batchPlans[1]!.taskAliasMap).toEqual({ "task|d": "T1", "task|e": "T2" });
    expect(allocation.fallbackAssignments).toEqual([{ taskKey: "task|c", reason: "oversized" }]);
  });

  it("assigns every manifest task exactly once across batch and fallback", () => {
    const tasks = [
      planTask("task|a"),
      planTask("task|b"),
      planTask("task|c", { primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1 }),
      planTask("task|d", { hasBlankFragment: true }),
      planTask("task|e", { supportedShape: false }),
      planTask("task|f", { regions: BATCH_MAX_REGIONS + 1 }),
      planTask("task|g", { isResidual: false, primaryPath: "src/other/g.ts" }),
    ];
    const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks });
    const routedList = [
      ...allocation.batchPlans.flatMap((plan) => plan.orderedTaskKeys),
      ...allocation.fallbackAssignments.map((assignment) => assignment.taskKey),
    ];
    const manifestKeys = new Set(tasks.map((task) => task.task.taskKey));
    expect(new Set(routedList)).toEqual(manifestKeys);
    expect(routedList).toHaveLength(manifestKeys.size);
  });

  it("keeps oversized blank fragment and unsupported shapes on stable fallback routes with stable reasons", () => {
    const allocation = planBehaviorExecutionBatches({
      manifestHash: MANIFEST_HASH,
      tasks: [
        planTask("task|bytes", { primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1 }),
        planTask("task|regions", { regions: BATCH_MAX_REGIONS + 1 }),
        planTask("task|blank", { hasBlankFragment: true }),
        planTask("task|shape", { supportedShape: false }),
        // 多重原因时按冻结优先级取唯一 reason：oversized > blank_fragment > unsupported_task_shape
        planTask("task|multi", {
          primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1,
          hasBlankFragment: true,
          supportedShape: false,
        }),
      ],
    });
    expect(allocation.batchPlans).toEqual([]);
    expect(allocation.fallbackAssignments).toEqual([
      { taskKey: "task|blank", reason: "blank_fragment" },
      { taskKey: "task|bytes", reason: "oversized" },
      { taskKey: "task|multi", reason: "oversized" },
      { taskKey: "task|regions", reason: "oversized" },
      { taskKey: "task|shape", reason: "unsupported_task_shape" },
    ]);
  });

  it("includes batch and fallback assignments in a stable plan set fingerprint", () => {
    const build = () =>
      planBehaviorExecutionBatches({
        manifestHash: MANIFEST_HASH,
        tasks: [planTask("task|a"), planTask("task|b"), planTask("task|c", { hasBlankFragment: true })],
      });
    const base = build();
    expect(build().planSetFingerprint).toBe(base.planSetFingerprint);
    // fallback 路由变化（blank → unsupported）→ 指纹变
    const changedFallback = planBehaviorExecutionBatches({
      manifestHash: MANIFEST_HASH,
      tasks: [planTask("task|a"), planTask("task|b"), planTask("task|c", { supportedShape: false })],
    });
    expect(changedFallback.planSetFingerprint).not.toBe(base.planSetFingerprint);
    // batch 成员变化 → 指纹变
    const changedBatch = planBehaviorExecutionBatches({
      manifestHash: MANIFEST_HASH,
      tasks: [
        planTask("task|a"),
        planTask("task|b", { primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1 }),
        planTask("task|c", { hasBlankFragment: true }),
      ],
    });
    expect(changedBatch.planSetFingerprint).not.toBe(base.planSetFingerprint);
    // manifest 变化 → 指纹变
    const changedManifest = planBehaviorExecutionBatches({
      manifestHash: "m2".padEnd(64, "0"),
      tasks: [planTask("task|a"), planTask("task|b"), planTask("task|c", { hasBlankFragment: true })],
    });
    expect(changedManifest.planSetFingerprint).not.toBe(base.planSetFingerprint);
  });

  it("is deterministic across equivalent input ordering", () => {
    const tasks = [
      planTask("task|a"),
      planTask("task|b"),
      planTask("task|c", { primaryUtf8Bytes: BATCH_MAX_PRIMARY_UTF8_BYTES + 1 }),
      planTask("task|d", { hasBlankFragment: true }),
      planTask("task|e"),
      planTask("task|f"),
    ];
    const one = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks });
    const two = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: [...tasks].reverse() });
    expect(two).toEqual(one);
  });
});

import { describe, expect, it } from "vitest";
import type { Execute } from "../lib/db";
import { makeBatchKey } from "../lib/execution-batch/identity";
import { planBehaviorExecutionBatches, type PlanTaskInput } from "../lib/execution-batch/planner";
import { loadReadyBehaviorBatchAllocation, publishBehaviorBatchPlanSet } from "../lib/execution-batch/plans";

const RUN_ID = 91;
const MANIFEST_HASH = "m".repeat(64);

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

function planTask(taskKey: string, options: { primaryUtf8Bytes?: number; hasBlankFragment?: boolean } = {}): PlanTaskInput {
  return {
    task: {
      taskKey,
      unitKey: `unit|${taskKey}`,
      anchorFragments: [
        { anchorKey: `anchor|${taskKey}`, anchorFragmentKey: `fragment|${taskKey}#0`, ranges: [{ startLine: 1, endLine: 9 }] },
      ],
    },
    isResidual: true,
    primaryPath: "src/a.ts",
    primaryUtf8Bytes: options.primaryUtf8Bytes ?? 1000,
    hasBlankFragment: options.hasBlankFragment ?? false,
    supportedShape: true,
  };
}

function buildAllocation() {
  return planBehaviorExecutionBatches({
    manifestHash: MANIFEST_HASH,
    tasks: [planTask("task|a"), planTask("task|b"), planTask("task|c", { primaryUtf8Bytes: 40_000 })],
  });
}

function manifestKeysOf(allocation: ReturnType<typeof buildAllocation>): string[] {
  return [...allocation.batchPlans.flatMap((plan) => plan.orderedTaskKeys), ...allocation.fallbackAssignments.map((fallback) => fallback.taskKey)].sort();
}

/** 与仓库 fake 风格一致的语句前缀匹配内存库：只覆盖 plans.ts 用到的 SQL 面。 */
function createPlansDb() {
  const planSets: PlanSetRow[] = [];
  const plans: PlanRow[] = [];
  const statements: string[] = [];
  const state = { loseReadyRace: false };
  const clone = <T>(row: T): T => JSON.parse(JSON.stringify(row)) as T;
  const execute: Execute = async (statement, parameters) => {
    statements.push(statement);
    const params = parameters as unknown[];
    if (statement.startsWith("INSERT INTO analysis_behavior_batch_plan_sets")) {
      planSets.push({
        run_id: params[0] as number,
        plan_set_id: params[1] as string,
        plan_set_fingerprint: params[2] as string,
        planner_version: params[3] as string,
        expected_plan_count: params[4] as number,
        expected_task_count: params[5] as number,
        publish_status: "building",
        fallback_assignments: params[6] as string,
      });
      return [{ insertId: planSets.length }];
    }
    if (statement.startsWith("INSERT INTO analysis_behavior_batch_plans")) {
      plans.push({
        run_id: params[0] as number,
        plan_set_id: params[1] as string,
        batch_key: params[2] as string,
        manifest_hash: params[3] as string,
        planner_version: params[4] as string,
        ordered_task_keys: params[5] as string,
        task_alias_map: params[6] as string,
        grouping_rules_fingerprint: params[7] as string,
        input_budget_snapshot: params[8] as string,
      });
      return [{ insertId: plans.length }];
    }
    if (statement.startsWith("UPDATE analysis_behavior_batch_plan_sets SET publish_status = 'ready'")) {
      if (state.loseReadyRace) return [{ affectedRows: 0 }];
      const row = planSets.find(
        (candidate) => candidate.run_id === params[0] && candidate.plan_set_id === params[1] && candidate.publish_status === "building",
      );
      if (!row) return [{ affectedRows: 0 }];
      row.publish_status = "ready";
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("FROM analysis_behavior_batch_plan_sets") && statement.includes("publish_status = 'ready'")) {
      const ready = planSets.filter((row) => row.run_id === params[0] && row.publish_status === "ready");
      return [ready.length > 0 ? [clone(ready[ready.length - 1]!)] : []];
    }
    if (statement.includes("FROM analysis_behavior_batch_plan_sets") && statement.includes("plan_set_id = ?")) {
      return [planSets.filter((row) => row.run_id === params[0] && row.plan_set_id === params[1]).map(clone)];
    }
    if (statement.includes("FROM analysis_behavior_batch_plan_sets")) {
      return [planSets.filter((row) => row.run_id === params[0]).map(clone)];
    }
    if (statement.includes("FROM analysis_behavior_batch_plans")) {
      const rows = plans
        .filter((row) => row.run_id === params[0] && row.plan_set_id === params[1])
        .map(clone)
        .sort((a, b) => (a.batch_key < b.batch_key ? -1 : 1));
      return [rows];
    }
    throw new Error(`unexpected statement: ${statement}`);
  };
  return { execute, planSets, plans, statements, state };
}

describe("execution batch plan set publication", () => {
  it("only ready plan set is executable", async () => {
    const db = createPlansDb();
    const allocation = buildAllocation();
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_plan_set_not_ready",
    });
    const published = await publishBehaviorBatchPlanSet(db.execute, {
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      manifestTaskKeys: manifestKeysOf(allocation),
      allocation,
    });
    expect(published.status).toBe("ready");
    const loaded = await loadReadyBehaviorBatchAllocation(db.execute, RUN_ID);
    expect(loaded.planSetFingerprint).toBe(allocation.planSetFingerprint);
    expect(loaded.batchPlans[0]!.runId).toBe(RUN_ID);
    expect(loaded.fallbackAssignments).toEqual(allocation.fallbackAssignments);
    // building 行不可执行：状态被改回 building 后 load 必须拒绝
    db.planSets[0]!.publish_status = "building";
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_plan_set_not_ready",
    });
  });

  it("publishes building set after count uniqueness and fingerprint validation", async () => {
    const db = createPlansDb();
    const allocation = buildAllocation();
    await publishBehaviorBatchPlanSet(db.execute, {
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      manifestTaskKeys: manifestKeysOf(allocation),
      allocation,
    });
    expect(db.planSets).toHaveLength(1);
    expect(db.planSets[0]!.publish_status).toBe("ready");
    expect(db.planSets[0]!.fallback_assignments).toBe(JSON.stringify(allocation.fallbackAssignments));
    expect(db.plans).toHaveLength(allocation.batchPlans.length);
    // 语句顺序：读校验全部发生在条件更新 ready 之前，且只有一次 ready 更新
    const shape = db.statements
      .map((statement) => (statement.startsWith("INSERT") ? "I" : statement.startsWith("UPDATE") ? "U" : "S"))
      .join("");
    expect(shape.startsWith("S")).toBe(true);
    expect(shape.endsWith("U")).toBe(true);
    expect(db.statements.filter((statement) => statement.startsWith("UPDATE"))).toHaveLength(1);
  });

  it("rejects missing extra or reordered plan members", async () => {
    const db = createPlansDb();
    const allocation = buildAllocation();
    const keys = manifestKeysOf(allocation);
    // missing：manifest 声明了 allocation 未路由的 task → 发布前拒绝，零落库
    await expect(
      publishBehaviorBatchPlanSet(db.execute, {
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        manifestTaskKeys: [...keys, "task|missing"],
        allocation,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_allocation_mismatch" });
    // extra：allocation 路由了 manifest 之外的 task → 同样拒绝
    await expect(
      publishBehaviorBatchPlanSet(db.execute, {
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        manifestTaskKeys: keys.slice(0, -1),
        allocation,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_allocation_mismatch" });
    expect(db.planSets).toHaveLength(0);
    expect(db.plans).toHaveLength(0);

    // reordered：持久化后改写成员顺序 → load 时重算 batch_key 不符，版本冲突
    const published = await publishBehaviorBatchPlanSet(db.execute, {
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      manifestTaskKeys: keys,
      allocation,
    });
    const firstPlan = db.plans.find((row) => row.plan_set_id === published.planSetId)!;
    firstPlan.ordered_task_keys = JSON.stringify([...JSON.parse(firstPlan.ordered_task_keys)].reverse());
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
  });

  it("does not rebuild an old plan set with a new planner version", async () => {
    const db = createPlansDb();
    const allocation = buildAllocation();
    const keys = manifestKeysOf(allocation);
    const published = await publishBehaviorBatchPlanSet(db.execute, {
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      manifestTaskKeys: keys,
      allocation,
    });
    // 同 run 二次发布被拒——planner 升级不重建旧 run 的 plan set
    await expect(
      publishBehaviorBatchPlanSet(db.execute, {
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        manifestTaskKeys: keys,
        allocation,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_plan_set_exists" });
    await expect(
      publishBehaviorBatchPlanSet(db.execute, {
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        plannerVersion: "2",
        manifestTaskKeys: keys,
        allocation,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_plan_set_exists" });
    expect(db.planSets).toHaveLength(1);
    // 恢复使用 plan set 自身冻结的 planner_version：改写持久化版本 → 重算指纹/batch_key 不符 → 冲突
    db.planSets[0]!.planner_version = "2";
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    expect(published.plannerVersion).toBe("1");
  });

  it("rejects drifted persisted plan sets instead of re-planning (recovery guards)", async () => {
    const db = createPlansDb();
    const allocation = buildAllocation();
    await publishBehaviorBatchPlanSet(db.execute, {
      runId: RUN_ID,
      manifestHash: MANIFEST_HASH,
      manifestTaskKeys: manifestKeysOf(allocation),
      allocation,
    });
    // plan 数量漂移（声明与落库不一致）
    db.planSets[0]!.expected_plan_count = 99;
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    db.planSets[0]!.expected_plan_count = allocation.batchPlans.length;
    // plan 行丢失
    db.plans.pop();
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    db.plans.push({
      run_id: RUN_ID,
      plan_set_id: db.planSets[0]!.plan_set_id,
      batch_key: allocation.batchPlans[0]!.batchKey,
      manifest_hash: MANIFEST_HASH,
      planner_version: "1",
      ordered_task_keys: JSON.stringify(allocation.batchPlans[0]!.orderedTaskKeys),
      task_alias_map: JSON.stringify(allocation.batchPlans[0]!.taskAliasMap),
      grouping_rules_fingerprint: allocation.batchPlans[0]!.groupingRulesFingerprint,
      input_budget_snapshot: JSON.stringify(allocation.batchPlans[0]!.inputBudgetSnapshot),
    });
    // 混入不同 manifest 的 plan（batch_key 按篡改后 manifest 重算一致，触发混源守卫）
    const victim = db.plans[0]!;
    victim.manifest_hash = "9".repeat(64);
    victim.batch_key = makeBatchKey({
      manifestHash: victim.manifest_hash,
      plannerVersion: victim.planner_version,
      orderedTaskKeys: JSON.parse(victim.ordered_task_keys),
      groupingRulesFingerprint: victim.grouping_rules_fingerprint,
    });
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    victim.manifest_hash = MANIFEST_HASH;
    victim.batch_key = allocation.batchPlans[0]!.batchKey;
    // T 别名映射与成员脱钩
    victim.task_alias_map = JSON.stringify({ "task|a": "T9" });
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    victim.task_alias_map = JSON.stringify(allocation.batchPlans[0]!.taskAliasMap);
    // set 指纹被改写（逐 plan 校验全过后仍被指纹守卫拦截）
    db.planSets[0]!.plan_set_fingerprint = "8".repeat(64);
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).rejects.toMatchObject({
      code: "execution_batch_version_conflict",
    });
    db.planSets[0]!.plan_set_fingerprint = allocation.planSetFingerprint;
    await expect(loadReadyBehaviorBatchAllocation(db.execute, RUN_ID)).resolves.toBeTruthy();
  });

  it("does not flip ready when the conditional update loses the race", async () => {
    const db = createPlansDb();
    db.state.loseReadyRace = true;
    const allocation = buildAllocation();
    await expect(
      publishBehaviorBatchPlanSet(db.execute, {
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        manifestTaskKeys: manifestKeysOf(allocation),
        allocation,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_version_conflict" });
    expect(db.planSets[0]!.publish_status).toBe("building");
    expect(db.plans).toHaveLength(allocation.batchPlans.length);
  });
});

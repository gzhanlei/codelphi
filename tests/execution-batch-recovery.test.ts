import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Utf8 } from "../lib/execution-batch/identity";
import { recoverInventoryBatchAttempts } from "../lib/execution-batch/runner";
import {
  acquireBatchAttemptProcessing,
  loadBatchAttemptForRecovery,
} from "../lib/execution-batch/attempts";
import { ExecutionBatchError } from "../lib/execution-batch/plans";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import { planBehaviorExecutionBatches } from "../lib/execution-batch/planner";

/**
 * Task 10 恢复验收门禁（§16/§20.2 集成面）：聚焦跨模块故障注入场景——
 * 恢复竞争 fencing、已持久化响应 + 他方完成跳过、主批结算后 repair 崩溃零重复、
 * T/R 别名漂移拒绝解释。单模块面（请求八态、读回校验、回执冲突矩阵、事务原子性、
 * 成员冻结/零成员 aborted）由各自单元套件证明，此处不重复。
 * 计划的 helpers.ts 共享件以「从 runner 门禁文件导出 fake」的形态落地（偏差：为避免
 * vi.hoisted 跨文件导出的 vitest 限制，共享面 = runner.test.ts 的导出段），本文件
 * 自带一份聚焦恢复路径的精简 fake，保证门禁可独立重复运行。
 */

const RUN_ID = 71;
const MANIFEST_HASH = "m".repeat(64);
const BATCH_KEY = "b".repeat(64);

vi.mock("../lib/db", () => ({
  getDb: () => recoveryHolder.getDbImpl(),
  defaultExecute: (sql: string, params: Array<string | number | null>) => recoveryHolder.router!(sql, params),
}));

const recoveryHolder = vi.hoisted(() => ({
  router: null as unknown as ((sql: string, params: unknown[]) => Promise<unknown>) | null,
  getDbImpl: null as unknown as () => unknown,
}));

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

function clone<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

interface AttemptRow { run_id: number; batch_attempt_uuid: string; batch_key: string; reservation_uuid: string; model_config_fingerprint: string; prompt_version: string; schema_version: string; parser_version: string; execution_phase: string; members_frozen_at: string | null; accepted_describe_request_key: string | null; accepted_judge_request_key: string | null; terminal_request_key: string | null; processing_owner: string | null; processing_lease_expires_at: string | null; version: number; }
interface MemberRow { run_id: number; batch_attempt_uuid: string; task_key: string; task_key_hash: string; request_task_attempt_id: string; request_lease_identity: string; task_alias: string; ordered_region_aliases: string; }
interface RequestRow { request_key: string; batch_attempt_uuid: string; request_stage: string; request_sequence: number; request_fingerprint: string; describe_response_hash: string | null; provider_request_id: string | null; request_outcome: string; failure_class: string | null; raw_response: string | null; response_byte_length: number | null; stored_byte_length: number | null; response_hash: string | null; provider_finish_reason: string | null; }
interface ReceiptRow { run_id: number; attempt_id: string | null; outcome: string; usage_status: string; pricing_status: string; input_tokens: number | null; output_tokens: number | null; llm_cost_amount: string | null; }
interface TaskRow { run_id: number; task_key: string; task_key_hash: string; status: string; attempts: number; attempt_id: string | null; lease_owner: string | null; lease_expires_at_ms: number | null; result_json: string | null; unit_key: string; kind: string; primary_path: string; anchor_fragments: string; detector: string; detector_version: string; }
interface ReservationRow { reservation_uuid: string; run_id: number; attempt_id: string; kind: string; reserved_llm_calls: number; reserved_input_tokens: number; reserved_output_tokens: number; reserved_cost_micros: number; status: string; }

interface RecoveryState {
  attempts: AttemptRow[];
  members: MemberRow[];
  requests: RequestRow[];
  receipts: ReceiptRow[];
  tasks: TaskRow[];
  reservations: ReservationRow[];
  planSets: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
}

const state: RecoveryState = {
  attempts: [],
  members: [],
  requests: [],
  receipts: [],
  tasks: [],
  reservations: [],
  planSets: [],
  plans: [],
};

function taskRow(taskKey: string): TaskRow {
  return {
    run_id: RUN_ID,
    task_key: taskKey,
    task_key_hash: sha256Utf8(taskKey),
    status: "pending",
    attempts: 0,
    attempt_id: null,
    lease_owner: null,
    lease_expires_at_ms: null,
    result_json: null,
    unit_key: `unit|${taskKey}`,
    kind: "http",
    primary_path: `src/${taskKey.replace(/[|]/g, "-")}.ts`,
    anchor_fragments: JSON.stringify([{ anchorKey: `anchor|${taskKey}#0`, anchorFragmentKey: `fragment|${taskKey}#0`, ranges: [{ startLine: 1, endLine: 9 }] }]),
    detector: "http",
    detector_version: "1",
  };
}

function planInputFor(taskKey: string): import("../lib/execution-batch/planner").PlanTaskInput {
  const task = makeTask(taskKey);
  return { task, isResidual: true, primaryPath: `src/${taskKey.replace(/[|]/g, "-")}.ts`, primaryUtf8Bytes: 100, hasBlankFragment: false, supportedShape: true };
}

function makeTask(taskKey: string): BehaviorExecutionTask {
  const row = taskRow(taskKey);
  return { taskKey, unitKey: row.unit_key, anchorFragments: JSON.parse(row.anchor_fragments) };
}

const sources = (taskKey: string) => [
  { path: `src/${taskKey.replace(/[|]/g, "-")}.ts`, role: "primary" as const, content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 },
];

function seedAttempt(uuid: string, phase: string, batchKey = BATCH_KEY, overrides: Partial<AttemptRow> = {}): AttemptRow {
  const row: AttemptRow = {
    run_id: RUN_ID,
    batch_attempt_uuid: uuid,
    batch_key: batchKey,
    reservation_uuid: `res-${uuid}`,
    model_config_fingerprint: "m",
    prompt_version: "1",
    schema_version: "1",
    parser_version: "1",
    execution_phase: phase,
    members_frozen_at: mysqlDatetime(Date.now()),
    accepted_describe_request_key: null,
    accepted_judge_request_key: null,
    terminal_request_key: null,
    processing_owner: null,
    processing_lease_expires_at: null,
    version: 1,
    ...overrides,
  };
  state.attempts.push(row);
  return row;
}

function seedMember(uuid: string, taskKey: string, alias: string, aliases = "R1"): MemberRow {
  const row: MemberRow = {
    run_id: RUN_ID,
    batch_attempt_uuid: uuid,
    task_key: taskKey,
    task_key_hash: sha256Utf8(taskKey),
    request_task_attempt_id: `task-attempt-${taskKey}`,
    request_lease_identity: "worker-old",
    task_alias: alias,
    ordered_region_aliases: JSON.stringify(aliases.split(",").map((alias2, index) => ({ anchorFragmentKey: `fragment|${taskKey}#${index}`, regionAlias: alias2.trim() }))),
  };
  state.members.push(row);
  return row;
}

function seedPersistedResponses(uuid: string, describeRaw: string, judgeRaw: string | null): void {
  state.requests.push({ request_key: `${uuid}|describe|1`, batch_attempt_uuid: uuid, request_stage: "describe", request_sequence: 1, request_fingerprint: "f", describe_response_hash: null, provider_request_id: "gw", request_outcome: "response_persisted", failure_class: null, raw_response: describeRaw, response_byte_length: 10, stored_byte_length: 10, response_hash: "h", provider_finish_reason: null });
  if (judgeRaw !== null) {
    state.requests.push({ request_key: `${uuid}|judge|1`, batch_attempt_uuid: uuid, request_stage: "judge", request_sequence: 1, request_fingerprint: "f", describe_response_hash: "h", provider_request_id: "gw", request_outcome: "response_persisted", failure_class: null, raw_response: judgeRaw, response_byte_length: 10, stored_byte_length: 10, response_hash: "h", provider_finish_reason: null });
  }
}

function seedPlanSet(): string {
  // 指纹必须与持久化行重算一致：从真实 planner 产出种子（防"seeded"假指纹被 validate 拒绝）
  const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: [planInputFor("task|one")] });
  const plan = allocation.batchPlans[0]!;
  state.planSets.push({ run_id: RUN_ID, plan_set_id: "ps-1", plan_set_fingerprint: allocation.planSetFingerprint, planner_version: "1", expected_plan_count: allocation.batchPlans.length, expected_task_count: 1, publish_status: "ready", fallback_assignments: JSON.stringify(allocation.fallbackAssignments) });
  state.plans.push({ run_id: RUN_ID, plan_set_id: "ps-1", batch_key: plan.batchKey, manifest_hash: MANIFEST_HASH, planner_version: "1", ordered_task_keys: JSON.stringify(plan.orderedTaskKeys), task_alias_map: JSON.stringify(plan.taskAliasMap), grouping_rules_fingerprint: plan.groupingRulesFingerprint, input_budget_snapshot: JSON.stringify(plan.inputBudgetSnapshot) });
  return plan.batchKey;
}

const judgeExtracted = (taskKey: string) =>
  JSON.stringify({ tasks: [{ id: "T1", regions: [{ id: "R1", disposition: "extracted", evidence: [{ path: `src/${taskKey.replace(/[|]/g, "-")}.ts`, startLine: 2 }], scenarioRefs: ["HP-1"] }], features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: `src/${taskKey.replace(/[|]/g, "-")}.ts`, startLine: 2 }] }] }] }] });
const describeFor = (taskKey: string) =>
  JSON.stringify({ tasks: [{ id: "T1", regions: [{ id: "R1", facts: `${taskKey} facts`, inputs: "", controlFlow: "", externalEffects: "" }] }] });

const router = async (sql: string, rawParams: unknown[]): Promise<unknown> => {
  const params = rawParams as Array<string | number | null>;
  const normalized = String(sql).replace(/\s+/g, " ").trim();
  if (normalized.includes("execution_phase IN ('describe_persisted', 'judge_persisted', 'splitting')")) {
    const found = state.attempts.filter(
      (row) => row.run_id === Number(params[0]) && row.batch_key === String(params[1]) && ["describe_persisted", "judge_persisted", "splitting"].includes(row.execution_phase),
    );
    return [found.map(clone)];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_batch_attempts")) {
    return [state.attempts.filter((row) => row.run_id === Number(params[0]) && row.batch_attempt_uuid === String(params[1])).map(clone)];
  }
  if (normalized.includes("SET processing_owner = ?")) {
    const owner = String(params[0]);
    const expiresAt = String(params[1]);
    const runId = Number(params[2]);
    const uuid = String(params[3]);
    const cutoff = String(params[5]);
    const row = state.attempts.find((candidate) => candidate.run_id === runId && candidate.batch_attempt_uuid === uuid);
    if (!row) return [{ affectedRows: 0 }];
    const free = row.processing_owner === null || row.processing_owner === owner || (row.processing_lease_expires_at !== null && row.processing_lease_expires_at < cutoff);
    if (!free) return [{ affectedRows: 0 }];
    row.processing_owner = owner;
    row.processing_lease_expires_at = expiresAt;
    row.version += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET execution_phase = ?")) {
    const [phase, terminalKey, runId, uuid, fromPhase, version, owner] = params as [string, string | null, number, string, string, number, string];
    const row = state.attempts.find((candidate) => candidate.run_id === Number(runId) && candidate.batch_attempt_uuid === String(uuid));
    if (!row) return [{ affectedRows: 0 }];
    if (row.execution_phase !== fromPhase || row.version !== Number(version) || row.processing_owner !== owner) return [{ affectedRows: 0 }];
    row.execution_phase = phase;
    row.terminal_request_key = terminalKey;
    row.version += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ?")) {
    return [state.members.filter((row) => row.batch_attempt_uuid === String(params[0])).map(clone)];
  }
  if (normalized.includes("FROM analysis_behavior_batch_plan_sets") && normalized.includes("publish_status = 'ready'")) {
    const ready = state.planSets.filter((row) => row.run_id === Number(params[0]) && row.publish_status === "ready");
    return [ready.length > 0 ? [clone(ready[ready.length - 1]!)] : []];
  }
  if (normalized.includes("FROM analysis_behavior_batch_plan_sets")) {
    return [state.planSets.filter((row) => row.run_id === Number(params[0])).map(clone)];
  }
  if (normalized.includes("FROM analysis_behavior_batch_plans")) {
    return [state.plans.filter((row) => row.run_id === Number(params[0]) && row.plan_set_id === String(params[1])).map(clone)];
  }
  if (normalized.startsWith("SELECT request_stage, raw_response") && normalized.includes("request_outcome = 'response_persisted'")) {
    const persisted = state.requests.filter((row) => row.batch_attempt_uuid === String(params[0]) && row.request_outcome === "response_persisted").map(clone);
    const describe = persisted.find((row) => row.request_stage === "describe");
    const judge = persisted.find((row) => row.request_stage === "judge");
    return [[
      { request_stage: "describe", raw_response: describe?.raw_response ?? null, provider_finish_reason: describe?.provider_finish_reason ?? null },
      { request_stage: "judge", raw_response: judge?.raw_response ?? null, provider_finish_reason: judge?.provider_finish_reason ?? null },
    ]];
  }
  if (normalized.startsWith("SELECT (max_llm_calls = 2147483647)")) {
    return [[{ calls_uncapped: 1, tokens_uncapped: 1, cost_uncapped: 1 }]];
  }
  if (normalized.includes("FROM llm_call_receipts WHERE run_id = ? AND attempt_id = ?")) {
    return [state.receipts.filter((row) => row.run_id === Number(params[0]) && row.attempt_id === String(params[1])).map(clone)];
  }
  if (normalized.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?") && normalized.includes("settled_llm_calls = settled_llm_calls + ?")) {
    const [rCalls, rIn, rOut, rCost, sCalls, sIn, sOut, sCost, runId] = params;
    const reservation = state.reservations.find((row) => row.run_id === Number(runId) && row.status === "reserved");
    if (!reservation) return [{ affectedRows: 0 }];
    reservation.reserved_llm_calls -= Number(rCalls);
    reservation.reserved_input_tokens -= Number(rIn);
    reservation.reserved_output_tokens -= Number(rOut);
    reservation.reserved_cost_micros -= Math.round(Number(rCost) * 1_000_000);
    reservation.status = "settled";
    void sCalls; void sIn; void sOut; void sCost;
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?")) {
    const reservation = state.reservations.find((row) => row.run_id === Number(params[4]) && row.status === "reserved");
    if (!reservation) return [{ affectedRows: 0 }];
    reservation.status = "released";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("FROM analysis_behavior_budget_reservations WHERE reservation_uuid = ? FOR UPDATE")) {
    const found = state.reservations.find((row) => row.reservation_uuid === String(params[0]));
    return [found ? [clone(found)] : []];
  }
  if (normalized.startsWith("UPDATE analysis_behavior_budget_reservations SET status = ?")) {
    const [status, uuid] = params;
    const found = state.reservations.find((row) => row.reservation_uuid === String(uuid));
    if (!found || found.status !== "reserved") return [{ affectedRows: 0 }];
    found.status = String(status);
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("UPDATE analysis_behavior_tasks") && normalized.includes("SET status = 'running'")) {
    const [leaseOwner, expiresAt, attemptId, runId, hash, maxAttempts, now] = params as [string, string, string, number, string, number, string];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row) return [{ affectedRows: 0 }];
    const claimable =
      row.status === "pending" ||
      ((row.status === "failed" || row.status === "unresolved") && row.attempts < Number(maxAttempts)) ||
      (row.status === "running" && row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= Date.parse(now.replace(" ", "T") + "Z"));
    if (!claimable) return [{ affectedRows: 0 }];
    row.status = "running";
    row.lease_owner = String(leaseOwner);
    row.lease_expires_at_ms = Date.parse(expiresAt.replace(" ", "T") + "Z");
    row.attempt_id = String(attemptId);
    row.attempts += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("UPDATE analysis_behavior_tasks") && normalized.includes("SET status = ?")) {
    const [status, resultJson, , , , runId, hash, attemptId, leaseOwner] = params as [string, string, number, number, number, number, string, string, string];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row || row.status !== "running" || row.attempt_id !== String(attemptId) || row.lease_owner !== String(leaseOwner)) return [{ affectedRows: 0 }];
    row.status = String(status);
    row.result_json = String(resultJson);
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_tasks")) {
    return [state.tasks.filter((row) => row.run_id === Number(params[0]) && row.task_key_hash === String(params[1])).map(clone)];
  }
  throw new Error(`unexpected statement: ${sql}`);
};

function installRecoveryDb(): void {
  recoveryHolder.router = router;
  recoveryHolder.getDbImpl = () => ({
    execute: (sql: string, params: Array<string | number | null>) => recoveryHolder.router!(sql, params),
    getConnection: async () => ({
      beginTransaction: async () => undefined,
      execute: (sql: string, params: Array<string | number | null>) => recoveryHolder.router!(sql, params),
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    }),
  });
}

const recoverConfig = (overrides: Partial<Parameters<typeof recoverInventoryBatchAttempts>[0]> = {}) => ({
  runId: RUN_ID,
  accountId: 7,
  manifestHash: MANIFEST_HASH,
  chargeComponent: "main" as const,
  leaseOwner: "worker-2",
  leaseDurationMs: 60_000,
  maxAttempts: 3,
  loadSources: async (task: BehaviorExecutionTask) => sources(task.taskKey),
  tasks: [makeTask("task|one")],
  ...overrides,
});

describe("execution batch recovery gate (Task 10)", () => {
  beforeEach(() => {
    state.attempts = [];
    state.members = [];
    state.requests = [];
    state.receipts = [];
    state.tasks = [taskRow("task|one")];
    state.reservations = [];
    state.planSets = [];
    state.plans = [];
    installRecoveryDb();
  });

  it("expired processing lease takeover is exclusive: the second concurrent worker loses", async () => {
    const attempt = seedAttempt("11111111-2222-4222-8222-222222222222", "splitting", BATCH_KEY);
    const row = state.attempts[0]!;
    row.processing_owner = "worker-old";
    row.processing_lease_expires_at = mysqlDatetime(Date.now() - 1_000);
    const [first, second] = await Promise.allSettled([
      acquireBatchAttemptProcessing({ runId: RUN_ID, batchAttemptUuid: attempt.batch_attempt_uuid, processingOwner: "worker-a", leaseDurationMs: 60_000 }),
      acquireBatchAttemptProcessing({ runId: RUN_ID, batchAttemptUuid: attempt.batch_attempt_uuid, processingOwner: "worker-b", leaseDurationMs: 60_000 }),
    ]);
    const winners = [first, second].filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const winner = (winners[0] as PromiseFulfilledResult<{ processingOwner: string }>).value;
    expect(state.attempts[0]!.processing_owner).toBe(winner.processingOwner);
    expect(state.attempts[0]!.version).toBe(2);
    const losers = [first, second].filter((result) => result.status === "rejected");
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(ExecutionBatchError);
  });

  it("recovery skips a task already completed by another legitimate attempt instead of overwriting", async () => {
    seedAttempt("22222222-2222-4222-8222-222222222222", "judge_persisted", seedPlanSet());
    seedMember("22222222-2222-4222-8222-222222222222", "task|one", "T1");
    seedPersistedResponses("22222222-2222-4222-8222-222222222222", describeFor("task|one"), judgeExtracted("task|one"));
    // 他方合法 attempt 已把任务提交为 extracted（result_json 保留他方产物）
    const task = state.tasks[0]!;
    task.status = "extracted";
    task.result_json = JSON.stringify({ outcome: "extracted", fromAnotherAttempt: true });
    task.attempt_id = "other-attempt";
    task.lease_owner = "other-worker";
    await recoverInventoryBatchAttempts(recoverConfig());
    const attempt = state.attempts[0]!;
    expect(attempt.execution_phase).toBe("split_done");
    // 他方结果不被覆盖
    expect(JSON.parse(task.result_json!).fromAnotherAttempt).toBe(true);
  });

  it("recovery re-claims an expired lease and commits persisted judge results with zero model calls", async () => {
    seedAttempt("33333333-2222-4222-8222-222222222222", "judge_persisted", seedPlanSet());
    seedMember("33333333-2222-4222-8222-222222222222", "task|one", "T1");
    seedPersistedResponses("33333333-2222-4222-8222-222222222222", describeFor("task|one"), judgeExtracted("task|one"));
    let dispatchCount = 0;
    await recoverInventoryBatchAttempts(recoverConfig({
      dispatchDetailed: async () => {
        dispatchCount += 1;
        throw new Error("recovery must not dispatch model calls for persisted judge");
      },
    }));
    const attempt = state.attempts[0]!;
    expect(attempt.execution_phase).toBe("split_done");
    expect(dispatchCount).toBe(0);
    // 租约过期 → 恢复按现有协议重新 claim 后提交（零模型调用）
    expect(state.tasks[0]!.status).toBe("extracted");
    expect(state.tasks[0]!.result_json).toContain("extracted");
  });

  it("main batch settled before a repair crash: recovery never re-fetched describe/judge and never activates early", async () => {
    // 主批成功 + repair 派发即崩（repair 属成员级硬失败）→ attempt split_done；
    // 恢复阶段 split_done 不可恢复 → 零新模型调用、任务保持可恢复状态、无激活动作
    seedAttempt("44444444-2222-4222-8222-222222222222", "split_done", seedPlanSet());
    seedMember("44444444-2222-4222-8222-222222222222", "task|one", "T1");
    seedPersistedResponses("44444444-2222-4222-8222-222222222222", describeFor("task|one"), judgeExtracted("task|one"));
    state.receipts.push({ run_id: RUN_ID, attempt_id: "44444444-2222-4222-8222-222222222222", outcome: "success", usage_status: "known", pricing_status: "priced", input_tokens: 100, output_tokens: 50, llm_cost_amount: "0.010000" });
    state.reservations.push({ reservation_uuid: "res-44444444-2222-4222-8222-222222222222", run_id: RUN_ID, attempt_id: "44444444-2222-4222-8222-222222222222", kind: "batch", reserved_llm_calls: 0, reserved_input_tokens: 0, reserved_output_tokens: 0, reserved_cost_micros: 0, status: "settled" });
    state.tasks[0]!.status = "unresolved";
    state.tasks[0]!.attempt_id = "task-attempt-task|one";
    state.tasks[0]!.lease_owner = "worker-old";
    let dispatchCount = 0;
    await recoverInventoryBatchAttempts(recoverConfig({
      dispatchDetailed: async () => {
        dispatchCount += 1;
        throw new Error("no model call allowed");
      },
    }));
    expect(dispatchCount).toBe(0);
    // attempt 保持 split_done（执行终态）；任务未激活（保持 unresolved，等待现有重试语义）
    expect(state.attempts[0]!.execution_phase).toBe("split_done");
    expect(state.tasks[0]!.status).toBe("unresolved");
    // reservation 保持 settled（费用按真实回执结算，不因未提交而释放）
    expect(state.reservations[0]!.status).toBe("settled");
  });

  it("recovery refuses to interpret a member whose persisted R aliases drifted from R numbering", async () => {
    seedAttempt("55555555-2222-4222-8222-222222222222", "judge_persisted", seedPlanSet());
    // 别名漂移：持久化 R2 不在 R 序号位
    seedMember("55555555-2222-4222-8222-222222222222", "task|one", "T1", "R2");
    seedPersistedResponses("55555555-2222-4222-8222-222222222222", describeFor("task|one"), judgeExtracted("task|one"));
    await expect(recoverInventoryBatchAttempts(recoverConfig())).rejects.toMatchObject({
      name: "BatchProtocolError",
    });
  });

  it("unknown usage reservation blocks settlement (fail closed, never zero cost)", async () => {
    seedAttempt("66666666-2222-4222-8222-222222222222", "judge_persisted", seedPlanSet());
    seedMember("66666666-2222-4222-8222-222222222222", "task|one", "T1");
    seedPersistedResponses("66666666-2222-4222-8222-222222222222", describeFor("task|one"), judgeExtracted("task|one"));
    state.reservations.push({ reservation_uuid: "res-66666666-2222-4222-8222-222222222222", run_id: RUN_ID, attempt_id: "66666666-2222-4222-8222-222222222222", kind: "batch", reserved_llm_calls: 2, reserved_input_tokens: 1000, reserved_output_tokens: 500, reserved_cost_micros: 2_000_000, status: "reserved" });
    state.receipts.push({ run_id: RUN_ID, attempt_id: "66666666-2222-4222-8222-222222222222", outcome: "timeout", usage_status: "unknown", pricing_status: "unpriced", input_tokens: null, output_tokens: null, llm_cost_amount: null });
    await recoverInventoryBatchAttempts(recoverConfig());
    // usage unknown 的账务结算：settle 按预留上界入账并 fail closed，绝不 released
    const { settleBehaviorBudget } = await import("../lib/behavior-run-budget");
    await settleBehaviorBudget({ reservationId: "res-66666666-2222-4222-8222-222222222222" });
    expect(state.reservations[0]!.status).toBe("settled_unknown");
  });
});

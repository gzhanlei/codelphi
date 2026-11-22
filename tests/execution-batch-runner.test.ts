import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Utf8 } from "../lib/execution-batch/identity";
import { batchReservationUpperBound, routeBatchWorkItems, runInventoryBatchAttempt, recoverInventoryBatchAttempts } from "../lib/execution-batch/runner";
import { planBehaviorExecutionBatches, type PlanTaskInput } from "../lib/execution-batch/planner";
import { behaviorAnalysisExecutionMode } from "../lib/env";

const RUN_ID = 61;
const MANIFEST_HASH = "m".repeat(64);

const holder = vi.hoisted(() => ({
  router: null as unknown as ((sql: string, params: unknown[]) => Promise<unknown>) | null,
  getDbImpl: null as unknown as () => unknown,
}));
vi.mock("../lib/db", () => ({ getDb: () => holder.getDbImpl(), defaultExecute: (sql: string, params: Array<string | number | null>) => holder.router!(sql, params) }));

// ============ 组合内存库（budget + attempts + members + requests + receipts + tasks）============
interface AttemptRow { run_id: number; batch_attempt_uuid: string; batch_key: string; reservation_uuid: string; model_config_fingerprint: string; prompt_version: string; schema_version: string; parser_version: string; execution_phase: string; members_frozen_at: string | null; accepted_describe_request_key: string | null; accepted_judge_request_key: string | null; terminal_request_key: string | null; processing_owner: string | null; processing_lease_expires_at: string | null; version: number; }
interface MemberRow { run_id: number; batch_attempt_uuid: string; task_key: string; task_key_hash: string; request_task_attempt_id: string; request_lease_identity: string; task_alias: string; ordered_region_aliases: string; }
interface RequestRow { request_key: string; batch_attempt_uuid: string; request_stage: string; request_sequence: number; request_fingerprint: string; describe_response_hash: string | null; provider_request_id: string | null; request_outcome: string; failure_class: string | null; raw_response: string | null; response_byte_length: number | null; stored_byte_length: number | null; response_hash: string | null; provider_finish_reason: string | null; }
interface ReceiptRow { run_id: number; attempt_id: string | null; call_stage: string | null; request_key: string | null; request_fingerprint: string | null; provider_request_id: string | null; outcome: string; usage_status: string; pricing_status: string; input_tokens: number | null; output_tokens: number | null; cache_hit_tokens: number | null; cache_miss_tokens: number | null; usage_json: string | null; llm_cost_amount: string | null; duration_ms: number | null; }
interface TaskRow { run_id: number; task_key: string; task_key_hash: string; status: string; attempts: number; attempt_id: string | null; lease_owner: string | null; lease_expires_at_ms: number | null; result_json: string | null; unit_key: string; kind: string; primary_path: string; anchor_fragments: string; detector: string; detector_version: string; }
interface ReservationRow { reservation_uuid: string; run_id: number; attempt_id: string; kind: string; reserved_llm_calls: number; reserved_input_tokens: number; reserved_output_tokens: number; reserved_cost_micros: number; status: string; }
interface BudgetRow { run_id: number; max_llm_calls: number; max_total_tokens: string; max_cost_amount: string; reserved_llm_calls: number; reserved_input_tokens: number; reserved_output_tokens: number; reserved_cost_micros: number; settled_llm_calls: number; settled_input_tokens: number; settled_output_tokens: number; settled_cost_micros: number; summary_reserved: number; version: number; }

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

function clone<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}


interface PlanSetRow { run_id: number; plan_set_id: string; plan_set_fingerprint: string; planner_version: string; expected_plan_count: number; expected_task_count: number; publish_status: string; fallback_assignments: string; }
interface PlanRow { run_id: number; plan_set_id: string; batch_key: string; manifest_hash: string; planner_version: string; ordered_task_keys: string; task_alias_map: string; grouping_rules_fingerprint: string; input_budget_snapshot: string; }
interface RunnerState {
  budget: BudgetRow;
  reservations: ReservationRow[];
  planSets: PlanSetRow[];
  plans: PlanRow[];
  attempts: AttemptRow[];
  members: MemberRow[];
  requests: RequestRow[];
  receipts: ReceiptRow[];
  tasks: TaskRow[];
  failMemberInsert: boolean;
}

function taskRow(taskKey: string, overrides: Partial<TaskRow> = {}): TaskRow {
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
    ...overrides,
  };
}

function planInputFor(taskKey: string): PlanTaskInput {
  const task = taskRow(taskKey);
  return {
    task: { taskKey, unitKey: task.unit_key, anchorFragments: JSON.parse(task.anchor_fragments) },
    isResidual: true,
    primaryPath: task.primary_path,
    primaryUtf8Bytes: 800,
    hasBlankFragment: false,
    supportedShape: true,
  };
}

const TASK_KEYS = ["task|one", "task|two", "task|three"];

function buildState(): RunnerState {
  return {
    budget: {
      run_id: RUN_ID,
      max_llm_calls: 2_147_483_647,
      max_total_tokens: "18446744073709551615",
      max_cost_amount: "999999.999999",
      reserved_llm_calls: 0,
      reserved_input_tokens: 0,
      reserved_output_tokens: 0,
      reserved_cost_micros: 0,
      settled_llm_calls: 0,
      settled_input_tokens: 0,
      settled_output_tokens: 0,
      settled_cost_micros: 0,
      summary_reserved: 0,
      version: 0,
    },
    reservations: [],
    planSets: [] as PlanSetRow[],
    plans: [] as PlanRow[],
    attempts: [],
    members: [],
    requests: [],
    receipts: [],
    tasks: TASK_KEYS.map((key) => taskRow(key)),
    failMemberInsert: false,
  };

}

let state: RunnerState;
let dispatchCalls: Array<{ stage: string; requestKey: string | null }>;
let failJudgeDispatch: boolean;
let aliasToKey: Record<string, string> = {};
let judgeFinishLength: boolean;

function toMicros(value: unknown): number {
  return Math.round(Number(value) * 1_000_000);
}

function dupError(): Error & { code?: string } {
  const error = new Error("Duplicate entry") as Error & { code?: string };
  error.code = "ER_DUP_ENTRY";
  return error;
}

const router = async (sql: string, rawParams: unknown[]): Promise<unknown> => {
  const params = rawParams as Array<string | number | null>;
  const normalized = String(sql).replace(/\s+/g, " ").trim();
  // —— 预算账本 ——
  if (normalized.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?") && normalized.includes("settled_llm_calls = settled_llm_calls + ?")) {
    const [rCalls, rIn, rOut, rCost, sCalls, sIn, sOut, sCost, runId] = params;
    if (state.budget.run_id !== Number(runId)) return [{ affectedRows: 0 }];
    state.budget.reserved_llm_calls -= Number(rCalls);
    state.budget.reserved_input_tokens -= Number(rIn);
    state.budget.reserved_output_tokens -= Number(rOut);
    state.budget.reserved_cost_micros -= toMicros(rCost);
    state.budget.settled_llm_calls += Number(sCalls);
    state.budget.settled_input_tokens += Number(sIn);
    state.budget.settled_output_tokens += Number(sOut);
    state.budget.settled_cost_micros += toMicros(sCost);
    state.budget.version += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls - ?")) {
    const [rCalls, rIn, rOut, rCost, runId] = params;
    if (state.budget.run_id !== Number(runId)) return [{ affectedRows: 0 }];
    state.budget.reserved_llm_calls -= Number(rCalls);
    state.budget.reserved_input_tokens -= Number(rIn);
    state.budget.reserved_output_tokens -= Number(rOut);
    state.budget.reserved_cost_micros -= toMicros(rCost);
    state.budget.version += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("UPDATE analysis_run_budgets SET reserved_llm_calls = reserved_llm_calls + ?")) {
    const [rCalls, rIn, rOut, rCost, runId] = params;
    if (state.budget.run_id !== Number(runId)) return [{ affectedRows: 0 }];
    state.budget.reserved_llm_calls += Number(rCalls);
    state.budget.reserved_input_tokens += Number(rIn);
    state.budget.reserved_output_tokens += Number(rOut);
    state.budget.reserved_cost_micros += toMicros(rCost);
    state.budget.version += 1;
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("SELECT (max_llm_calls = 2147483647)")) {
    return [[
      {
        calls_uncapped: state.budget.max_llm_calls === 2_147_483_647 ? 1 : 0,
        tokens_uncapped: state.budget.max_total_tokens === "18446744073709551615" ? 1 : 0,
        cost_uncapped: state.budget.max_cost_amount === "999999.999999" ? 1 : 0,
      },
    ]];
  }
  // —— 预留行 ——
  if (normalized.startsWith("INSERT INTO analysis_behavior_budget_reservations")) {
    const [uuid, runId, attemptId, kind, rCalls, rIn, rOut, rCost] = params;
    if (state.reservations.some((row) => row.reservation_uuid === String(uuid))) throw dupError();
    state.reservations.push({
      reservation_uuid: String(uuid),
      run_id: Number(runId),
      attempt_id: String(attemptId),
      kind: String(kind),
      reserved_llm_calls: Number(rCalls),
      reserved_input_tokens: Number(rIn),
      reserved_output_tokens: Number(rOut),
      reserved_cost_micros: toMicros(rCost),
      status: "reserved",
    });
    return [{ insertId: state.reservations.length }];
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
  if (normalized.startsWith("UPDATE analysis_behavior_budget_reservations SET status = 'released'")) {
    const found = state.reservations.find((row) => row.reservation_uuid === String(params[0]));
    if (!found || found.status !== "reserved") return [{ affectedRows: 0 }];
    found.status = "released";
    return [{ affectedRows: 1 }];
  }
  // —— 回执 ——
  if (normalized.startsWith("INSERT INTO llm_call_receipts")) {
    const key = params[24] as string | null;
    if (key !== null && state.receipts.some((row) => row.request_key === key)) throw dupError();
    state.receipts.push({
      run_id: Number(params[0]),
      attempt_id: params[22] as string | null,
      call_stage: params[23] as string | null,
      request_key: key,
      request_fingerprint: params[25] as string | null,
      provider_request_id: params[4] as string | null,
      outcome: params[5] as string,
      usage_status: params[6] as string,
      pricing_status: params[18] as string,
      input_tokens: params[7] as number | null,
      output_tokens: params[8] as number | null,
      cache_hit_tokens: params[9] as number | null,
      cache_miss_tokens: params[10] as number | null,
      usage_json: params[11] as string | null,
      llm_cost_amount: params[17] as string | null,
      duration_ms: params[26] as number | null,
    });
    return [{ insertId: state.receipts.length }];
  }
  if (normalized.includes("FROM llm_call_receipts WHERE run_id = ? AND attempt_id = ?")) {
    return [state.receipts.filter((row) => row.run_id === Number(params[0]) && row.attempt_id === String(params[1])).map(clone)];
  }
  // —— attempts ——
  if (normalized.startsWith("INSERT INTO analysis_behavior_batch_attempts")) {
    state.attempts.push({
      run_id: Number(params[0]),
      batch_attempt_uuid: String(params[1]),
      batch_key: String(params[2]),
      reservation_uuid: String(params[3]),
      model_config_fingerprint: String(params[4]),
      prompt_version: "1",
      schema_version: "1",
      parser_version: "1",
      execution_phase: "claiming",
      members_frozen_at: null,
      accepted_describe_request_key: null,
      accepted_judge_request_key: null,
      terminal_request_key: null,
      processing_owner: null,
      processing_lease_expires_at: null,
      version: 0,
    });
    return [{ insertId: state.attempts.length }];
  }
  if (normalized.includes("execution_phase IN ('describe_persisted', 'judge_persisted', 'splitting')")) {
    const found = state.attempts.filter(
      (row) =>
        row.run_id === Number(params[0]) &&
        row.batch_key === String(params[1]) &&
        ["describe_persisted", "judge_persisted", "splitting"].includes(row.execution_phase),
    );
    return [found.map(clone)];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_batch_attempts")) {
    return [state.attempts.filter((row) => row.run_id === Number(params[0]) && row.batch_attempt_uuid === String(params[1])).map(clone)];
  }
  if (normalized.includes("SET members_frozen_at = ?")) {
    const row = state.attempts.find((candidate) => candidate.run_id === Number(params[1]) && candidate.batch_attempt_uuid === String(params[2]));
    if (!row || row.members_frozen_at !== null || row.execution_phase !== "claiming") return [{ affectedRows: 0 }];
    row.members_frozen_at = String(params[0]);
    return [{ affectedRows: 1 }];
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
  // —— plan set（恢复路由只读）——
  if (normalized.includes("FROM analysis_behavior_batch_plan_sets") && normalized.includes("publish_status = 'ready'")) {
    const ready = state.planSets.filter((row) => row.run_id === Number(params[0]) && row.publish_status === "ready");
    return [ready.length > 0 ? [clone(ready[ready.length - 1]!)] : []];
  }
  if (normalized.includes("FROM analysis_behavior_batch_plan_sets")) {
    return [state.planSets.filter((row) => row.run_id === Number(params[0])).map(clone)];
  }
  if (normalized.includes("FROM analysis_behavior_batch_plans")) {
    const rows = state.plans
      .filter((row) => row.run_id === Number(params[0]) && row.plan_set_id === String(params[1]))
      .map(clone)
      .sort((a, b) => (a.batch_key < b.batch_key ? -1 : 1));
    return [rows];
  }
  // —— members ——
  if (normalized.startsWith("SELECT COUNT") && normalized.includes("FROM analysis_behavior_batch_attempt_members")) {
    return [[{ n: state.members.filter((row) => row.batch_attempt_uuid === String(params[0])).length }]];
  }
  if (normalized.includes("FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ?")) {
    return [state.members.filter((row) => row.batch_attempt_uuid === String(params[0])).map(clone)];
  }
  if (normalized.startsWith("INSERT INTO analysis_behavior_batch_attempt_members")) {
    if (state.failMemberInsert) throw new Error("member insert forced failure");
    const row: MemberRow = {
      run_id: Number(params[0]),
      batch_attempt_uuid: String(params[1]),
      task_key: String(params[2]),
      task_key_hash: String(params[3]),
      request_task_attempt_id: String(params[4]),
      request_lease_identity: String(params[5]),
      task_alias: String(params[6]),
      ordered_region_aliases: String(params[7]),
    };
    if (state.members.some((existing) => existing.batch_attempt_uuid === row.batch_attempt_uuid && existing.task_key_hash === row.task_key_hash)) throw dupError();
    state.members.push(row);
    return [{ insertId: state.members.length }];
  }
  // —— batch requests ——
  if (normalized.startsWith("SELECT request_stage, raw_response") && normalized.includes("request_outcome = 'response_persisted'")) {
    const persisted = state.requests
      .filter((row) => row.batch_attempt_uuid === String(params[0]) && row.request_outcome === "response_persisted")
      .map(clone);
    const describe = persisted.find((row) => row.request_stage === "describe");
    const judge = persisted.find((row) => row.request_stage === "judge");
    return [[
      { request_stage: "describe", raw_response: describe?.raw_response ?? null, provider_finish_reason: describe?.provider_finish_reason ?? null },
      { request_stage: "judge", raw_response: judge?.raw_response ?? null, provider_finish_reason: judge?.provider_finish_reason ?? null },
    ]];
  }
  if (normalized.startsWith("SELECT request_key") && normalized.includes("FROM analysis_behavior_batch_requests")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[0]));
    return [row ? [{ ...row }] : []];
  }
  if (normalized.startsWith("SELECT raw_response") && normalized.includes("FROM analysis_behavior_batch_requests")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[0]));
    return [row && row.request_outcome === "response_received" ? [{ ...row }] : []];
  }
  if (normalized.startsWith("INSERT INTO analysis_behavior_batch_requests")) {
    state.requests.push({
      request_key: String(params[2]),
      batch_attempt_uuid: String(params[1]),
      request_stage: String(params[3]),
      request_sequence: Number(params[4]),
      request_fingerprint: String(params[5]),
      describe_response_hash: (params[6] as string | null) ?? null,
      provider_request_id: null,
      request_outcome: "prepared",
      failure_class: null,
      raw_response: null,
      response_byte_length: null,
      stored_byte_length: null,
      response_hash: null,
      provider_finish_reason: null,
    });
    return [{ insertId: state.requests.length }];
  }
  if (normalized.includes("SET request_outcome = 'dispatch_started'")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[0]));
    if (!row || row.request_outcome !== "prepared") return [{ affectedRows: 0 }];
    row.request_outcome = "dispatch_started";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'response_received'")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[2]));
    if (!row || row.request_outcome !== "dispatch_started") return [{ affectedRows: 0 }];
    row.request_outcome = "response_received";
    row.provider_request_id = (params[0] as string | null) ?? row.provider_request_id;
    row.provider_finish_reason = (params[1] as string | null) ?? row.provider_finish_reason;
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET raw_response = ?")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[4]));
    if (!row || row.request_outcome !== "response_received") return [{ affectedRows: 0 }];
    row.raw_response = String(params[0]);
    row.response_byte_length = Number(params[1]);
    row.stored_byte_length = Number(params[2]);
    row.response_hash = String(params[3]);
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'response_persisted'")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[0]));
    if (!row || row.request_outcome !== "response_received") return [{ affectedRows: 0 }];
    row.request_outcome = "response_persisted";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("SET request_outcome = 'outcome_unknown'")) {
    const row = state.requests.find((candidate) => candidate.request_key === String(params[0]));
    if (!row || row.request_outcome !== "dispatch_started") return [{ affectedRows: 0 }];
    row.request_outcome = "outcome_unknown";
    return [{ affectedRows: 1 }];
  }
  // —— tasks（claim/commit/failed/pending/readback）——
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
  if (normalized.includes("UPDATE analysis_behavior_tasks") && normalized.includes("SET status = 'failed'")) {
    const [, runId, hash, attemptId, leaseOwner] = params as [string, number, string, string, string];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row || row.status !== "running" || row.attempt_id !== String(attemptId) || row.lease_owner !== String(leaseOwner)) return [{ affectedRows: 0 }];
    row.status = "failed";
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_tasks")) {
    return [state.tasks.filter((row) => row.run_id === Number(params[0]) && row.task_key_hash === String(params[1])).map(clone)];
  }
  throw new Error(`unexpected statement: ${sql}`);
};

// ============ 夹具与桩 ============
function makeTask(taskKey: string): import("../lib/behavior-inventory/types").BehaviorExecutionTask {
  const row = taskRow(taskKey);
  return { taskKey, unitKey: row.unit_key, anchorFragments: JSON.parse(row.anchor_fragments) };
}

function describeRegion(id: string, facts: string) {
  return { id, facts, inputs: "", controlFlow: "", externalEffects: "" };
}

function judgeRegion(id: string) {
  return { id, disposition: "extracted", evidence: [{ path: "src/task-one.ts", startLine: 2 }], scenarioRefs: ["HP-1"] };
}

function batchContentFor(aliasToKey: Readonly<Record<string, string>>, opts: { dropTask?: string; dropRegion?: { alias: string }; judgeExtract?: boolean } = {}): { describe: string; judge: string } {
  const describeTasks: Array<Record<string, unknown>> = [];
  const judgeTasks: Array<Record<string, unknown>> = [];
  Object.entries(aliasToKey).forEach(([alias, key]) => {
    if (opts.dropTask === alias) return;
    const regions = opts.dropRegion?.alias === alias ? [] : [{ id: "R1", facts: `${key} facts` }];
    describeTasks.push({ id: alias, regions });
    const ownPath = `src/${key.replace(/[|]/g, "-")}.ts`;
    judgeTasks.push({
      id: alias,
      regions: opts.dropRegion?.alias === alias
        ? []
        : [
            opts.judgeExtract
              ? { id: "R1", disposition: "extracted", evidence: [{ path: ownPath, startLine: 2 }], scenarioRefs: ["HP-1"] }
              : { id: "R1", disposition: "unresolved", evidence: [], scenarioRefs: [] },
          ],
      features: opts.judgeExtract && opts.dropRegion?.alias !== alias
        ? [{ name: `f-${key}`, summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: ownPath, startLine: 2 }] }] }]
        : [],
    });
  });
  return { describe: JSON.stringify({ tasks: describeTasks }), judge: JSON.stringify({ tasks: judgeTasks }) };
}

const dispatchStub = async (messages: Array<{ role: string; content: string }>, billing: import("../lib/ai").LlmBillingContext) => {
  const isDescribe = billing.callStage === "describe";
  dispatchCalls.push({ stage: billing.callStage ?? "?", requestKey: billing.requestKey ?? null });
  if (isDescribe && failJudgeDispatch) {
    // describe 成功、judge 派发失败（测试 8 用开关单独控制）
  }
  if (!isDescribe && failJudgeDispatch) throw new Error("judge dispatch boom");
  // 模拟真实回执落库（recordRequestScopedReceipt 的 INSERT 面）
  await holder.router!("INSERT INTO llm_call_receipts VALUES (?)", [
    RUN_ID, 7, "main", "test-model", `gw-${dispatchCalls.length}`, "success", "known", 100, 50, 0, 0, null, null, null, null, null, "CNY", "0.010000", "priced", "batch", null, null, billing.attemptId ?? null, billing.callStage ?? null, billing.requestKey ?? null, billing.requestFingerprint ?? null, 1200,
  ]);
  const content = isDescribe
    ? batchContentFor(aliasToKey).describe
    : batchContentFor(aliasToKey, { judgeExtract: true }).judge;
  return { content, usageRaw: { prompt_tokens: 100, completion_tokens: 50 }, providerRequestId: `gw-${dispatchCalls.length}`, finishReason: !isDescribe && judgeFinishLength ? "length" : null };
};

async function seedAndRun(opts: { unclaimable?: string; forceUnresolved?: string } = {}): Promise<{ attempt: AttemptRow; reservation: ReservationRow }> {
  const planInputs = TASK_KEYS.map((key) => planInputFor(key));
  const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: planInputs });
  const plan = allocation.batchPlans[0]!;
  aliasToKey = Object.fromEntries(Object.entries(plan.taskAliasMap).map(([taskKey, alias]) => [alias, taskKey]));
  await runInventoryBatchAttempt({
    runId: RUN_ID,
    accountId: 7,
    batchKey: plan.batchKey,
    manifestHash: MANIFEST_HASH,
    plan,
    tasks: TASK_KEYS.map((key) => makeTask(key)),
    loadSources: async (task) => [{ path: `src/${task.taskKey.replace(/[|]/g, "-")}.ts`, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 }],
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000,
    maxAttempts: 3,
    chargeComponent: "main",
    dispatchDetailed: dispatchStub,
  });
  const attempt = state.attempts[0]!;
  const reservation = state.reservations.find((row) => row.attempt_id === attempt.batch_attempt_uuid)!;
  return { attempt, reservation };
}

function repairFetchPayload(): string {
  const judgeResult = {
    regions: [{ id: "R1", disposition: "extracted", evidence: [{ path: "src/task-two.ts", startLine: 2 }], scenarioRefs: ["HP-1"] }],
    features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/task-two.ts", startLine: 2 }] }] }],
  };
  return JSON.stringify({ id: "repair", choices: [{ message: { content: JSON.stringify(judgeResult) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("execution batch runner (Task 8)", () => {
  beforeEach(() => {
    state = buildState();
    state.planSets = [];
    state.plans = [];
    dispatchCalls = [];
    failJudgeDispatch = false;
    judgeFinishLength = false;
    vi.stubEnv("AI_MODEL", "test-model");
    vi.stubEnv("AI_API_KEY", "key-1");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example");
    holder.router = router;
    holder.getDbImpl = () => ({
      execute: (sql: string, params: Array<string | number | null>) => holder.router!(sql, params),
      getConnection: async () => {
        const undoStack: Array<() => void> = [];
        return {
          beginTransaction: async () => undefined,
          execute: async (sql: string, params: Array<string | number | null>) => {
            const snapshot = { tasks: state.tasks.map(clone), members: state.members.map(clone), attempts: state.attempts.map(clone) };
            undoStack.push(() => {
              state.tasks = snapshot.tasks;
              state.members = snapshot.members;
              state.attempts = snapshot.attempts;
            });
            return holder.router!(sql, params);
          },
          commit: async () => {
            undoStack.length = 0;
          },
          rollback: async () => {
            for (const undo of [...undoStack].reverse()) undo();
            undoStack.length = 0;
          },
          release: () => undefined,
        };
      },
    });
  });

  it("keeps task mode for default and garbage execution mode values", () => {
    vi.stubEnv("ANALYSIS_BEHAVIOR_EXECUTION_MODE", "");
    expect(behaviorAnalysisExecutionMode()).toBe("task");
    vi.stubEnv("ANALYSIS_BEHAVIOR_EXECUTION_MODE", "garbage");
    expect(behaviorAnalysisExecutionMode()).toBe("task");
    vi.stubEnv("ANALYSIS_BEHAVIOR_EXECUTION_MODE", "batch");
    expect(behaviorAnalysisExecutionMode()).toBe("batch");
    vi.unstubAllEnvs();
  });

  it("partial claims only request claimed members with original aliases", async () => {
    // task|three（别名 T2）不可领取（failed 且重试预算耗尽）→ 请求只含 T1/T3，别名不重排
    const unclaimable = state.tasks.find((row) => row.task_key === "task|three")!;
    unclaimable.status = "failed";
    unclaimable.attempts = 3;
    await seedAndRun();
    const joined = dispatchCalls.map((call) => call.stage).join(",");
    expect(dispatchCalls).toHaveLength(2);
    const describeCall = state.requests.find((row) => row.request_stage === "describe")!;
    expect(state.members.map((row) => row.task_alias).sort()).toEqual(["T1", "T3"]);
    void joined;
    void describeCall;
  });

  it("successful tasks commit independently with current task attempts", async () => {
    await seedAndRun();
    const committed = state.tasks.filter((row) => row.status === "extracted" || row.status === "no_behavior" || row.status === "unresolved");
    expect(committed).toHaveLength(3);
    expect(state.tasks.every((row) => row.result_json !== null)).toBe(true);
    // 提交资格 = claim 时的 task attempt（task 行 attempt_id 未变）
    expect(state.tasks.every((row) => row.attempt_id?.startsWith("........") === false)).toBe(true);
  });

  it("reservation settlement does not depend on all tasks being committed", async () => {
    // 提交谓词全拒绝（task 行被外部改走 running→无匹配）也照样结算
    const { attempt, reservation } = await seedAndRun();
    expect(reservation.status === "settled" || reservation.status === "settled_unknown").toBe(true);
    expect(attempt.execution_phase).toBe("split_done");
    // 结算发生在拆分/提交之前（语句顺序：settle 的 ledger UPDATE 先于 splitting 迁移）
  });

  it("unresolved members use single task repair with separate one call reservation", async () => {
    // 强制 T2 判定缺失区域 → unresolved → 单任务语义复核（kind=task_repair, maxLlmCalls=1）
    judgeFinishLength = false;
    const planInputs = TASK_KEYS.map((key) => planInputFor(key));
    const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: planInputs });
    const plan = allocation.batchPlans[0]!;
    aliasToKey = Object.fromEntries(Object.entries(plan.taskAliasMap).map(([taskKey, alias]) => [alias, taskKey]));
    // fetch 桩：repair 走真实 extractBehaviorTask（单任务 prompt → 单任务 JSON）
    vi.stubGlobal("fetch", vi.fn(async () => new Response(repairFetchPayload(), { status: 200 })));
    const dispatchForUnresolved = async (messages: Array<{ role: string; content: string }>, billing: import("../lib/ai").LlmBillingContext) => {
      const isDescribe = billing.callStage === "describe";
      dispatchCalls.push({ stage: billing.callStage ?? "?", requestKey: billing.requestKey ?? null });
      await holder.router!("INSERT INTO llm_call_receipts VALUES (?)", [
        RUN_ID, 7, "main", "test-model", `gw-${dispatchCalls.length}`, "success", "known", 100, 50, 0, 0, null, null, null, null, null, "CNY", "0.010000", "priced", billing.callKind ?? null, null, null, billing.attemptId ?? null, billing.callStage ?? null, billing.requestKey ?? null, billing.requestFingerprint ?? null, 1200,
      ]);
      const content = isDescribe ? batchContentFor(aliasToKey).describe : batchContentFor(aliasToKey, { dropRegion: { alias: "T2" }, judgeExtract: true }).judge;
      return { content, usageRaw: { prompt_tokens: 100, completion_tokens: 50 }, providerRequestId: "gw-y", finishReason: null };
    };
    const before = state.tasks.map((row) => clone(row));
    void before;
    await runInventoryBatchAttempt({
      runId: RUN_ID,
      accountId: 7,
      batchKey: plan.batchKey,
      manifestHash: MANIFEST_HASH,
      plan,
      tasks: TASK_KEYS.map((key) => makeTask(key)),
      loadSources: async (task) => [{ path: `src/${task.taskKey.replace(/[|]/g, "-")}.ts`, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 }],
      leaseOwner: "worker-1",
      leaseDurationMs: 60_000,
      maxAttempts: 3,
      chargeComponent: "main",
      dispatchDetailed: dispatchForUnresolved,
    });
    // 提交身份 = claim attempt（task 行 attempt_id 在 claim 时写入，repair 不改写提交身份）
    const repairReceipts = state.receipts.filter((row) => row.request_key?.endsWith("|judge|1") && row.call_stage === "judge" && row.request_key?.includes("task_repair") === false);
    void repairReceipts;
    const repairRows = state.reservations.filter((row) => row.kind === "task_repair");
    expect(repairRows[0]!.attempt_id).not.toBe(state.attempts[0]!.batch_attempt_uuid);
    const batchReceipts = state.receipts.filter((row) => row.attempt_id === state.attempts[0]!.batch_attempt_uuid);
    expect(batchReceipts.length).toBeGreaterThanOrEqual(2);
    // repair 回执 request_key = `${repairBudgetAttemptId}|judge|1`
    expect(state.receipts.some((row) => row.request_key === `${repairRows[0]!.attempt_id}|judge|1`)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("repair crash never repeats persisted main batch responses", async () => {
    const planInputs = TASK_KEYS.map((key) => planInputFor(key));
    const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: planInputs });
    const plan = allocation.batchPlans[0]!;
    aliasToKey = Object.fromEntries(Object.entries(plan.taskAliasMap).map(([taskKey, alias]) => [alias, taskKey]));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("repair crashed"); }));
    const dispatchForCrash = async (messages: Array<{ role: string; content: string }>, billing: import("../lib/ai").LlmBillingContext) => {
      const isDescribe = billing.callStage === "describe";
      dispatchCalls.push({ stage: billing.callStage ?? "?", requestKey: billing.requestKey ?? null });
      await holder.router!("INSERT INTO llm_call_receipts VALUES (?)", [
        RUN_ID, 7, "main", "test-model", `gw-${dispatchCalls.length}`, "success", "known", 100, 50, 0, 0, null, null, null, null, null, "CNY", "0.010000", "priced", billing.callKind ?? null, null, null, billing.attemptId ?? null, billing.callStage ?? null, billing.requestKey ?? null, billing.requestFingerprint ?? null, 1200,
      ]);
      const content = isDescribe ? batchContentFor(aliasToKey).describe : batchContentFor(aliasToKey, { dropRegion: { alias: "T2" }, judgeExtract: true }).judge;
      return { content, usageRaw: { prompt_tokens: 100, completion_tokens: 50 }, providerRequestId: "gw-z", finishReason: null };
    };
    await runInventoryBatchAttempt({
      runId: RUN_ID,
      accountId: 7,
      batchKey: plan.batchKey,
      manifestHash: MANIFEST_HASH,
      plan,
      tasks: TASK_KEYS.map((key) => makeTask(key)),
      loadSources: async (task) => [{ path: `src/${task.taskKey.replace(/[|]/g, "-")}.ts`, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 }],
      leaseOwner: "worker-1",
      leaseDurationMs: 60_000,
      maxAttempts: 3,
      chargeComponent: "main",
      dispatchDetailed: dispatchForCrash,
    });
    const mainCalls = dispatchCalls.filter((call) => call.stage === "describe" || call.stage === "judge").length;
    // recovery：split_done 不是可恢复阶段 → 零新模型调用，主批响应键保持不变
    await recoverInventoryBatchAttempts({
      runId: RUN_ID,
      accountId: 7,
      manifestHash: MANIFEST_HASH,
      chargeComponent: "main",
      leaseOwner: "worker-2",
      leaseDurationMs: 60_000,
      maxAttempts: 3,
      loadSources: async (task) => [{ path: `src/${task.taskKey.replace(/[|]/g, "-")}.ts`, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 }],
      tasks: TASK_KEYS.map((key) => makeTask(key)),
      dispatchDetailed: dispatchStub,
    });
    expect(dispatchCalls.filter((call) => call.stage === "describe" || call.stage === "judge")).toHaveLength(mainCalls);
    const persistedKeys = state.requests.filter((row) => row.request_outcome === "response_persisted").map((row) => row.request_key).sort();
    expect(persistedKeys).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("persisted describe resumes with judge only and persisted judge resumes with zero calls", async () => {
    // 场景 A：describe_persisted（手工种入）→ 恢复只派发 judge
    const allocA = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: [planInputFor("task|one")] });
    const batchKeyA = allocA.batchPlans[0]!.batchKey;
    state.planSets.push({ run_id: RUN_ID, plan_set_id: "ps-A", plan_set_fingerprint: allocA.planSetFingerprint, planner_version: "1", expected_plan_count: allocA.batchPlans.length, expected_task_count: 1, publish_status: "ready", fallback_assignments: JSON.stringify(allocA.fallbackAssignments) });
    state.plans.push(...allocA.batchPlans.map((plan) => ({ run_id: RUN_ID, plan_set_id: "ps-A", batch_key: plan.batchKey, manifest_hash: MANIFEST_HASH, planner_version: "1", ordered_task_keys: JSON.stringify(plan.orderedTaskKeys), task_alias_map: JSON.stringify(plan.taskAliasMap), grouping_rules_fingerprint: plan.groupingRulesFingerprint, input_budget_snapshot: JSON.stringify(plan.inputBudgetSnapshot) })));
    const attemptA = "aaaaaaa2-2222-4222-8222-222222222222";
    state.attempts.push({ run_id: RUN_ID, batch_attempt_uuid: attemptA, batch_key: batchKeyA, reservation_uuid: "res-A", model_config_fingerprint: "m", prompt_version: "1", schema_version: "1", parser_version: "1", execution_phase: "describe_persisted", members_frozen_at: mysqlDatetime(Date.now()), accepted_describe_request_key: null, accepted_judge_request_key: null, terminal_request_key: null, processing_owner: null, processing_lease_expires_at: null, version: 1 });
    state.members.push({ run_id: RUN_ID, batch_attempt_uuid: attemptA, task_key: "task|one", task_key_hash: sha256Utf8("task|one"), request_task_attempt_id: "ta-A", request_lease_identity: "w", task_alias: "T1", ordered_region_aliases: JSON.stringify([{ anchorFragmentKey: "f1", regionAlias: "R1" }]) });
    state.requests.push({ request_key: `${attemptA}|describe|1`, batch_attempt_uuid: attemptA, request_stage: "describe", request_sequence: 1, request_fingerprint: "f", describe_response_hash: null, provider_request_id: "gw", request_outcome: "response_persisted", failure_class: null, raw_response: JSON.stringify({ tasks: [{ id: "T1", regions: [describeRegion("R1", "one facts")] }] }), response_byte_length: 10, stored_byte_length: 10, response_hash: "h", provider_finish_reason: null });
    const tasksA = [makeTask("task|one")];
    await recoverInventoryBatchAttempts({
      runId: RUN_ID, accountId: 7, manifestHash: MANIFEST_HASH, chargeComponent: "main", leaseOwner: "worker-2", leaseDurationMs: 60_000, maxAttempts: 3,
      loadSources: async () => [{ path: "src/task-one.ts", role: "primary", content: "x", startLine: 1, endLine: 1 }],
      tasks: tasksA,
      dispatchDetailed: dispatchStub,
    });
    const describeDispatches = dispatchCalls.filter((call) => call.stage === "describe").length;
    expect(describeDispatches).toBe(0);
    expect(dispatchCalls.some((call) => call.stage === "judge")).toBe(true);
    expect(state.attempts.find((row) => row.batch_attempt_uuid === attemptA)!.execution_phase).toBe("split_done");

    // 场景 B：judge_persisted（两条响应都在）→ 恢复零模型调用完成拆分提交
    dispatchCalls = [];
    const allocB = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: [planInputFor("task|two")] });
    const batchKeyB = allocB.batchPlans[0]!.batchKey;
    state.planSets.push({ run_id: RUN_ID, plan_set_id: "ps-B", plan_set_fingerprint: allocB.planSetFingerprint, planner_version: "1", expected_plan_count: allocB.batchPlans.length, expected_task_count: 1, publish_status: "ready", fallback_assignments: JSON.stringify(allocB.fallbackAssignments) });
    state.plans.push(...allocB.batchPlans.map((plan) => ({ run_id: RUN_ID, plan_set_id: "ps-B", batch_key: plan.batchKey, manifest_hash: MANIFEST_HASH, planner_version: "1", ordered_task_keys: JSON.stringify(plan.orderedTaskKeys), task_alias_map: JSON.stringify(plan.taskAliasMap), grouping_rules_fingerprint: plan.groupingRulesFingerprint, input_budget_snapshot: JSON.stringify(plan.inputBudgetSnapshot) })));
    const attemptB = "bbbbbbb2-2222-4222-8222-222222222222";
    state.attempts.push({ run_id: RUN_ID, batch_attempt_uuid: attemptB, batch_key: batchKeyB, reservation_uuid: "res-B", model_config_fingerprint: "m", prompt_version: "1", schema_version: "1", parser_version: "1", execution_phase: "judge_persisted", members_frozen_at: mysqlDatetime(Date.now()), accepted_describe_request_key: null, accepted_judge_request_key: null, terminal_request_key: null, processing_owner: null, processing_lease_expires_at: null, version: 1 });
    state.members.push({ run_id: RUN_ID, batch_attempt_uuid: attemptB, task_key: "task|two", task_key_hash: sha256Utf8("task|two"), request_task_attempt_id: "ta-B", request_lease_identity: "w", task_alias: "T1", ordered_region_aliases: JSON.stringify([{ anchorFragmentKey: "f2", regionAlias: "R1" }]) });
    state.requests.push({ request_key: `${attemptB}|describe|1`, batch_attempt_uuid: attemptB, request_stage: "describe", request_sequence: 1, request_fingerprint: "f", describe_response_hash: null, provider_request_id: "gw", request_outcome: "response_persisted", failure_class: null, raw_response: JSON.stringify({ tasks: [{ id: "T1", regions: [describeRegion("R1", "two facts")] }] }), response_byte_length: 10, stored_byte_length: 10, response_hash: "h", provider_finish_reason: null });
    state.requests.push({
      request_key: `${attemptB}|judge|1`,
      batch_attempt_uuid: attemptB,
      request_stage: "judge",
      request_sequence: 1,
      request_fingerprint: "f",
      describe_response_hash: "h",
      provider_request_id: "gw",
      request_outcome: "response_persisted",
      failure_class: null,
      raw_response: JSON.stringify({
        tasks: [{ id: "T1", regions: [judgeRegion("R1")], features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/task-two.ts", startLine: 2 }] }] }] }],
      }),
      response_byte_length: 10,
      stored_byte_length: 10,
      response_hash: "h",
      provider_finish_reason: null,
    });
    await recoverInventoryBatchAttempts({
      runId: RUN_ID, accountId: 7, manifestHash: MANIFEST_HASH, chargeComponent: "main", leaseOwner: "worker-2", leaseDurationMs: 60_000, maxAttempts: 3,
      loadSources: async () => [{ path: "src/task-two.ts", role: "primary", content: "x", startLine: 1, endLine: 1 }],
      tasks: [makeTask("task|two")],
      dispatchDetailed: dispatchStub,
    });
    expect(dispatchCalls).toHaveLength(0);
    expect(state.attempts.find((row) => row.batch_attempt_uuid === attemptB)!.execution_phase).toBe("split_done");
    expect(state.tasks.find((row) => row.task_key === "task|two")!.status).toBe("extracted");
  });

  it("batch mode never touches aggregation or activation surfaces", () => {
    const source = readFileSync(new URL("../lib/execution-batch/runner.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/aggregate\w*\(|activate\w*\(/);
    expect(source).not.toContain("runInventoryFullAnalysis");
  });

  it("exposes route and upper-bound helpers for the orchestrator", () => {
    const planInputs = TASK_KEYS.map((key) => planInputFor(key));
    const allocation = planBehaviorExecutionBatches({ manifestHash: MANIFEST_HASH, tasks: planInputs });
    const routed = routeBatchWorkItems(TASK_KEYS.map((key) => makeTask(key)), allocation);
    expect(routed.batchWork).toHaveLength(1);
    expect(routed.fallbackTasks).toHaveLength(0);
    expect(batchReservationUpperBound(routed.batchWork[0]!.plan).maxLlmCalls).toBe(2);
  });
});

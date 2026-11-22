import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Utf8 } from "../lib/execution-batch/identity";
import { ExecutionBatchError } from "../lib/execution-batch/plans";
import {
  acquireBatchAttemptProcessing,
  claimBatchAttemptMember,
  createBatchAttempt,
  freezeBatchAttemptMembers,
  loadBatchAttemptForRecovery,
  transitionBatchAttempt,
} from "../lib/execution-batch/attempts";

const RUN_ID = 51;
const BATCH_KEY = "b".repeat(64);

vi.mock("../lib/db", () => ({ getDb: () => attemptDbHolder.getDbImpl() }));

const attemptDbHolder = vi.hoisted(() => ({
  router: null as unknown as ((sql: string, params: unknown[]) => Promise<unknown>) | null,
  getDbImpl: null as unknown as () => {
    execute: (sql: string, params: Array<string | number | null>) => Promise<unknown>;
    getConnection: () => Promise<{
      beginTransaction: () => Promise<void>;
      execute: (sql: string, params: Array<string | number | null>) => Promise<unknown>;
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
      release: () => void;
    }>;
  },
}));

interface AttemptRow {
  run_id: number;
  batch_attempt_uuid: string;
  batch_key: string;
  reservation_uuid: string;
  model_config_fingerprint: string;
  prompt_version: string;
  schema_version: string;
  parser_version: string;
  execution_phase: string;
  members_frozen_at: string | null;
  accepted_describe_request_key: string | null;
  accepted_judge_request_key: string | null;
  terminal_request_key: string | null;
  processing_owner: string | null;
  processing_lease_expires_at: string | null;
  version: number;
}

interface MemberRow {
  run_id: number;
  batch_attempt_uuid: string;
  task_key: string;
  task_key_hash: string;
  request_task_attempt_id: string;
  request_lease_identity: string;
  task_alias: string;
  ordered_region_aliases: string;
}

interface TaskRow {
  run_id: number;
  task_key: string;
  task_key_hash: string;
  status: string;
  attempts: number;
  attempt_id: string | null;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  result_json: string | null;
  unit_key: string;
  kind: string;
  primary_path: string;
  anchor_fragments: string;
  detector: string;
  detector_version: string;
}

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
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
    anchor_fragments: JSON.stringify([
      { anchorKey: `anchor|${taskKey}#0`, anchorFragmentKey: `fragment|${taskKey}#0`, ranges: [{ startLine: 1, endLine: 9 }] },
      { anchorKey: `anchor|${taskKey}#1`, anchorFragmentKey: `fragment|${taskKey}#1`, ranges: [{ startLine: 11, endLine: 19 }] },
    ]),
    detector: "http",
    detector_version: "1",
    ...overrides,
  };
}

interface Fixture {
  attempts: AttemptRow[];
  members: MemberRow[];
  tasks: TaskRow[];
  failMemberInsert: boolean;
  calls: string[];
}

const state: Fixture = { attempts: [], members: [], tasks: [], failMemberInsert: false, calls: [] };

function clone<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

function findAttempt(uuid: string): AttemptRow {
  const row = state.attempts.find((candidate) => candidate.batch_attempt_uuid === uuid);
  if (!row) throw new Error(`fake db: attempt ${uuid} not found`);
  return row;
}

const router = async (sql: string, rawParams: unknown[]): Promise<unknown> => {
  const params = rawParams as Array<string | number | null>;
  const normalized = String(sql).replace(/\s+/g, " ").trim();
  state.calls.push(normalized);
  // —— attempts 表 ——
  if (normalized.startsWith("INSERT INTO analysis_behavior_batch_attempts")) {
    const row: AttemptRow = {
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
    };
    state.attempts.push(row);
    return [{ insertId: state.attempts.length }];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_batch_attempts")) {
    const found = state.attempts.filter((row) => row.run_id === Number(params[0]) && row.batch_attempt_uuid === String(params[1]));
    return [found.map(clone)];
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
  // —— members 表 ——
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
    if (state.members.some((existing) => existing.batch_attempt_uuid === row.batch_attempt_uuid && existing.task_key_hash === row.task_key_hash)) {
      const error = new Error("Duplicate entry") as Error & { code?: string };
      error.code = "ER_DUP_ENTRY";
      throw error;
    }
    state.members.push(row);
    return [{ insertId: state.members.length }];
  }
  if (normalized.startsWith("SELECT COUNT") && normalized.includes("FROM analysis_behavior_batch_attempt_members")) {
    return [[{ n: state.members.filter((row) => row.batch_attempt_uuid === String(params[0])).length }]];
  }
  if (normalized.includes("FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ?")) {
    return [state.members.filter((row) => row.batch_attempt_uuid === String(params[0])).map(clone)];
  }
  // —— analysis_behavior_tasks 表（claim/commit/mark 语义与单任务路径一致）——
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
    const [status, resultJson, scenarioCount, reviewedCount, unresolvedCount, runId, hash, attemptId, leaseOwner] = params as [
      string, string, number, number, number, number, string, string, string,
    ];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row || row.status !== "running" || row.attempt_id !== String(attemptId) || row.lease_owner !== String(leaseOwner)) {
      return [{ affectedRows: 0 }];
    }
    row.status = String(status);
    row.result_json = String(resultJson);
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("UPDATE analysis_behavior_tasks") && normalized.includes("SET status = 'failed'")) {
    const [errorText, runId, hash, attemptId, leaseOwner] = params as [string, number, string, string, string];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row || row.status !== "running" || row.attempt_id !== String(attemptId) || row.lease_owner !== String(leaseOwner)) {
      return [{ affectedRows: 0 }];
    }
    row.status = "failed";
    return [{ affectedRows: 1 }];
  }
  if (normalized.includes("UPDATE analysis_behavior_tasks") && normalized.includes("SET status = 'pending'")) {
    const [runId, hash, attemptId, leaseOwner] = params as [number, string, string, string];
    const row = state.tasks.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(hash));
    if (!row || row.status !== "running" || row.attempt_id !== String(attemptId) || row.lease_owner !== String(leaseOwner)) {
      return [{ affectedRows: 0 }];
    }
    row.status = "pending";
    row.lease_owner = null;
    row.lease_expires_at_ms = null;
    return [{ affectedRows: 1 }];
  }
  if (normalized.startsWith("SELECT") && normalized.includes("FROM analysis_behavior_tasks")) {
    const hash = String(params[1] ?? params[0]);
    const runId = Number(params[0]);
    const found = state.tasks.filter((row) => row.run_id === runId && row.task_key_hash === hash);
    return [found.map(clone)];
  }
  throw new Error(`unexpected statement: ${sql}`);
};

function attemptInput(uuid: string) {
  return {
    runId: RUN_ID,
    batchAttemptUuid: uuid,
    batchKey: BATCH_KEY,
    reservationUuid: `res-${uuid}`,
    modelConfigFingerprint: "m".repeat(64),
  };
}

function claimInput(uuid: string, taskKey: string, alias: string, owner = "worker-1") {
  return {
    runId: RUN_ID,
    batchAttemptUuid: uuid,
    taskKey,
    taskAlias: alias,
    leaseOwner: owner,
    leaseDurationMs: 60_000,
    maxAttempts: 3,
  };
}

const NOW = Date.now();

function freshState(): void {
  state.attempts = [];
  state.members = [];
  state.tasks = [taskRow("task|a"), taskRow("task|b"), taskRow("task|c")];
  state.failMemberInsert = false;
  state.calls = [];
}

describe("execution batch attempt state machine (Task 6)", () => {
  beforeEach(() => {
    freshState();
    attemptDbHolder.router = router;
    attemptDbHolder.getDbImpl = () => ({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params),
      getConnection: async () => {
        // 事务语义：写语句前快照受影响表，rollback 时按逆序恢复（模拟 InnoDB 回滚）
        const undoStack: Array<() => void> = [];
        return {
          beginTransaction: async () => undefined,
          execute: async (sql: string, params: Array<string | number | null>) => {
            const normalized = String(sql).replace(/\s+/g, " ").trim();
            const table = normalized.includes("analysis_behavior_tasks")
              ? "tasks"
              : normalized.includes("analysis_behavior_batch_attempt_members")
                ? "members"
                : normalized.includes("analysis_behavior_batch_attempts")
                  ? "attempts"
                  : null;
            if (table !== null) {
              const snapshot = { tasks: state.tasks.map(clone), members: state.members.map(clone), attempts: state.attempts.map(clone) };
              undoStack.push(() => {
                state.tasks = snapshot.tasks;
                state.members = snapshot.members;
                state.attempts = snapshot.attempts;
              });
            }
            return attemptDbHolder.router!(sql, params);
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

  it("claim and member insert commit or roll back together", async () => {
    const attempt = await createBatchAttempt(attemptInput("11111111-1111-4111-8111-111111111111"));
    expect(attempt.executionPhase).toBe("claiming");
    const claimed = await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|a", "T1"));
    expect(claimed).not.toBeNull();
    expect(state.members).toHaveLength(1);
    expect(state.members[0]!.request_task_attempt_id).toBe(claimed!.attemptId);
    expect(state.members[0]!.task_alias).toBe("T1");
    expect(JSON.parse(state.members[0]!.ordered_region_aliases)).toEqual([
      { anchorFragmentKey: `fragment|task|a#0`, regionAlias: "R1" },
      { anchorFragmentKey: `fragment|task|a#1`, regionAlias: "R2" },
    ]);
    // member insert 失败 → 事务回滚：task 行恢复 pending、计数不变、零半持久化成员
    state.failMemberInsert = true;
    await expect(claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|b", "T2"))).rejects.toThrow("forced failure");
    expect(state.members).toHaveLength(1);
    const rolledBack = state.tasks.find((row) => row.task_key === "task|b")!;
    expect(rolledBack.status).toBe("pending");
    expect(rolledBack.attempts).toBe(0);
    expect(rolledBack.attempt_id).toBeNull();
  });

  it("claiming recovery may continue claiming before members are frozen", async () => {
    const attempt = await createBatchAttempt(attemptInput("22222222-2222-4222-8222-222222222222"));
    expect(await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|a", "T1"))).not.toBeNull();
    // 崩溃后重新 claim：只要未冻结，剩余候选可继续领取
    expect(await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|b", "T2"))).not.toBeNull();
    const frozen = await freezeBatchAttemptMembers({ runId: RUN_ID, batchAttemptUuid: attempt.batchAttemptUuid });
    expect(frozen.membersFrozenAt).not.toBeNull();
    expect(state.members).toHaveLength(2);
  });

  it("members and R aliases freeze before describe and reject later additions", async () => {
    const attempt = await createBatchAttempt(attemptInput("33333333-3333-4333-8333-333333333333"));
    await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|a", "T1"));
    await freezeBatchAttemptMembers({ runId: RUN_ID, batchAttemptUuid: attempt.batchAttemptUuid });
    await expect(claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|b", "T2"))).rejects.toMatchObject({
      code: "execution_batch_attempt_state",
    });
    expect(state.members).toHaveLength(1);
    // 重复冻结幂等
    const refrozen = await freezeBatchAttemptMembers({ runId: RUN_ID, batchAttemptUuid: attempt.batchAttemptUuid });
    expect(refrozen.membersFrozenAt).not.toBeNull();
  });

  it("zero members cannot freeze and follow aborted release path", async () => {
    const attempt = await createBatchAttempt(attemptInput("44444444-4444-4444-8444-444444444444"));
    await expect(freezeBatchAttemptMembers({ runId: RUN_ID, batchAttemptUuid: attempt.batchAttemptUuid })).rejects.toThrow(/零成员/);
    // aborted 仅限首次模型请求前：acquire 后从 claiming → aborted
    const grant = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      processingOwner: "worker-1",
      leaseDurationMs: 60_000,
    });
    const aborted = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "aborted",
      processingOwner: grant.processingOwner,
      expectedVersion: grant.version,
    });
    expect(aborted.executionPhase).toBe("aborted");
    // aborted 是终态：不得再迁移
    await expect(
      transitionBatchAttempt({
        runId: RUN_ID,
        batchAttemptUuid: attempt.batchAttemptUuid,
        to: "describe_requesting",
        processingOwner: grant.processingOwner,
        expectedVersion: aborted.version,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_attempt_state" });
  });

  it("member change or model retry requires a new attempt", async () => {
    const first = await createBatchAttempt(attemptInput("55555555-5555-4555-8555-555555555555"));
    await claimBatchAttemptMember(claimInput(first.batchAttemptUuid, "task|a", "T1"));
    // 同一 task 在同 attempt 内重复 claim → 唯一约束回滚，task 行恢复
    const dupTask = state.tasks.find((row) => row.task_key === "task|a")!;
    dupTask.status = "pending";
    dupTask.lease_expires_at_ms = NOW - 1_000;
    await expect(claimBatchAttemptMember(claimInput(first.batchAttemptUuid, "task|a", "T1"))).rejects.toThrow();
    expect(state.members).toHaveLength(1);
    // 状态机不提供倒退边：describe 已持久化后不得回到 describe_requesting——模型重试只能建新 attempt
    const grant = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: first.batchAttemptUuid,
      processingOwner: "worker-1",
      leaseDurationMs: 60_000,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: first.batchAttemptUuid,
      to: "describe_requesting",
      processingOwner: grant.processingOwner,
      expectedVersion: grant.version,
    });
    const persisted = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: first.batchAttemptUuid,
      to: "describe_persisted",
      processingOwner: grant.processingOwner,
      expectedVersion: grant.version + 1,
    });
    await expect(
      transitionBatchAttempt({
        runId: RUN_ID,
        batchAttemptUuid: first.batchAttemptUuid,
        to: "describe_requesting",
        processingOwner: grant.processingOwner,
        expectedVersion: persisted.version,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_attempt_state" });
  });

  it("only current processing owner and version can transition or split", async () => {
    const attempt = await createBatchAttempt(attemptInput("66666666-6666-4666-8666-666666666666"));
    const grant = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      processingOwner: "worker-1",
      leaseDurationMs: 60_000,
    });
    // 错 owner
    await expect(
      transitionBatchAttempt({
        runId: RUN_ID,
        batchAttemptUuid: attempt.batchAttemptUuid,
        to: "describe_requesting",
        processingOwner: "worker-2",
        expectedVersion: grant.version,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_version_conflict" });
    // 错 version
    await expect(
      transitionBatchAttempt({
        runId: RUN_ID,
        batchAttemptUuid: attempt.batchAttemptUuid,
        to: "describe_requesting",
        processingOwner: "worker-1",
        expectedVersion: grant.version + 5,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_version_conflict" });
    const moved = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "describe_requesting",
      processingOwner: "worker-1",
      expectedVersion: grant.version,
    });
    expect(moved.executionPhase).toBe("describe_requesting");
    expect(moved.version).toBe(grant.version + 1);
    // 租约存续期间第二个 worker 不能抢占
    await expect(
      acquireBatchAttemptProcessing({
        runId: RUN_ID,
        batchAttemptUuid: attempt.batchAttemptUuid,
        processingOwner: "worker-2",
        leaseDurationMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "execution_batch_version_conflict" });
  });

  it("expired task lease requires new task claim before submission", async () => {
    const attempt = await createBatchAttempt(attemptInput("77777777-7777-4777-8777-777777777777"));
    const claimedA = await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|a", "T1", "worker-old"));
    const taskRowA = state.tasks.find((row) => row.task_key === "task|a")!;
    taskRowA.lease_expires_at_ms = NOW - 1_000;
    // 原 member 的 request attempt 永久保留
    expect(state.members[0]!.request_task_attempt_id).toBe(claimedA!.attemptId);
    // 新提交资格按现有 task 恢复协议重新 claim（不经过成员 claim——member 已 insert-only）
    const receipts7 = await import("../lib/behavior-unit-receipts");
    const claimedB = await receipts7.claimBehaviorTask({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params) as never,
      runId: RUN_ID,
      taskKey: "task|a",
      leaseOwner: "worker-new",
      leaseDurationMs: 60_000,
      maxAttempts: 3,
    });
    expect(claimedB!.attemptId).not.toBe(claimedA!.attemptId);
    // 旧 attempt 提交被拒
    const staleCommit = await import("../lib/behavior-unit-receipts");
    const committedOld = await staleCommit.commitBehaviorTaskResult({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params) as never,
      runId: RUN_ID,
      taskKey: "task|a",
      attemptId: claimedA!.attemptId,
      leaseOwner: "worker-old",
      outcome: "extracted",
      result: { ok: true },
      scenarioCount: 1,
      reviewedCount: 0,
      unresolvedAnchorCount: 0,
    });
    expect(committedOld).toBe(false);
    const committedNew = await staleCommit.commitBehaviorTaskResult({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params) as never,
      runId: RUN_ID,
      taskKey: "task|a",
      attemptId: claimedB!.attemptId,
      leaseOwner: "worker-new",
      outcome: "extracted",
      result: { ok: true },
      scenarioCount: 1,
      reviewedCount: 0,
      unresolvedAnchorCount: 0,
    });
    expect(committedNew).toBe(true);
    // member 的 request attempt 不被改写
    expect(state.members[0]!.request_task_attempt_id).toBe(claimedA!.attemptId);
  });

  it("old task attempt cannot commit with a new lease owner", async () => {
    const attempt = await createBatchAttempt(attemptInput("88888888-8888-4888-8888-888888888888"));
    const claimed = await claimBatchAttemptMember(claimInput(attempt.batchAttemptUuid, "task|a", "T1", "worker-old"));
    const taskRowA = state.tasks.find((row) => row.task_key === "task|a")!;
    taskRowA.lease_expires_at_ms = NOW - 1_000;
    const receipts8 = await import("../lib/behavior-unit-receipts");
    const reclaimed = await receipts8.claimBehaviorTask({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params) as never,
      runId: RUN_ID,
      taskKey: "task|a",
      leaseOwner: "worker-new",
      leaseDurationMs: 60_000,
      maxAttempts: 3,
    });
    const receipts = await import("../lib/behavior-unit-receipts");
    // 新 attempt + 旧 owner：fencing 拒绝
    const mixed = await receipts.commitBehaviorTaskResult({
      execute: (sql: string, params: Array<string | number | null>) => attemptDbHolder.router!(sql, params) as never,
      runId: RUN_ID,
      taskKey: "task|a",
      attemptId: reclaimed!.attemptId,
      leaseOwner: "worker-old",
      outcome: "extracted",
      result: {},
      scenarioCount: 0,
      reviewedCount: 0,
      unresolvedAnchorCount: 0,
    });
    expect(mixed).toBe(false);
    expect(claimed!.attemptId).toBeTruthy();
  });

  it("unknown terminal request preserves exact stage and sequence", async () => {
    const attempt = await createBatchAttempt(attemptInput("99999999-9999-4999-8999-999999999999"));
    const grant = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      processingOwner: "worker-1",
      leaseDurationMs: 60_000,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "describe_requesting",
      processingOwner: grant.processingOwner,
      expectedVersion: grant.version,
    });
    const terminalKey = `${attempt.batchAttemptUuid}|describe|1`;
    const unknownAttempt = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "request_outcome_unknown",
      processingOwner: grant.processingOwner,
      expectedVersion: grant.version + 1,
      terminalRequestKey: terminalKey,
    });
    expect(unknownAttempt.executionPhase).toBe("request_outcome_unknown");
    const recovery = await loadBatchAttemptForRecovery({ runId: RUN_ID, batchAttemptUuid: attempt.batchAttemptUuid });
    expect(recovery.attempt.terminalRequestKey).toBe(terminalKey);
    // 终态请求的 stage/sequence 由键精确保存
    const [, stage, sequence] = recovery.attempt.terminalRequestKey!.split("|");
    expect(stage).toBe("describe");
    expect(sequence).toBe("1");
  });

  it("splitting recovery repeats derivation without new model request", async () => {
    const attempt = await createBatchAttempt(attemptInput("aaaaaaa1-1111-4111-8111-111111111111"));
    const grantA = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      processingOwner: "worker-1",
      leaseDurationMs: 60_000,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "describe_requesting",
      processingOwner: grantA.processingOwner,
      expectedVersion: grantA.version,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "describe_persisted",
      processingOwner: grantA.processingOwner,
      expectedVersion: grantA.version + 1,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "judge_requesting",
      processingOwner: grantA.processingOwner,
      expectedVersion: grantA.version + 2,
    });
    await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "judge_persisted",
      processingOwner: grantA.processingOwner,
      expectedVersion: grantA.version + 3,
    });
    const splitting = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "splitting",
      processingOwner: grantA.processingOwner,
      expectedVersion: grantA.version + 4,
    });
    // worker-1 租约过期：worker-2 取得处理权并继续拆分，零新模型请求
    const row = findAttempt(attempt.batchAttemptUuid);
    row.processing_lease_expires_at = mysqlDatetime(NOW - 1_000);
    const grantB = await acquireBatchAttemptProcessing({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      processingOwner: "worker-2",
      leaseDurationMs: 60_000,
    });
    expect(grantB.processingOwner).toBe("worker-2");
    const splitDone = await transitionBatchAttempt({
      runId: RUN_ID,
      batchAttemptUuid: attempt.batchAttemptUuid,
      to: "split_done",
      processingOwner: grantB.processingOwner,
      expectedVersion: grantB.version,
    });
    expect(splitDone.executionPhase).toBe("split_done");
    // 全程未触碰任何模型请求面（fake 调用里没有 batch_requests 语句）
    expect(state.calls.some((call) => call.includes("analysis_behavior_batch_requests"))).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BehaviorTaskLeaseError,
  claimBehaviorTask,
  commitBehaviorTaskResult,
  markBehaviorTaskFailure,
  renewBehaviorTaskLease,
} from "../lib/behavior-unit-receipts";
import type { Execute } from "../lib/db";

/** Task 8 契约（2026-11-19 行为清单全量分析，D7）：执行任务租约与条件提交。
 *  领取是单条原子条件 UPDATE（running/lease_owner/lease_expires_at/attempt_id + attempts 自增）；
 *  只有 pending、重试预算内的 failed/unresolved、租约已过期的 running 可被领取；
 *  提交校验 run_id + task_key_hash + attempt_id + lease_owner + running，陈旧 attempt 返回 false
 *  且绝不覆盖 result_json；成功终态（extracted/no_behavior）恢复时绝不重新执行。 */

const BASE_MS = 1_700_000_000_000;
const LEASE_MS = 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

interface TaskRow {
  run_id: number;
  task_key: string;
  task_key_hash: string;
  unit_key: string;
  unit_key_hash: string;
  kind: string;
  primary_path: string;
  primary_ranges: string | null;
  context_ranges: string;
  anchor_fragments: string;
  anchor_receipts: string | null;
  result_json: string | null;
  status: string;
  attempts: number;
  scenario_count: number;
  reviewed_count: number;
  unresolved_anchor_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_id: string | null;
  detector: string;
  detector_version: string;
  last_error: string | null;
}

function seedTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const taskKey = overrides.task_key ?? "task-1";
  const unitKey = overrides.unit_key ?? "unit-1";
  return {
    run_id: 42,
    task_key: taskKey,
    task_key_hash: sha256(taskKey),
    unit_key: unitKey,
    unit_key_hash: sha256(unitKey),
    kind: "http",
    primary_path: "src/orders.ts",
    primary_ranges: JSON.stringify([{ startLine: 1, endLine: 80 }]),
    context_ranges: JSON.stringify([{ path: "src/db.ts", startLine: 5, endLine: 9 }]),
    anchor_fragments: JSON.stringify([{ anchorKey: "anchor-a", anchorFragmentKey: "fragment-a1" }]),
    anchor_receipts: null,
    result_json: null,
    status: "pending",
    attempts: 0,
    scenario_count: 0,
    reviewed_count: 0,
    unresolved_anchor_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    attempt_id: null,
    detector: "next",
    detector_version: "1",
    last_error: null,
    ...overrides,
  };
}

/** analysis_behavior_tasks 的内存假表：按各条件 UPDATE 的谓词语义判定 affectedRows，
 *  与 MySQL 写入时判定一致；其余 SQL 一律 unrouted 报错，防止实现偷发无条件写。 */
function taskTable(seed: TaskRow[] = []) {
  const rows: TaskRow[] = [...seed];
  const execute = vi.fn(async (statement: string, parameters: Array<string | number | null>) => {
    if (statement.includes("UPDATE analysis_behavior_tasks") && statement.includes("SET status = 'running'")) {
      const [leaseOwner, leaseExpiresAt, attemptId, runId, taskKeyHash, maxAttempts, now] = parameters;
      const row = rows.find((candidate) => candidate.run_id === Number(runId) && candidate.task_key_hash === String(taskKeyHash));
      const claimable =
        row !== undefined &&
        (row.status === "pending" ||
          ((row.status === "failed" || row.status === "unresolved") && row.attempts < Number(maxAttempts)) ||
          (row.status === "running" && row.lease_expires_at !== null && row.lease_expires_at <= String(now)));
      if (!row || !claimable) return [{ affectedRows: 0 }];
      row.status = "running";
      row.lease_owner = String(leaseOwner);
      row.lease_expires_at = String(leaseExpiresAt);
      row.attempt_id = String(attemptId);
      row.attempts += 1;
      row.last_error = null;
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("UPDATE analysis_behavior_tasks") && statement.includes("SET lease_expires_at = ?")) {
      const [leaseExpiresAt, runId, taskKeyHash, attemptId, leaseOwner, now] = parameters;
      const row = rows.find(
        (candidate) =>
          candidate.run_id === Number(runId) &&
          candidate.task_key_hash === String(taskKeyHash) &&
          candidate.attempt_id === String(attemptId) &&
          candidate.lease_owner === String(leaseOwner) &&
          candidate.status === "running" &&
          candidate.lease_expires_at !== null &&
          candidate.lease_expires_at > String(now),
      );
      if (!row) return [{ affectedRows: 0 }];
      row.lease_expires_at = String(leaseExpiresAt);
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("UPDATE analysis_behavior_tasks") && statement.includes("SET status = ?")) {
      const [status, resultJson, scenarioCount, reviewedCount, unresolvedAnchorCount, runId, taskKeyHash, attemptId, leaseOwner] =
        parameters;
      const row = rows.find(
        (candidate) =>
          candidate.run_id === Number(runId) &&
          candidate.task_key_hash === String(taskKeyHash) &&
          candidate.attempt_id === String(attemptId) &&
          candidate.lease_owner === String(leaseOwner) &&
          candidate.status === "running",
      );
      if (!row) return [{ affectedRows: 0 }];
      row.status = String(status);
      row.result_json = String(resultJson);
      row.scenario_count = Number(scenarioCount);
      row.reviewed_count = Number(reviewedCount);
      row.unresolved_anchor_count = Number(unresolvedAnchorCount);
      row.last_error = null;
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("UPDATE analysis_behavior_tasks") && statement.includes("SET status = 'failed'")) {
      const [lastError, runId, taskKeyHash, attemptId, leaseOwner] = parameters;
      const row = rows.find(
        (candidate) =>
          candidate.run_id === Number(runId) &&
          candidate.task_key_hash === String(taskKeyHash) &&
          candidate.attempt_id === String(attemptId) &&
          candidate.lease_owner === String(leaseOwner) &&
          candidate.status === "running",
      );
      if (!row) return [{ affectedRows: 0 }];
      row.status = "failed";
      row.last_error = String(lastError);
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("UPDATE analysis_behavior_tasks") && statement.includes("SET status = 'pending'")) {
      const [runId, taskKeyHash, attemptId, leaseOwner] = parameters;
      const row = rows.find(
        (candidate) =>
          candidate.run_id === Number(runId) &&
          candidate.task_key_hash === String(taskKeyHash) &&
          candidate.attempt_id === String(attemptId) &&
          candidate.lease_owner === String(leaseOwner) &&
          candidate.status === "running",
      );
      if (!row) return [{ affectedRows: 0 }];
      row.status = "pending";
      row.lease_owner = null;
      row.lease_expires_at = null;
      row.last_error = null;
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("SELECT") && statement.includes("FROM analysis_behavior_tasks")) {
      const [runId, taskKeyHash] = parameters;
      return [
        rows
          .filter((row) => row.run_id === Number(runId) && row.task_key_hash === String(taskKeyHash))
          .map((row) => ({ ...row })),
      ];
    }
    throw new Error(`unrouted sql: ${statement}`);
  });
  const statements = () => execute.mock.calls.map(([statement]) => String(statement));
  return { execute: execute as unknown as Execute, rows, statements };
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    runId: 42,
    taskKey: "task-1",
    leaseOwner: "worker-a",
    leaseDurationMs: LEASE_MS,
    maxAttempts: 2,
    nowMs: BASE_MS,
    ...overrides,
  };
}

describe("claimBehaviorTask", () => {
  it("claims a pending task atomically with lease identity and an incremented attempt counter", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    expect(claimed).not.toBeNull();
    expect(claimed!.runId).toBe(42);
    expect(claimed!.taskKey).toBe("task-1");
    expect(claimed!.unitKey).toBe("unit-1");
    expect(claimed!.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed!.leaseOwner).toBe("worker-a");
    expect(claimed!.leaseExpiresAt).toEqual(new Date(BASE_MS + LEASE_MS));
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.primaryPath).toBe("src/orders.ts");
    expect(claimed!.primaryRanges).toEqual([{ startLine: 1, endLine: 80 }]);
    expect(claimed!.contextRanges).toEqual([{ path: "src/db.ts", startLine: 5, endLine: 9 }]);
    expect(claimed!.anchorFragments).toEqual([{ anchorKey: "anchor-a", anchorFragmentKey: "fragment-a1" }]);
    expect(rows[0]).toMatchObject({
      status: "running",
      lease_owner: "worker-a",
      lease_expires_at: mysqlDatetime(BASE_MS + LEASE_MS),
      attempt_id: claimed!.attemptId,
      attempts: 1,
      last_error: null,
    });
  });

  it("issues exactly one conditional UPDATE before reading the claimed row back", async () => {
    const { execute, statements } = taskTable([seedTask()]);
    await claimBehaviorTask({ execute, ...claimInput() });
    const issued = statements();
    expect(issued).toHaveLength(2);
    expect(issued[0]).toContain("UPDATE analysis_behavior_tasks");
    expect(issued[0]).toContain("SET status = 'running'");
    expect(issued[1]).toContain("SELECT");
  });

  it("lets only one of two workers claim the same task", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const first = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    const second = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-b" }) });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lease_owner).toBe("worker-a");
  });

  it("rejects preemption while the lease is still valid", async () => {
    const { execute } = taskTable([seedTask()]);
    await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    const preempt = await claimBehaviorTask({
      execute,
      ...claimInput({ leaseOwner: "worker-b", nowMs: BASE_MS + LEASE_MS - 1 }),
    });
    expect(preempt).toBeNull();
  });

  it("reclaims an expired lease with a fresh attempt id and keeps the attempt counter auditable", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const first = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    const reclaimed = await claimBehaviorTask({
      execute,
      ...claimInput({ leaseOwner: "worker-b", nowMs: BASE_MS + LEASE_MS }),
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attemptId).not.toBe(first!.attemptId);
    expect(reclaimed!.attempts).toBe(2);
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].lease_owner).toBe("worker-b");
  });

  it.each(["extracted", "no_behavior"])("never re-claims a %s task on resume", async (status) => {
    const { execute, rows, statements } = taskTable([seedTask({ status, result_json: '{"scenarios":[]}', attempts: 1 })]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    expect(claimed).toBeNull();
    expect(rows[0].status).toBe(status);
    expect(rows[0].result_json).toBe('{"scenarios":[]}');
    expect(statements().filter((statement) => statement.includes("SELECT"))).toHaveLength(0);
  });

  it.each(["failed", "unresolved"])("reclaims a retry-eligible %s task within the attempt budget", async (status) => {
    const { execute, rows } = taskTable([seedTask({ status, attempts: 1, last_error: "boom" })]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput({ maxAttempts: 2 }) });
    expect(claimed).not.toBeNull();
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].last_error).toBeNull();
  });

  it.each(["failed", "unresolved"])("rejects a %s task that exhausted its retry budget", async (status) => {
    const { execute, rows } = taskTable([seedTask({ status, attempts: 2, last_error: "boom" })]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput({ maxAttempts: 2 }) });
    expect(claimed).toBeNull();
    expect(rows[0].status).toBe(status);
    expect(rows[0].attempts).toBe(2);
  });

  it("hashes the task key with SHA-256 for the conditional claim", async () => {
    const { execute, statements } = taskTable([seedTask()]);
    await claimBehaviorTask({ execute, ...claimInput() });
    const claimUpdate = statements()[0];
    expect(claimUpdate).toContain("task_key_hash = ?");
    const params = (execute as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<string | number | null>;
    expect(params).toContain(sha256("task-1"));
    expect(params).not.toContain("task-1");
  });
});

describe("renewBehaviorTaskLease", () => {
  it("extends the lease for the current attempt owner", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    await renewBehaviorTaskLease({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: claimed!.attemptId,
      leaseOwner: "worker-a",
      leaseDurationMs: LEASE_MS,
      nowMs: BASE_MS + 30_000,
    });
    expect(rows[0].lease_expires_at).toBe(mysqlDatetime(BASE_MS + 30_000 + LEASE_MS));
  });

  it("rejects renewal from a stale attempt without touching the new lease", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const stale = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    const current = await claimBehaviorTask({
      execute,
      ...claimInput({ leaseOwner: "worker-b", nowMs: BASE_MS + LEASE_MS }),
    });
    const error = await renewBehaviorTaskLease({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: stale!.attemptId,
      leaseOwner: "worker-a",
      leaseDurationMs: LEASE_MS,
      nowMs: BASE_MS + LEASE_MS + 1_000,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BehaviorTaskLeaseError);
    expect((error as BehaviorTaskLeaseError).code).toBe("behavior_task_lease_lost");
    expect(rows[0].attempt_id).toBe(current!.attemptId);
    expect(rows[0].lease_expires_at).toBe(mysqlDatetime(BASE_MS + 2 * LEASE_MS));
  });

  it("rejects renewal after the lease already expired", async () => {
    const { execute } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    const error = await renewBehaviorTaskLease({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: claimed!.attemptId,
      leaseOwner: "worker-a",
      leaseDurationMs: LEASE_MS,
      nowMs: BASE_MS + LEASE_MS,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BehaviorTaskLeaseError);
    expect((error as BehaviorTaskLeaseError).code).toBe("behavior_task_lease_lost");
  });
});

describe("commitBehaviorTaskResult", () => {
  function commitInput(attemptId: string, overrides: Record<string, unknown> = {}) {
    return {
      runId: 42,
      taskKey: "task-1",
      attemptId,
      leaseOwner: "worker-a",
      outcome: "extracted" as const,
      result: { scenarios: [{ key: "s-1" }] },
      scenarioCount: 1,
      reviewedCount: 0,
      unresolvedAnchorCount: 0,
      ...overrides,
    };
  }

  it("writes the terminal result for the matching attempt", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    const committed = await commitBehaviorTaskResult({ execute, ...commitInput(claimed!.attemptId) });
    expect(committed).toBe(true);
    expect(rows[0].status).toBe("extracted");
    expect(JSON.parse(rows[0].result_json!)).toEqual({ scenarios: [{ key: "s-1" }] });
    expect(rows[0].scenario_count).toBe(1);
    expect(rows[0].last_error).toBeNull();
  });

  it("returns false for a stale attempt and never overwrites result_json", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const stale = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    const current = await claimBehaviorTask({
      execute,
      ...claimInput({ leaseOwner: "worker-b", nowMs: BASE_MS + LEASE_MS }),
    });
    const staleCommit = await commitBehaviorTaskResult({ execute, ...commitInput(stale!.attemptId) });
    expect(staleCommit).toBe(false);
    expect(rows[0].status).toBe("running");
    expect(rows[0].result_json).toBeNull();
    const currentCommit = await commitBehaviorTaskResult({
      execute,
      ...commitInput(current!.attemptId, { leaseOwner: "worker-b" }),
    });
    expect(currentCommit).toBe(true);
    expect(rows[0].status).toBe("extracted");
  });

  it("rejects a commit from a mismatched lease owner", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    const committed = await commitBehaviorTaskResult({
      execute,
      ...commitInput(claimed!.attemptId, { leaseOwner: "worker-b" }),
    });
    expect(committed).toBe(false);
    expect(rows[0].status).toBe("running");
    expect(rows[0].result_json).toBeNull();
  });

  it("accepts a late commit while the attempt identity is still current even if the lease expired", async () => {
    const { execute, rows, statements } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    // D7：提交校验 attempt 身份（attempt_id + lease_owner + running），不校验租约是否过期——
    // 过期但尚未被重领的迟到提交允许落库；被重领后因 attempt_id 变化自然拒绝。
    const committed = await commitBehaviorTaskResult({
      execute,
      ...commitInput(claimed!.attemptId),
    });
    expect(committed).toBe(true);
    expect(rows[0].status).toBe("extracted");
    const commitUpdate = statements().find((statement) => statement.includes("SET status = ?"));
    expect(commitUpdate).toBeDefined();
    expect(commitUpdate).not.toContain("lease_expires_at");
  });
});

describe("markBehaviorTaskFailure", () => {
  it("marks the current attempt failed with its error for later targeted retry", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    await markBehaviorTaskFailure({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: claimed!.attemptId,
      leaseOwner: "worker-a",
      error: "ai gateway timeout",
    });
    expect(rows[0].status).toBe("failed");
    expect(rows[0].last_error).toBe("ai gateway timeout");
  });

  it("ignores failure marks from stale attempts", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const stale = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-a" }) });
    await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-b", nowMs: BASE_MS + LEASE_MS }) });
    await markBehaviorTaskFailure({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: stale!.attemptId,
      leaseOwner: "worker-a",
      error: "late failure",
    });
    expect(rows[0].status).toBe("running");
    expect(rows[0].lease_owner).toBe("worker-b");
    expect(rows[0].last_error).toBeNull();
  });

  it("returns an aborted-before-first-call attempt to pending without recording a failure", async () => {
    const { execute, rows } = taskTable([seedTask()]);
    const claimed = await claimBehaviorTask({ execute, ...claimInput() });
    await markBehaviorTaskFailure({
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: claimed!.attemptId,
      leaseOwner: "worker-a",
      error: "abort before first call",
      abortedBeforeExecution: true,
    });
    // 预算随 release 全额释放，任务状态同样恢复到未消耗：可立即重领，不占用重试预算。
    expect(rows[0].status).toBe("pending");
    expect(rows[0].lease_owner).toBeNull();
    expect(rows[0].lease_expires_at).toBeNull();
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].attempts).toBe(1);
    const reclaimed = await claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "worker-b" }) });
    expect(reclaimed).not.toBeNull();
  });
});

describe("input validation", () => {
  it("rejects invalid claim input before issuing any SQL", async () => {
    const { execute, statements } = taskTable([seedTask()]);
    await expect(claimBehaviorTask({ execute, ...claimInput({ runId: 0 }) })).rejects.toThrow(/runId/);
    await expect(claimBehaviorTask({ execute, ...claimInput({ taskKey: "" }) })).rejects.toThrow(/taskKey/);
    await expect(claimBehaviorTask({ execute, ...claimInput({ leaseOwner: "" }) })).rejects.toThrow(/leaseOwner/);
    await expect(claimBehaviorTask({ execute, ...claimInput({ leaseDurationMs: 0 }) })).rejects.toThrow(/leaseDurationMs/);
    await expect(claimBehaviorTask({ execute, ...claimInput({ maxAttempts: 0 }) })).rejects.toThrow(/maxAttempts/);
    expect(statements()).toHaveLength(0);
  });

  it("rejects invalid commit input before issuing any SQL", async () => {
    const { execute, statements } = taskTable([seedTask()]);
    const base = {
      execute,
      runId: 42,
      taskKey: "task-1",
      attemptId: "a",
      leaseOwner: "worker-a",
      outcome: "extracted" as const,
      result: {},
      scenarioCount: 1,
      reviewedCount: 0,
      unresolvedAnchorCount: 0,
    };
    await expect(commitBehaviorTaskResult({ ...base, scenarioCount: -1 })).rejects.toThrow(/scenarioCount/);
    await expect(commitBehaviorTaskResult({ ...base, outcome: "running" as never })).rejects.toThrow(/outcome/);
    expect(statements()).toHaveLength(0);
  });
});

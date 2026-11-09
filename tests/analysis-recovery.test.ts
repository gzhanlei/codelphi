import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchStuckQueuedRuns, orphanedRunMessage, QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES, recoverInterruptedRuns, supersededRunMessagePrefix, type QueuedRunGate } from "../lib/analysis-recovery";

const runAnalysis = vi.fn(async () => undefined);
const gatePass: QueuedRunGate = vi.fn(async () => ({ dispatch: true, reason: "gate_passed" }));
const gateBlock: QueuedRunGate = vi.fn(async () => ({ dispatch: false, reason: "quota_exceeded" }));

interface RouterState {
  requeueAffected: number;
  bootQueue: Array<Record<string, unknown>>;
  stuckNewest: Array<Record<string, unknown>>;
}

/** SQL 关键字路由 mock：按片段分发返回值，适配派发路径里可变次数的认领 UPDATE。 */
function sqlRouter() {
  const state: RouterState = { requeueAffected: 0, bootQueue: [], stuckNewest: [] };
  const execute = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("WHERE status = 'running' OR (status = 'failed' AND error_message = ?)")) return [{ affectedRows: state.requeueAffected }];
    if (sql.includes("FROM analysis_runs WHERE status = 'queued' AND started_at IS NULL ORDER BY id")) return [state.bootQueue];
    if (sql.includes("MAX(id) AS max_id")) return [state.stuckNewest];
    if (sql.includes("SET status = 'failed', error_message = ?")) return [{ affectedRows: 1 }];
    if (sql.includes("SET started_at = CURRENT_TIMESTAMP(3)")) return [{ affectedRows: 1 }];
    throw new Error(`unrouted sql: ${sql}`);
  });
  const calls = () => execute.mock.calls as unknown as Array<[string, unknown[]]>;
  return { execute, state, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startup analysis recovery", () => {
  it("re-queues orphaned running runs and legacy orphan-failures, then re-dispatches the whole queue", async () => {
    const { execute, state } = sqlRouter();
    state.requeueAffected = 2;
    state.bootQueue = [
      { id: 51, triggerType: "push", accountId: 7 },
      { id: 57, triggerType: "manual", accountId: 7 },
      { id: 64, triggerType: "push", accountId: 7 },
    ];
    const result = await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    expect(result).toEqual({ requeued: 2, dispatched: 3 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status = 'running' OR (status = 'failed' AND error_message = ?)"),
      [orphanedRunMessage],
    );
    expect(runAnalysis).toHaveBeenCalledTimes(3);
    expect(runAnalysis).toHaveBeenCalledWith(64);
  });

  it("never leaves an orphaned run visible as failed: the re-queue clears the error marker", async () => {
    const { execute, state } = sqlRouter();
    state.requeueAffected = 1;
    state.bootQueue = [{ id: 92, triggerType: "manual", accountId: 7 }];
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    const requeueSql = sqlRouterFirstSql(execute);
    expect(requeueSql).toContain("error_message = NULL");
    expect(requeueSql).toContain("finished_at = NULL");
  });

  it("does not resurrect genuinely failed runs (other error messages stay failed)", async () => {
    const { execute, state } = sqlRouter();
    state.bootQueue = [{ id: 51, triggerType: "manual", accountId: 7 }];
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    expect(sqlRouterFirstSql(execute)).not.toContain("WHERE status = 'failed' AND error_message IS NOT NULL");
  });

  it("keeps billing-gated queued runs queued instead of dispatching them into certain failure", async () => {
    const { execute, state } = sqlRouter();
    state.bootQueue = [{ id: 51, triggerType: "push", accountId: 7 }];
    const result = await recoverInterruptedRuns(runAnalysis, execute, gateBlock);
    expect(result).toEqual({ requeued: 0, dispatched: 0 });
    expect(gateBlock).toHaveBeenCalledWith({ id: 51, triggerType: "push", accountId: 7 });
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("keeps re-dispatching when one queued run fails immediately", async () => {
    const { execute, state } = sqlRouter();
    state.bootQueue = [
      { id: 51, triggerType: "push", accountId: 7 },
      { id: 57, triggerType: "manual", accountId: 7 },
    ];
    runAnalysis.mockRejectedValueOnce(new Error("boom"));
    await expect(recoverInterruptedRuns(runAnalysis, execute, gatePass)).resolves.toEqual({ requeued: 0, dispatched: 2 });
    expect(runAnalysis).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there is nothing to recover", async () => {
    const { execute } = sqlRouter();
    await expect(recoverInterruptedRuns(runAnalysis, execute, gatePass)).resolves.toEqual({ requeued: 0, dispatched: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});

describe("stuck queued run recovery (sweep entry)", () => {
  it("supersedes older queued runs and dispatches only the newest per repository", async () => {
    const { execute, state, calls } = sqlRouter();
    state.stuckNewest = [
      { id: 139, repositoryId: 8, triggerType: "push", accountId: 7 },
      { id: 140, repositoryId: 11, triggerType: "push", accountId: 7 },
    ];
    const result = await dispatchStuckQueuedRuns(runAnalysis, execute, gatePass);
    expect(result).toEqual({ superseded: 2, dispatched: 2 });
    const supersedeCalls = calls().filter(([sql]) => sql.includes("SET status = 'failed', error_message = ?"));
    expect(supersedeCalls.map(([, params]) => params)).toEqual([
      [`${supersededRunMessagePrefix} newer queued run 139 covers this repository's pending pushes`, 8, 139],
      [`${supersededRunMessagePrefix} newer queued run 140 covers this repository's pending pushes`, 11, 140],
    ]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INTERVAL ? MINUTE"), [QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES]);
    expect(runAnalysis).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest run queued (and still supersedes stale ones) when the billing gate blocks dispatch", async () => {
    const { execute, state, calls } = sqlRouter();
    state.stuckNewest = [{ id: 139, repositoryId: 8, triggerType: "push", accountId: 7 }];
    const result = await dispatchStuckQueuedRuns(runAnalysis, execute, gateBlock);
    expect(result).toEqual({ superseded: 1, dispatched: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
    expect(calls().filter(([sql]) => sql.includes("SET started_at = CURRENT_TIMESTAMP(3)"))).toHaveLength(0);
  });

  it("skips a candidate that loses the atomic claim (already dispatched elsewhere)", async () => {
    const { state } = sqlRouter();
    state.stuckNewest = [{ id: 139, repositoryId: 8, triggerType: "push", accountId: 7 }];
    const execute = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("MAX(id) AS max_id")) return [state.stuckNewest];
      if (sql.includes("SET status = 'failed', error_message = ?")) return [{ affectedRows: 0 }];
      if (sql.includes("SET started_at = CURRENT_TIMESTAMP(3)")) return [{ affectedRows: 0 }];
      throw new Error(`unrouted sql: ${sql}`);
    });
    const result = await dispatchStuckQueuedRuns(runAnalysis, execute, gatePass);
    expect(result).toEqual({ superseded: 0, dispatched: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it("does nothing when every queued run is younger than the threshold", async () => {
    const { execute } = sqlRouter();
    await expect(dispatchStuckQueuedRuns(runAnalysis, execute, gatePass)).resolves.toEqual({ superseded: 0, dispatched: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});

function sqlRouterFirstSql(execute: ReturnType<typeof vi.fn>): string {
  return (execute.mock.calls as unknown as Array<[string, unknown[]]>)[0][0];
}

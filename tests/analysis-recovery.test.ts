import { readFileSync } from "node:fs";
import path from "node:path";
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
    if (sql.includes("status = 'running'") && sql.includes("OR (status = 'failed' AND error_message = ?)")) return [{ affectedRows: state.requeueAffected }];
    if (sql.includes("SELECT r.id, r.trigger_type AS triggerType, r.account_id AS accountId")) return [state.bootQueue];
    if (sql.includes("MAX(r.id) AS max_id")) return [state.stuckNewest];
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
      expect.stringContaining("status = 'running'"),
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

  it("reclaims claimed-but-still-queued runs (crash between sweep claim and performAnalysis)", async () => {
    // sweep 认领（started_at 置位）后进程被杀：run 停在 queued+started_at 非空，
    // 启动恢复与积压 sweep 都看不到它（各自过滤 started_at IS NULL）→ 永久卡死。
    // 启动时单实例无并发持有者：把这类行释放回可认领状态。
    const { execute } = sqlRouter();
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    expect(sqlRouterFirstSql(execute)).toContain("status = 'queued' AND started_at IS NOT NULL");
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

  it("never re-queues or dispatches runs the server does not execute", async () => {
    // client_upload 的 run 是客户端发布的回执，产品由客户端分析时服务端不跑分析。启动恢复不能把它们捞出来。
    const { execute } = sqlRouter();
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    const statements = execute.mock.calls.map((call) => call[0] as string);
    const requeue = statements[0];
    expect(requeue).toContain("trigger_type <> 'client_upload'");
    expect(requeue).toContain("WHERE p.analysis_executor = 'client'");
    // 条件括在状态条件的外面：只排除不归服务端执行的 run，不改哪些状态会被重排。
    expect(requeue).toMatch(/WHERE \(status = 'running'[\s\S]*started_at IS NOT NULL\)\)\s+AND trigger_type <> 'client_upload'/);
    const candidates = statements[1];
    expect(candidates).toContain("r.status = 'queued' AND r.started_at IS NULL");
    expect(candidates).toContain("JOIN products p ON p.id = repo.product_id");
    expect(candidates).toContain("r.trigger_type <> 'client_upload' AND p.analysis_executor <> 'client'");
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
      if (sql.includes("MAX(r.id) AS max_id")) return [state.stuckNewest];
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

  it("leaves runs the server does not execute out of the newest-per-repository query", async () => {
    const { execute, calls } = sqlRouter();
    await dispatchStuckQueuedRuns(runAnalysis, execute, gatePass);
    const newest = calls()[0][0];
    // 排除放在「每个仓库最新一条」的子查询里：客户端分析的仓库整段不出现，它的旧 run 也不会被顺手标成 superseded。
    expect(newest).toMatch(/SELECT r\.repository_id, MAX\(r\.id\) AS max_id[\s\S]*r\.trigger_type <> 'client_upload' AND p\.analysis_executor <> 'client'[\s\S]*GROUP BY r\.repository_id/);
    expect(newest).toContain("JOIN products p ON p.id = repo.product_id");
  });
});

describe("inventory run recovery semantics (Task 14)", () => {
  const source = readFileSync(path.join(__dirname, "..", "lib", "analysis-recovery.ts"), "utf8");

  it("documents that inventory runs resume from the verified manifest, result_json and leases", () => {
    // 新路径（inventory 编排）的孤儿 run 可能已有中间产物：不可变 manifest、成功终态
    // 任务的 result_json、共享预算行与租约。恢复语义必须成文——重跑由编排层复用这些
    // 产物续跑，而不是按 legacy 假设整 run 裸重跑。
    expect(source).toContain("manifest");
    expect(source).toContain("result_json");
    expect(source).toContain("inventory_version_conflict");
  });

  it("no longer claims every orphaned run has no recoverable intermediate products", () => {
    // 「所有孤儿 run 都没有落库、重跑即幂等」只对 legacy 分区路径成立；
    // inventory 路径的恢复绝不清空成功任务、绝不重新生成清单。
    expect(source).not.toContain("孤儿 run 必然没有落库");
  });

  it("never requeues inventory_version_conflict failures: the orphan predicate is an exact message match", async () => {
    // inventory_version_conflict 的 run 以各自错误消息落库、必须在原 run 之外新建 run。
    // 孤儿恢复只等值匹配 orphanedRunMessage——冲突失败永远不会被重排队，
    // 不存在「冲突 → 重跑 → 自动重建 manifest」的自愈循环。
    const { execute } = sqlRouter();
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    const [sql, params] = (execute.mock.calls as unknown as Array<[string, unknown[]]>)[0];
    expect(sql).toContain("error_message = ?");
    expect(sql).not.toMatch(/error_message\s+(LIKE|IN)/i);
    expect(params).toEqual([orphanedRunMessage]);
    expect(orphanedRunMessage).not.toContain("inventory_version_conflict");
  });

  it("never touches inventory persistence tables: successful tasks are never cleared by recovery", async () => {
    // 恢复只重置 analysis_runs 状态并重新派发；任务回执/manifest/预算行由编排层自己
    // 恢复与清理，本路径任何 SQL 都不得触碰它们（清空成功任务 = 重复 LLM 调用与账单）。
    const { execute, state } = sqlRouter();
    state.requeueAffected = 1;
    state.bootQueue = [{ id: 51, triggerType: "push", accountId: 7 }];
    await recoverInterruptedRuns(runAnalysis, execute, gatePass);
    for (const [sql] of execute.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(sql).not.toContain("analysis_behavior_tasks");
      expect(sql).not.toContain("analysis_behavior_manifests");
      expect(sql).not.toContain("analysis_run_budgets");
    }
  });
});

function sqlRouterFirstSql(execute: ReturnType<typeof vi.fn>): string {
  return (execute.mock.calls as unknown as Array<[string, unknown[]]>)[0][0];
}

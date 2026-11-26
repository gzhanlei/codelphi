import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../lib/analysis";
import { assertServerExecuted, ClientAnalysisError, loadAnalysisExecutor, serverMayExecute, SERVER_EXECUTED_RUN_UNJOINED_SQL, serverExecutedRunSql } from "../lib/analysis-executor";
import { enqueueRunWithReservation, enqueueRunWithReservationInTransaction } from "../lib/billing/core";

const dbMock = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../lib/db", () => ({ getDb: () => dbMock.db }));

const enqueueInput = { repositoryId: 3, beforeSha: null, afterSha: "sha-after", trigger: "manual" as const, requestId: "request-1" };

/** 一个只认得「谁来分析」这条查询的连接：命中就按参数回答，别的语句一律报错——走到别的语句说明闸门没拦住。 */
function gateConnection(executor: "server" | "client") {
  const calls: Array<[string, unknown[]]> = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push([sql, params]);
      if (sql.includes("p.analysis_executor AS analysisExecutor")) return [[{ analysisExecutor: executor }], []];
      throw new Error(`闸门没有拦住，托管分析走到了这里：${sql}`);
    }),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  return { connection, calls };
}

/** runAnalysis 用的数据库替身。认领那条语句的影响行数由调用方给：0 行表示并发派发里输了，正常路径到此安静返回。 */
function runDatabase(run: Record<string, unknown>, claimAffected = 0) {
  const calls: Array<[string, unknown[]]> = [];
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push([sql, params]);
    if (sql.includes("WHERE r.id = ? AND r.status IN ('queued', 'failed')")) return [[run], []];
    if (sql.includes("SET status = 'running'")) return [{ affectedRows: claimAffected }, []];
    return [{ affectedRows: 1 }, []];
  });
  dbMock.db = { execute, getConnection: vi.fn() };
  return { execute, calls };
}

const baseRun = {
  id: 5,
  repositoryId: 3,
  productId: 4,
  owner: "gzhanlei",
  name: "radar",
  beforeSha: null,
  afterSha: "sha-after",
  connectionId: null,
  provider: "github",
  organizationId: 1,
  productSlug: "radar",
  productName: "Radar",
};

beforeEach(() => {
  dbMock.db = undefined;
});

describe("analysis executor gate", () => {
  it("says only server-executed runs may run: neither client_upload runs nor runs of a client-analysed product", () => {
    expect(serverMayExecute({ triggerType: "manual", executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: "push", executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: null, executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: "client_upload", executor: "server" })).toBe(false);
    expect(serverMayExecute({ triggerType: "manual", executor: "client" })).toBe(false);
    expect(serverMayExecute({ triggerType: "client_upload", executor: "client" })).toBe(false);
  });

  it("reads the executor from the product and treats anything unknown as server", async () => {
    const answer = (rows: unknown[]) => vi.fn(async () => [rows, []]);
    expect(await loadAnalysisExecutor(3, answer([{ analysisExecutor: "client" }]))).toBe("client");
    expect(await loadAnalysisExecutor(3, answer([{ analysisExecutor: "server" }]))).toBe("server");
    expect(await loadAnalysisExecutor(3, answer([{}]))).toBe("server");
    expect(await loadAnalysisExecutor(3, answer([]))).toBe("server");
  });

  it("refuses to enqueue inside an existing transaction before the account is locked or a run row is written", async () => {
    const { connection, calls } = gateConnection("client");
    await expect(enqueueRunWithReservationInTransaction(connection as never, enqueueInput)).rejects.toBeInstanceOf(ClientAnalysisError);
    await expect(enqueueRunWithReservationInTransaction(connection as never, enqueueInput)).rejects.toMatchObject({ code: "analysis_mode_is_client" });
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual([3]);
  });

  it("lets a server-analysed product through the gate", async () => {
    const execute = vi.fn(async () => [[{ analysisExecutor: "server" }], []]);
    await expect(assertServerExecuted(3, execute as never)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith("SELECT p.analysis_executor AS analysisExecutor FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?", [3]);
  });

  it("refuses the single-transaction enqueue too, and nothing is committed", async () => {
    const { connection } = gateConnection("client");
    dbMock.db = { execute: vi.fn(), getConnection: async () => connection };
    await expect(enqueueRunWithReservation(enqueueInput)).rejects.toMatchObject({ code: "analysis_mode_is_client" });
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
  });
});

describe("runAnalysis refuses what the server must not execute", () => {
  it("fails a queued run of a client-analysed product without claiming it", async () => {
    const { execute, calls } = runDatabase({ ...baseRun, triggerType: "manual", analysisExecutor: "client" });
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status <> 'succeeded'",
      [expect.stringContaining("analysis_mode_is_client"), 5],
    );
    expect(calls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("SET status = 'running'"), expect.anything());
  });

  it("fails a client_upload run even when the product is marked server", async () => {
    const { execute } = runDatabase({ ...baseRun, triggerType: "client_upload", analysisExecutor: "server" });
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [expect.stringMatching(/^analysis_mode_is_client: a client_upload run/), 5],
    );
  });

  it("leaves a run of a server-analysed product to the normal path", async () => {
    const { execute, calls } = runDatabase({ ...baseRun, triggerType: "manual", analysisExecutor: "server" });
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    // 走到了认领那一步（替身让它输掉认领，正常路径到此返回），没有被标成拒绝执行。
    expect(calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("WHERE r.id = ? AND r.status IN ('queued', 'failed')"),
      expect.stringContaining("SET status = 'running', started_at = CURRENT_TIMESTAMP(3)"),
    ]);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("analysis_mode_is_client"), expect.anything());
  });
});

describe("recovery queries carry the same rule", () => {
  it("excludes client_upload runs and runs of client-analysed products, with whatever alias the query uses", () => {
    expect(serverExecutedRunSql()).toBe("r.trigger_type <> 'client_upload' AND p.analysis_executor <> 'client'");
    expect(serverExecutedRunSql("queued")).toBe("queued.trigger_type <> 'client_upload' AND p.analysis_executor <> 'client'");
    expect(SERVER_EXECUTED_RUN_UNJOINED_SQL).toContain("trigger_type <> 'client_upload'");
    expect(SERVER_EXECUTED_RUN_UNJOINED_SQL).toContain("WHERE p.analysis_executor = 'client'");
  });
});

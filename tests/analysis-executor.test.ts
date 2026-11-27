import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../lib/analysis";
import { currentOrganizationModel } from "../lib/organization-model";
import { encryptSecret } from "../lib/secret-box";
import { assertServerExecuted, ClientAnalysisError, isReceiptTrigger, loadAnalysisExecutor, loadProductAnalysisMode, MODEL_NOT_CONFIGURED, ModelNotConfiguredError, serverMayExecute, SERVER_EXECUTED_RUN_UNJOINED_SQL, serverExecutedRunSql, switchAnalysisExecutor } from "../lib/analysis-executor";
import { enqueueRunWithReservation, enqueueRunWithReservationInTransaction } from "../lib/billing/core";

const dbMock = vi.hoisted(() => ({ db: undefined as unknown }));
// 读工作区模型配置的那个模块用的是 db 模块的 defaultExecute：这里让它和 getDb 指向同一个替身。
vi.mock("../lib/db", () => ({
  getDb: () => dbMock.db,
  defaultExecute: (statement: string, parameters?: unknown[]) => (dbMock.db as { execute: (sql: string, params?: unknown[]) => Promise<unknown> }).execute(statement, parameters),
}));

const enqueueInput = { repositoryId: 3, beforeSha: null, afterSha: "sha-after", trigger: "manual" as const, requestId: "request-1" };

/** 一个只认得「谁来分析、工作区有没有自己的模型」这一条查询的连接：命中就按参数回答，别的语句一律报错——走到别的语句说明闸门没拦住。 */
function gateConnection(executor: "server" | "client", modelConfigured = true) {
  const calls: Array<[string, unknown[]]> = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push([sql, params]);
      if (sql.includes("p.analysis_executor AS analysisExecutor")) return [[{ analysisExecutor: executor, modelConfigured: modelConfigured ? 1 : 0 }], []];
      throw new Error(`闸门没有拦住，托管分析走到了这里：${sql}`);
    }),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  return { connection, calls };
}

/**
 * 工作区配了自己的模型时的替身：认领成功，分析的第一条语句记下当时绑定的模型，然后故意停下来。
 * withModel 为 false 时库里没有那一行（检查和工作之间被人删了）。
 */
function configured(run: Record<string, unknown>, claimAffected: number, seen: unknown[], withModel = true) {
  const calls: Array<[string, unknown[]]> = [];
  let stopped = false;
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push([sql, params]);
    if (sql.includes("WHERE r.id = ? AND r.status IN ('queued', 'failed')")) return [[run], []];
    if (sql.includes("FROM organization_models WHERE organization_id = ?")) return [withModel ? [modelRow()] : [], []];
    if (sql.includes("SET status = 'running'")) return [{ affectedRows: claimAffected }, []];
    if (sql.includes("UPDATE analysis_runs SET status = 'failed'")) return [{ affectedRows: 1 }, []];
    // 分析真正干活的第一条语句：记下当时绑定的模型，然后故意停下来。之后的语句（标失败、释放预留）照常回答。
    if (!stopped) {
      stopped = true;
      seen.push(currentOrganizationModel());
      throw new Error("stopped on purpose before any real work");
    }
    return [{ affectedRows: 1 }, []];
  });
  dbMock.db = { execute, getConnection: vi.fn() };
  return { execute, calls };
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
  vi.stubEnv("SESSION_SECRET", "unit-test-secret");
});
afterEach(() => vi.unstubAllEnvs());

/** 工作区的模型行，按库里的样子（密文）。 */
const modelRow = () => ({ base_url: "https://api.example/v1", api_key_encrypted: encryptSecret("sk-workspace", "unit-test-secret"), model: "k3-256k" });

describe("analysis executor gate", () => {
  it("says only server-executed runs may run: neither receipt runs nor runs of a client-analysed product", () => {
    expect(serverMayExecute({ triggerType: "manual", executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: "push", executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: null, executor: "server" })).toBe(true);
    expect(serverMayExecute({ triggerType: "client_upload", executor: "server" })).toBe(false);
    expect(serverMayExecute({ triggerType: "import_backfill", executor: "server" })).toBe(false);
    expect(serverMayExecute({ triggerType: "manual", executor: "client" })).toBe(false);
    expect(serverMayExecute({ triggerType: "client_upload", executor: "client" })).toBe(false);
  });

  it("knows the two receipt triggers and nothing else: a run row is a receipt only when one transaction creates it finished", () => {
    expect(isReceiptTrigger("client_upload")).toBe(true);
    expect(isReceiptTrigger("import_backfill")).toBe(true);
    for (const other of ["manual", "push", "webhook", "", null, "CLIENT_UPLOAD"]) expect(isReceiptTrigger(other)).toBe(false);
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

  const GATE_SQL = "SELECT p.analysis_executor AS analysisExecutor, EXISTS(SELECT 1 FROM organization_models m WHERE m.organization_id = p.organization_id) AS modelConfigured FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?";

  it("lets a server-analysed product through the gate when its workspace has a model of its own", async () => {
    const execute = vi.fn(async () => [[{ analysisExecutor: "server", modelConfigured: 1 }], []]);
    await expect(assertServerExecuted(3, execute as never)).resolves.toBeUndefined();
    // 一条查询同时回答两件事：仍在锁账户之前，没有多出来的读。
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(GATE_SQL, [3]);
  });

  it("refuses a server-analysed product whose workspace has no model of its own, in the same place and before anything is written", async () => {
    const { connection, calls } = gateConnection("server", false);
    await expect(enqueueRunWithReservationInTransaction(connection as never, enqueueInput)).rejects.toBeInstanceOf(ModelNotConfiguredError);
    await expect(enqueueRunWithReservationInTransaction(connection as never, enqueueInput)).rejects.toMatchObject({ code: MODEL_NOT_CONFIGURED });
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual([3]);
    dbMock.db = { execute: vi.fn(), getConnection: async () => connection };
    await expect(enqueueRunWithReservation(enqueueInput)).rejects.toMatchObject({ code: MODEL_NOT_CONFIGURED });
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
    // 仓库不存在时找不到工作区，也就没有模型：同样拒绝，而不是放过去让后面报错。
    await expect(assertServerExecuted(3, vi.fn(async () => [[], []]) as never)).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });

  it("refuses the single-transaction enqueue too, and nothing is committed", async () => {
    const { connection } = gateConnection("client");
    dbMock.db = { execute: vi.fn(), getConnection: async () => connection };
    await expect(enqueueRunWithReservation(enqueueInput)).rejects.toMatchObject({ code: "analysis_mode_is_client" });
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.commit).not.toHaveBeenCalled();
  });
});

describe("reading how a product is analysed", () => {
  it("tells the settings page who analyses a product and whether its workspace has a model, in one query", async () => {
    const execute = vi.fn(async (_statement: string, _parameters: unknown[] = []) => [[{ analysisExecutor: "client", modelConfigured: 0 }], []]);
    expect(await loadProductAnalysisMode(4, execute as never)).toEqual({ executor: "client", modelConfigured: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain("AS modelConfigured");
    expect(execute.mock.calls[0][0]).toContain("FROM products p WHERE p.id = ?");
    expect(execute.mock.calls[0][1]).toEqual([4]);
    // 产品不在了：null，由调用方去报错。
    expect(await loadProductAnalysisMode(4, vi.fn(async () => [[], []]) as never)).toBeNull();
  });
});

describe("switching how a product is analysed", () => {
  it("refuses to switch a product to server analysis while its workspace has no model of its own, and changes nothing", async () => {
    const execute = vi.fn(async (_statement: string, _parameters: unknown[] = []) => [[{ modelConfigured: 0 }], []]);
    await expect(switchAnalysisExecutor(4, "server", execute as never)).rejects.toMatchObject({ code: MODEL_NOT_CONFIGURED });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain("AS modelConfigured");
    expect(execute.mock.calls[0][1]).toEqual([4]);
    // 产品已经不在了：也说清楚，而不是说成「没配模型」。
    await expect(switchAnalysisExecutor(4, "server", vi.fn(async () => [[], []]) as never)).rejects.toThrow(/not found/);
  });

  it("switches to server analysis once the workspace has a model, and to client analysis without asking", async () => {
    const execute = vi.fn(async () => [[{ modelConfigured: 1 }], []]);
    await expect(switchAnalysisExecutor(4, "server", execute as never)).resolves.toBeUndefined();
    expect(execute).toHaveBeenLastCalledWith("UPDATE products SET analysis_executor = ? WHERE id = ?", ["server", 4]);
    const noRead = vi.fn(async () => [{ affectedRows: 1 }]);
    await expect(switchAnalysisExecutor(4, "client", noRead as never)).resolves.toBeUndefined();
    expect(noRead).toHaveBeenCalledTimes(1);
    expect(noRead).toHaveBeenCalledWith("UPDATE products SET analysis_executor = ? WHERE id = ?", ["client", 4]);
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

  it("fails an import_backfill run even when the product is marked server", async () => {
    const { execute } = runDatabase({ ...baseRun, triggerType: "import_backfill", analysisExecutor: "server" });
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [expect.stringMatching(/^analysis_mode_is_client: a import_backfill run is the receipt of an import backfill/), 5],
    );
  });

  it("leaves a run of a server-analysed product to the normal path once its workspace's model is bound", async () => {
    const { execute, calls } = configured({ ...baseRun, triggerType: "manual", analysisExecutor: "server", analysisModelConfigured: true }, 0, []);
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    // 读工作区的模型、认领（替身让它输掉认领，正常路径到此返回），没有被标成拒绝执行。
    expect(calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("WHERE r.id = ? AND r.status IN ('queued', 'failed')"),
      expect.stringContaining("FROM organization_models WHERE organization_id = ?"),
      expect.stringContaining("SET status = 'running', started_at = CURRENT_TIMESTAMP(3)"),
    ]);
    expect(calls[1][1]).toEqual([1]);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("analysis_mode_is_client"), expect.anything());
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("model_not_configured"), expect.anything());
  });

  it("fails a queued run whose workspace has no model of its own, without claiming it", async () => {
    const { execute, calls } = runDatabase({ ...baseRun, triggerType: "manual", analysisExecutor: "server", analysisModelConfigured: false });
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      "UPDATE analysis_runs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status <> 'succeeded'",
      [expect.stringMatching(/^model_not_configured/), 5],
    );
    expect(calls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("SET status = 'running'"), expect.anything());
    // 一条查询同时回答两件事：读 run 的那条语句里就带着「工作区有没有模型」。
    expect(calls[0][0]).toContain("AS analysisModelConfigured");
  });

  it("makes the workspace's own model visible to every model call the analysis makes", async () => {
    const seen: unknown[] = [];
    const { execute } = configured({ ...baseRun, triggerType: "manual", analysisExecutor: "server", analysisModelConfigured: true }, 1, seen);
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(seen).toEqual([{ organizationId: 1, baseUrl: "https://api.example/v1", apiKey: "sk-workspace", model: "k3-256k" }]);
    // 分析抛出的错照常把 run 标失败；出了干活的范围，绑定也就没有了。
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("SET status = 'failed'"), [expect.stringContaining("stopped on purpose"), 5]);
    expect(currentOrganizationModel()).toBeNull();
  });

  it("does not fall back to the server's own model when the workspace's configuration disappears between the check and the work", async () => {
    const { execute } = configured({ ...baseRun, triggerType: "manual", analysisExecutor: "server", analysisModelConfigured: true }, 1, [], false);
    await expect(runAnalysis(5)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("SET status = 'failed'"), [expect.stringContaining("model_not_configured"), 5]);
  });
});

describe("recovery queries carry the same rule", () => {
  it("excludes both receipt triggers and runs of client-analysed products, with whatever alias the query uses", () => {
    expect(serverExecutedRunSql()).toBe("r.trigger_type NOT IN ('client_upload', 'import_backfill') AND p.analysis_executor <> 'client'");
    expect(serverExecutedRunSql("queued")).toBe("queued.trigger_type NOT IN ('client_upload', 'import_backfill') AND p.analysis_executor <> 'client'");
    expect(SERVER_EXECUTED_RUN_UNJOINED_SQL).toContain("trigger_type NOT IN ('client_upload', 'import_backfill')");
    expect(SERVER_EXECUTED_RUN_UNJOINED_SQL).toContain("WHERE p.analysis_executor = 'client'");
  });
});

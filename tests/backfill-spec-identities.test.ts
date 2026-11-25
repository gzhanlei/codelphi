import { describe, expect, it, vi } from "vitest";
import type { Execute } from "../lib/db";
import { planVersionIdentities, type VersionIdentities, type IdentityRegistry } from "../lib/spec-identity";
import { assignVersionIdentities, type IdentityRows } from "../lib/spec-identity-store";
import { backfill, backfillRepository, dbBackfillSource, loadIdentityRows, parseArgs, poolTransaction, renderReport, type BackfillRepository, type BackfillSource, type BackfillWrite, type RepositoryBackfillReport } from "../scripts/backfill-spec-identities";

const feature = (id: number, name: string, parentKey: string | null = null) => ({ id, name, parentKey });
const scenario = (id: number, featureId: number, reference: string) => ({ id, featureId, reference });
const change = (id: number, featureKey: string, scenarioReference = "") => ({ id, featureKey, scenarioReference });

/** 内存数据源：每个仓库一条版本链，版本号从 仓库号×1000 起。 */
function memorySource(chains: Record<number, { productId: number; versions: IdentityRows[] }>) {
  const reads: number[] = [];
  const source: BackfillSource = {
    repositories: async (repositoryIds) =>
      Object.entries(chains)
        .filter(([id]) => repositoryIds.length === 0 || repositoryIds.includes(Number(id)))
        .map(([id, chain]) => ({ repositoryId: Number(id), productId: chain.productId })),
    versions: async (repositoryId) => chains[repositoryId].versions.map((_, index) => repositoryId * 1000 + index),
    rows: async (specVersionId) => {
      reads.push(specVersionId);
      return chains[Math.floor(specVersionId / 1000)].versions[specVersionId % 1000];
    },
  };
  return { source, reads };
}

describe("参数解析", () => {
  it("rehearses every repository unless told otherwise", () => {
    expect(parseArgs([])).toEqual({ repositoryIds: [], apply: false });
  });

  it("takes selected repositories and the apply switch", () => {
    expect(parseArgs(["--repository", "8", "--repository", "11", "--apply"])).toEqual({ repositoryIds: [8, 11], apply: true });
  });

  it("refuses arguments it does not understand instead of guessing", () => {
    expect(() => parseArgs(["--force"])).toThrow(/不认识的参数/);
    expect(() => parseArgs(["--repository"])).toThrow(/缺少取值/);
    expect(() => parseArgs(["--repository", "eight"])).toThrow(/仓库号/);
  });
});

describe("一个仓库的回填", () => {
  const chain = {
    productId: 4,
    versions: [
      { features: [feature(1, "统一登录"), feature(2, "支付")], scenarios: [scenario(10, 1, "HP-1")], changes: [change(20, "统一登录"), change(21, "支付")] },
      { features: [feature(30, "统一登录"), feature(40, "会话管理", "统一登录"), feature(50, "孤儿", "不存在的功能")], scenarios: [scenario(60, 30, "HP-1"), scenario(61, 30, "HP-2"), scenario(62, 40, "EC-1"), scenario(63, 999, "HP-9")], changes: [change(70, "统一登录", "HP-1"), change(71, "没见过的功能")] },
      { features: [feature(80, "统一登录"), feature(90, "支付")], scenarios: [scenario(100, 80, "HP-1")], changes: [] },
    ],
  };

  it("rehearses without writing anything and reports what it would assign", async () => {
    const { source, reads } = memorySource({ 8: chain });

    const report = await backfillRepository({ repository: { repositoryId: 8, productId: 4 }, source });

    expect(reads).toEqual([8000, 8001, 8002]);
    expect(report).toEqual({
      repositoryId: 8,
      productId: 4,
      versions: 3,
      featureRows: 7,
      scenarioRows: 6,
      changeRows: 4,
      assignedChanges: 3,
      mintedFeatures: 4,
      mintedScenarios: 3,
      restoredFeatures: 1,
      restoredScenarios: 0,
      retiredFeatures: 3,
      retiredScenarios: 2,
      unresolvedParents: 1,
      orphanScenarios: 1,
      conflict: null,
    });
  });

  it("hands each version to the write function in order, with the previous version's identities and the registry so far", async () => {
    const { source } = memorySource({ 8: chain });
    const write = vi.fn(async (_specVersionId: number, rows: IdentityRows, previous: VersionIdentities, registry: IdentityRegistry) =>
      planVersionIdentities({ features: rows.features.map((entry) => ({ name: entry.name, parentKey: entry.parentKey, references: rows.scenarios.filter((item) => item.featureId === entry.id).map((item) => item.reference) })), previous, registry }),
    );

    await backfillRepository({ repository: { repositoryId: 8, productId: 4 }, source, write });

    expect(write.mock.calls.map(([specVersionId]) => specVersionId)).toEqual([8000, 8001, 8002]);
    // 第二版拿到的是第一版算出来的身份；第三版拿到的登记表已经知道“支付”，所以它是恢复。
    expect([...write.mock.calls[1][2].features.keys()]).toEqual(["统一登录", "支付"]);
    expect(write.mock.calls[2][3].features.has("支付")).toBe(true);
    expect(write.mock.calls[2][3].scenarios.get("统一登录")?.has("HP-2")).toBe(true);
  });

  it("stops at the first version it cannot assign and says which one and why", async () => {
    const { source, reads } = memorySource({
      8: {
        productId: 4,
        versions: [
          { features: [feature(1, "统一登录")], scenarios: [], changes: [] },
          // 同一个版本里两个功能的名称键相同：数据不该长这样，遇到了不猜。
          { features: [feature(2, "支付"), feature(3, " 支付 ")], scenarios: [], changes: [] },
          { features: [feature(4, "再往后")], scenarios: [], changes: [] },
        ],
      },
    });
    // 真实的写入路径，配一个只记录语句的假库：能看清冲突的那一版有没有发出过语句。
    const statements: string[] = [];
    const write: BackfillWrite = (specVersionId, rows, previous, registry) =>
      assignVersionIdentities(4, specVersionId, rows, previous, async (sql) => {
        statements.push(`${specVersionId} ${sql.split(" ")[0]}`);
        return [{}];
      }, registry);

    const report = await backfillRepository({ repository: { repositoryId: 8, productId: 4 }, source, write });

    expect(report.conflict).toBe("版本 8001：identity_input_invalid 一个版本里有两个功能的名称键相同：支付");
    // 身份是先算后写的：算不出来的那一版一条语句都不发，前面的版本照常写完了。
    expect(statements.filter((entry) => entry.startsWith("8000")).every((entry) => /^(8000) (UPDATE|INSERT)$/.test(entry))).toBe(true);
    expect(statements.filter((entry) => entry.startsWith("8001"))).toEqual([]);
    expect(reads).toEqual([8000, 8001]);
    expect(report.versions).toBe(1);
  });

  it("passes on a failure that has nothing to do with identities", async () => {
    const source: BackfillSource = { repositories: async () => [], versions: async () => [100], rows: async () => { throw new Error("connection lost"); } };
    await expect(backfillRepository({ repository: { repositoryId: 8, productId: 4 }, source })).rejects.toThrow("connection lost");
  });
});

describe("整个回填", () => {
  const chains = {
    8: { productId: 4, versions: [{ features: [feature(1, "统一登录")], scenarios: [], changes: [] }] },
    11: {
      productId: 9,
      versions: [
        { features: [feature(1, "a")], scenarios: [], changes: [] },
        { features: [feature(2, "b"), feature(3, "B")], scenarios: [], changes: [] },
      ],
    },
  };

  /** 记录事务决定的替身：不连数据库，只记开始、提交、回滚。 */
  function fakeTransaction() {
    const log: string[] = [];
    const execute = vi.fn(async () => [{}]) as unknown as Execute;
    const inTransaction = async (repository: BackfillRepository, work: (execute: Execute) => Promise<RepositoryBackfillReport>) => {
      log.push(`begin ${repository.repositoryId}`);
      let report: RepositoryBackfillReport;
      try {
        report = await work(execute);
      } catch (error) {
        log.push(`rollback ${repository.repositoryId}`);
        throw error;
      }
      log.push(`${report.conflict ? "rollback" : "commit"} ${repository.repositoryId}`);
      return report;
    };
    return { log, inTransaction, execute };
  }

  it("rehearses the selected repositories only", async () => {
    const { source } = memorySource(chains);
    const report = await backfill({ source, repositoryIds: [8], apply: false });
    expect(report.apply).toBe(false);
    expect(report.repositories.map((entry) => entry.repositoryId)).toEqual([8]);
  });

  it("writes each repository in its own transaction through the execute it was given", async () => {
    const { source } = memorySource(chains);
    const transaction = fakeTransaction();

    const report = await backfill({ source, repositoryIds: [8], apply: true, inTransaction: transaction.inTransaction });

    expect(transaction.log).toEqual(["begin 8", "commit 8"]);
    expect(report.repositories[0]?.conflict).toBeNull();
    // 三张表的行加登记表，都走同一个事务连接。
    expect(transaction.execute).toHaveBeenCalled();
  });

  it("rolls back a repository that hits a conflict and still goes on with the others", async () => {
    const { source } = memorySource(chains);
    const transaction = fakeTransaction();

    const report = await backfill({ source, apply: true, inTransaction: transaction.inTransaction });

    expect(transaction.log).toEqual(["begin 8", "commit 8", "begin 11", "rollback 11"]);
    expect(report.repositories.map((entry) => entry.conflict === null)).toEqual([true, false]);
  });

  it("refuses to apply without a transaction to apply it in", async () => {
    const { source } = memorySource(chains);
    await expect(backfill({ source, apply: true })).rejects.toThrow(/事务/);
  });

  it("lets a database failure roll back and surface instead of being reported as a conflict", async () => {
    const source: BackfillSource = { ...memorySource(chains).source, rows: async () => { throw new Error("connection lost"); } };
    const transaction = fakeTransaction();
    await expect(backfill({ source, repositoryIds: [8], apply: true, inTransaction: transaction.inTransaction })).rejects.toThrow("connection lost");
    expect(transaction.log).toEqual(["begin 8", "rollback 8"]);
  });
});

describe("数据库数据源", () => {
  it("reads repositories, versions and rows with one statement each", async () => {
    const calls: Array<[string, Array<string | number | null>]> = [];
    const execute = vi.fn(async (sql: string, parameters: Array<string | number | null> = []) => {
      calls.push([sql, parameters]);
      if (sql.includes("FROM repositories r")) return [[{ repositoryId: 8, productId: 4 }]];
      if (sql.includes("FROM spec_versions WHERE repository_id")) return [[{ versionId: 100 }, { versionId: 101 }]];
      return [{}];
    });

    const source = dbBackfillSource(execute as unknown as Execute);

    expect(await source.repositories([8, 11])).toEqual([{ repositoryId: 8, productId: 4 }]);
    expect(calls[0]?.[1]).toEqual([8, 11]);
    expect(await source.versions(8)).toEqual([100, 101]);
    expect(await source.rows(100)).toEqual({ features: [], scenarios: [], changes: [] });
    // 读行只读、不写。
    expect(calls.every(([sql]) => /^SELECT/.test(sql))).toBe(true);
  });

  it("selects every repository that has versions when no filter is given", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: unknown[]) => [[]]);
    await dbBackfillSource(execute as unknown as Execute).repositories([]);
    expect(execute.mock.calls[0]?.[0]).not.toContain("IN (");
  });

  it("turns database rows into plain rows: numbers are numbers, a missing parent or reference is null or empty", async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("FROM spec_features")) return [[{ id: "10", name: "统一登录", parentKey: null }, { id: "11", name: "会话管理", parentKey: "统一登录" }]];
      if (sql.includes("FROM spec_scenarios")) return [[{ id: "500", featureId: "10", reference: "HP-1" }]];
      return [[{ id: "900", featureKey: "统一登录", scenarioReference: null }]];
    });

    expect(await loadIdentityRows(execute as unknown as Execute, 100)).toEqual({
      features: [{ id: 10, name: "统一登录", parentKey: null }, { id: 11, name: "会话管理", parentKey: "统一登录" }],
      scenarios: [{ id: 500, featureId: 10, reference: "HP-1" }],
      changes: [{ id: 900, featureKey: "统一登录", scenarioReference: "" }],
    });
  });
});

describe("事务", () => {
  /** 只记事的不真连接：开始、提交、回滚、归还各记一笔。 */
  function fakePool() {
    const log: string[] = [];
    const connection = {
      beginTransaction: async () => void log.push("begin"),
      commit: async () => void log.push("commit"),
      rollback: async () => void log.push("rollback"),
      release: () => void log.push("release"),
      execute: vi.fn(async () => [{}]),
    };
    return { log, pool: { getConnection: async () => connection }, connection };
  }
  const repository = { repositoryId: 8, productId: 4 };
  const clean: RepositoryBackfillReport = {
    repositoryId: 8, productId: 4, versions: 0, featureRows: 0, scenarioRows: 0, changeRows: 0, assignedChanges: 0,
    mintedFeatures: 0, mintedScenarios: 0, retiredFeatures: 0, retiredScenarios: 0, restoredFeatures: 0, restoredScenarios: 0,
    unresolvedParents: 0, orphanScenarios: 0, conflict: null,
  };

  it("commits when the repository backfilled cleanly, hands the work the transaction's own execute, and always gives the connection back", async () => {
    const { log, pool, connection } = fakePool();
    const report = await poolTransaction(pool as never)(repository, async (execute) => {
      await execute("UPDATE x SET a = ?", [1]);
      return clean;
    });

    expect(report).toBe(clean);
    expect(log).toEqual(["begin", "commit", "release"]);
    expect(connection.execute).toHaveBeenCalledWith("UPDATE x SET a = ?", [1]);
  });

  it("rolls back when the report carries a conflict", async () => {
    const { log, pool } = fakePool();
    const conflicted: RepositoryBackfillReport = { ...clean, conflict: "版本 101：identity_conflict x" };
    expect(await poolTransaction(pool as never)(repository, async () => conflicted)).toBe(conflicted);
    expect(log).toEqual(["begin", "rollback", "release"]);
  });

  it("rolls back, gives the connection back and rethrows when the work itself fails", async () => {
    const { log, pool } = fakePool();
    await expect(poolTransaction(pool as never)(repository, async () => { throw new Error("connection lost"); })).rejects.toThrow("connection lost");
    expect(log).toEqual(["begin", "rollback", "release"]);
  });
});

describe("报告", () => {
  const clean: RepositoryBackfillReport = {
    repositoryId: 8, productId: 4, versions: 3, featureRows: 8, scenarioRows: 6, changeRows: 4, assignedChanges: 3,
    mintedFeatures: 3, mintedScenarios: 3, restoredFeatures: 1, restoredScenarios: 1, retiredFeatures: 2, retiredScenarios: 2,
    unresolvedParents: 1, orphanScenarios: 1, conflict: null,
  };

  it("says plainly that a rehearsal wrote nothing", () => {
    const text = renderReport({ apply: false, repositories: [clean] });
    expect(text).toContain("演练，没有写入任何数据");
    expect(text).toContain("--apply");
    expect(text).toContain("| 8 | 3 | 8 | 6 | 4 | 3 | 3 | 3 | 2 | 2 | 1 | 1 | 1 | 1 | 无 |");
  });

  it("names the repository and reason for every conflict, and counts committed and rolled-back repositories apart", () => {
    // 两个干净、一个冲突：2 和 1 不对称，提交数与回滚数写反了会被看出来。
    const conflict: RepositoryBackfillReport = { ...clean, conflict: "版本 101：identity_conflict x" };
    const text = renderReport({ apply: true, repositories: [clean, { ...clean, repositoryId: 12 }, { ...conflict, repositoryId: 11 }] });
    expect(text).toContain("身份回填：写入模式。已写入 2 个仓库，1 个仓库因冲突回滚，没有改动。");
    expect(text).toContain("- 仓库 11：版本 101：identity_conflict x");
    expect(text).toContain("| 11 | 3 | 8 | 6 | 4 | 3 | 3 | 3 | 2 | 2 | 1 | 1 | 1 | 1 | 有 |");
  });

  it("does not bring up rollbacks or conflicts when everything went cleanly", () => {
    const applied = renderReport({ apply: true, repositories: [clean] });
    expect(applied).toContain("身份回填：写入模式。已写入 1 个仓库。");
    expect(applied).not.toContain("回滚");
    expect(renderReport({ apply: false, repositories: [clean] })).not.toContain("冲突（");
  });

  it("has nothing to say when the ledger has no repositories to backfill", () => {
    expect(renderReport({ apply: false, repositories: [] })).toContain("没有需要回填的仓库");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";

// 合并入口本身在 tests/save-result-transaction.test.ts 和真实 MySQL 演练里验证；这里只看回填给它送了什么。
const saveMock = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../lib/analysis", () => ({ saveResultInTransaction: saveMock.save }));

import { parseArgs, renderBlockages, renderReceipt, usageProblems } from "../scripts/backfill-import-draft";
import {
  backfillDraftInTransaction,
  backfillImportDraft,
  backfillProvenance,
  blockagesOf,
  ImportBackfillRefused,
  loadBackfillCandidate,
  type DraftBackfillCandidate,
  type DraftRows,
  releaseUrlOf,
  resultOf,
} from "../lib/import-draft-backfill";

const SHA = "a".repeat(40);
const IMPORTED_AT = new Date("2026-11-19T14:19:00.000Z");

interface World {
  product: Record<string, unknown> | null;
  repositories: Array<Record<string, unknown>>;
  versionCount: number;
  featureTallies: Array<{ source: string; active: number; count: number }>;
  scenarioTallies: Array<{ source: string; active: number; count: number }>;
  draftFeatures: Array<{ id: number; name: string; summary: string }>;
  draftScenarios: Array<{ id: number; featureId: number; reference: string; context: string; action: string; outcome: string; category: string; stepOrder: number | null; evidence: unknown }>;
  /** 改来源那两条语句实际改到的行数。不给就和计数一致。 */
  converted?: { features?: number; scenarios?: number };
  /** 合并入口（替身）写出来的版本里有什么。 */
  versionFeatures: Array<{ source: string; count: number }>;
  versionScenarios: Array<{ name: string; reference: string; source: string }>;
}

function world(overrides: Partial<World> = {}): World {
  const draftScenarios: World["draftScenarios"] = [
    { id: 500, featureId: 100, reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", stepOrder: 1, evidence: JSON.stringify([{ path: "lib/login.ts", startLine: 10, endLine: null }]) },
    { id: 501, featureId: 100, reference: "EC-1", context: "密码错误", action: "登录", outcome: "提示错误", category: "error", stepOrder: null, evidence: [{ path: "lib/login.ts", startLine: 20, endLine: 24 }] },
    { id: 502, featureId: 101, reference: "HP-1", context: "已登录", action: "导出", outcome: "拿到文件", category: "happy", stepOrder: 1, evidence: [] },
  ];
  const draftFeatures: World["draftFeatures"] = [
    { id: 100, name: "登录", summary: "登录功能" },
    { id: 101, name: "导出", summary: "" },
  ];
  return {
    product: {
      id: 12, slug: "airecord", name: "AIRecord", organizationId: 3, outputLanguage: "zh-CN", analysisExecutor: "server",
      seededSnapshotSha: SHA, seededTreeSha: "b".repeat(40), seededDirty: 0, seededContractVersion: "1.0.0", seededAt: IMPORTED_AT,
    },
    repositories: [{ id: 7, provider: "github", host: null, owner: "acme", name: "airecord" }],
    versionCount: 0,
    featureTallies: [{ source: "ai_snapshot_import", active: 1, count: 2 }],
    scenarioTallies: [{ source: "ai_snapshot_import", active: 1, count: 3 }],
    draftFeatures,
    draftScenarios,
    versionFeatures: [{ source: "generated", count: 2 }],
    versionScenarios: draftScenarios.map((scenario) => ({ name: draftFeatures.find((feature) => feature.id === scenario.featureId)!.name, reference: scenario.reference, source: "generated" })),
    ...overrides,
  };
}

/** 按语句片段回答的连接替身。它记录每条语句，好断言先后顺序和「拒绝时什么都没写」。 */
function connectionOf(state: World) {
  const statements: Array<[string, unknown[]]> = [];
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    statements.push([sql, params]);
    if (sql.includes("FROM products WHERE organization_id = ? AND slug = ? LIMIT 1")) return [state.product ? [state.product] : []];
    if (sql.includes("FROM products WHERE organization_id = ? AND slug = ? FOR UPDATE")) return [state.product ? [{ id: state.product.id }] : []];
    if (sql.includes("SELECT id FROM repositories WHERE product_id = ? FOR UPDATE")) return [state.repositories.map((repository) => ({ id: repository.id }))];
    if (sql.includes("FROM repositories WHERE product_id = ? ORDER BY id")) return [state.repositories];
    if (sql.includes("SELECT COUNT(*) AS count FROM spec_versions")) return [[{ count: state.versionCount }]];
    if (sql.includes("SELECT source, active, COUNT(*) AS count FROM features")) return [state.featureTallies];
    if (sql.includes("SELECT s.source, s.active, COUNT(*) AS count FROM scenarios s JOIN features f")) return [state.scenarioTallies];
    if (sql.includes("SELECT id, name, summary FROM features WHERE product_id = ? AND active = 1")) return [state.draftFeatures];
    if (sql.includes("SELECT s.id, s.feature_id AS featureId")) return [state.draftScenarios];
    if (sql.includes("UPDATE features SET source = 'generated'")) return [{ affectedRows: state.converted?.features ?? state.featureTallies.filter((row) => row.source === "ai_snapshot_import" && row.active === 1).reduce((sum, row) => sum + row.count, 0) }];
    if (sql.includes("UPDATE scenarios s JOIN features f ON f.id = s.feature_id SET s.source = 'generated'")) return [{ affectedRows: state.converted?.scenarios ?? state.scenarioTallies.filter((row) => row.source === "ai_snapshot_import" && row.active === 1).reduce((sum, row) => sum + row.count, 0) }];
    if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 900 }];
    if (sql.includes("UPDATE spec_versions SET provenance_json")) return [{ affectedRows: 1 }];
    if (sql.includes("SELECT f.name, s.reference, s.source FROM spec_scenarios s JOIN spec_features f")) return [state.versionScenarios];
    if (sql.includes("SELECT source, COUNT(*) AS count FROM spec_features WHERE spec_version_id")) return [state.versionFeatures];
    throw new Error(`没有料到这条语句：${sql}`);
  });
  const connection = {
    execute,
    query: vi.fn(async () => undefined),
    beginTransaction: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  return { connection: connection as unknown as PoolConnection, statements, commit: connection.commit, rollback: connection.rollback, release: connection.release };
}

const options = { committedAt: "2026-11-18T09:30:00.000Z", currentContractVersion: "1.0.0", now: () => new Date("2026-11-27T01:00:00.000Z") };
const target = { slug: "airecord", organizationId: 3 };

async function candidateOf(state: World): Promise<DraftBackfillCandidate | null> {
  const { connection } = connectionOf(state);
  return loadBackfillCandidate((statement, parameters) => connection.execute(statement, parameters) as Promise<unknown>, target);
}

describe("what a backfill looks at", () => {
  it("reads the product, its repositories, its versions and the workbench tallies", async () => {
    expect(await candidateOf(world())).toEqual({
      productId: 12, organizationId: 3, slug: "airecord", productName: "AIRecord", outputLanguage: "zh-CN", analysisExecutor: "server",
      seeded: { snapshotSha: SHA, treeSha: "b".repeat(40), dirty: false, contractVersion: "1.0.0", importedAt: IMPORTED_AT },
      repository: { id: 7, provider: "github", host: null, owner: "acme", name: "airecord" },
      repositoryCount: 1, versionCount: 0,
      workbench: { features: { "ai_snapshot_import:active": 2 }, scenarios: { "ai_snapshot_import:active": 3 } },
    });
    expect(await candidateOf(world({ product: null }))).toBeNull();
    expect((await candidateOf(world({ product: { ...world().product!, outputLanguage: "en", seededDirty: 1, seededSnapshotSha: null } })))!).toMatchObject({ outputLanguage: "en", seeded: { dirty: true, snapshotSha: null } });
  });

  it("finds nothing wrong with an untouched draft", async () => {
    expect(blockagesOf((await candidateOf(world()))!, options)).toEqual([]);
    // 人工改过、人工加过、人工下线过：都不妨碍回填，这些行由合并入口按「人工优先」并入版本。
    const edited = world({ featureTallies: [{ source: "ai_snapshot_import", active: 1, count: 2 }, { source: "manual", active: 1, count: 1 }, { source: "manual", active: 0, count: 1 }] });
    expect(blockagesOf((await candidateOf(edited))!, options)).toEqual([]);
  });

  it("refuses, with every reason at once, when a condition is not met", async () => {
    const cases: Array<[Partial<World>, string]> = [
      [{ repositories: [] }, "repository_missing"],
      [{ repositories: [{ id: 7, provider: "github" }, { id: 8, provider: "github" }] }, "repository_ambiguous"],
      [{ repositories: [{ id: 7, provider: "gitlab", owner: "acme", name: "airecord" }] }, "repository_unsupported"],
      [{ product: { ...world().product!, seededSnapshotSha: null } }, "not_imported"],
      [{ product: { ...world().product!, seededTreeSha: null } }, "seeded_incomplete"],
      [{ product: { ...world().product!, seededDirty: 1 } }, "dirty_snapshot"],
      [{ product: { ...world().product!, seededContractVersion: "0.9.0" } }, "contract_version_drift"],
      [{ versionCount: 2 }, "already_has_versions"],
      [{ featureTallies: [{ source: "ai_snapshot_import", active: 1, count: 2 }, { source: "generated", active: 1, count: 5 }] }, "generated_rows_present"],
      [{ scenarioTallies: [{ source: "ai_snapshot_import", active: 1, count: 3 }, { source: "generated", active: 0, count: 1 }] }, "generated_rows_present"],
      [{ scenarioTallies: [{ source: "ai_snapshot_import", active: 1, count: 3 }, { source: "ai_snapshot_import", active: 0, count: 1 }] }, "draft_modified"],
      [{ featureTallies: [{ source: "ai_snapshot_import", active: 0, count: 2 }, { source: "manual", active: 1, count: 2 }] }, "draft_empty"],
    ];
    for (const [overrides, code] of cases) {
      const codes = blockagesOf((await candidateOf(world(overrides)))!, options).map((blockage) => blockage.code);
      expect(codes, JSON.stringify(overrides)).toContain(code);
    }
    // 几个条件同时不满足时一次说全。
    const codes = blockagesOf((await candidateOf(world({ versionCount: 1, product: { ...world().product!, seededDirty: 1 } })))!, options).map((blockage) => blockage.code);
    expect(codes).toEqual(["dirty_snapshot", "already_has_versions"]);
  });

  it("lets the operator accept a contract that moved on since the import, and nothing else", async () => {
    const drifted = (await candidateOf(world({ product: { ...world().product!, seededContractVersion: "0.9.0", seededDirty: 1 } })))!;
    expect(blockagesOf(drifted, { ...options, acceptContractDrift: true }).map((blockage) => blockage.code)).toEqual(["dirty_snapshot"]);
    expect(blockagesOf({ ...drifted, seeded: { ...drifted.seeded, dirty: false } }, { ...options, acceptContractDrift: true })).toEqual([]);
  });
});

describe("what a backfill writes", () => {
  const rowsOfWorld = (state: World): DraftRows => ({
    features: state.draftFeatures,
    scenarios: state.draftScenarios.map((scenario) => ({ ...scenario, category: scenario.category as "happy" | "edge" | "error" })),
  });

  it("turns the draft rows into the result the merge entry expects, in the order they were imported", () => {
    const result = resultOf(rowsOfWorld(world()), "zh-CN");
    expect(result.product).toEqual({ description: "", evidence: [] });
    expect(result.changes).toEqual([]);
    expect(result.release).toMatchObject({ title: "首个账本版本（由导入的雷达快照回填）" });
    expect(result.release.summary).toContain("没有为它读过源码");
    expect(result.features).toEqual([
      { name: "登录", summary: "登录功能", scenarios: [
        { reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", step: 1, evidence: [{ path: "lib/login.ts", startLine: 10 }] },
        { reference: "EC-1", context: "密码错误", action: "登录", outcome: "提示错误", category: "error", evidence: [{ path: "lib/login.ts", startLine: 20, endLine: 24 }] },
      ] },
      // 没有证据的场景原样带着：它已经在工作台里了，回填不替租户做删减。
      { name: "导出", summary: "", scenarios: [{ reference: "HP-1", context: "已登录", action: "导出", outcome: "拿到文件", category: "happy", step: 1, evidence: [] }] },
    ]);
    expect(resultOf(rowsOfWorld(world()), "en").release).toMatchObject({ title: "First ledger version (backfilled from an imported radar snapshot)" });
  });

  it("keeps only well-formed anchors and refuses evidence it cannot read", () => {
    const withEvidence = (evidence: unknown) => resultOf(rowsOfWorld(world({ draftScenarios: [{ ...world().draftScenarios[0], evidence }] })), "zh-CN").features[0].scenarios[0].evidence;
    // 第 1 行是合法的行号。
    expect(withEvidence([{ path: "a.ts" }, { path: "b.ts", startLine: 0, endLine: 3.5 }, { path: "c.ts", startLine: "12" }, { path: "d.ts", startLine: 1, endLine: 1 }])).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts", startLine: 1, endLine: 1 }]);
    expect(withEvidence("[]")).toEqual([]);
    for (const bad of ["{not json", { path: "a.ts" }, [{ line: 3 }], [{ path: "" }], null, [null], ["a.ts"], [42]]) {
      expect(() => withEvidence(bad), JSON.stringify(bad)).toThrow(/import draft scenario 500/);
    }
    const miscategorised = world({ draftScenarios: [{ ...world().draftScenarios[0], category: "weird" }] });
    expect(() => resultOf(rowsOfWorld(miscategorised), "zh-CN")).toThrow(/category weird/);
  });

  it("links the release to the commit only where the address is known", () => {
    expect(releaseUrlOf({ provider: "github", host: null, owner: "acme", name: "airecord" }, SHA)).toBe(`https://github.com/acme/airecord/commit/${SHA}`);
    expect(releaseUrlOf({ provider: "github", host: "github.example.com", owner: "acme", name: "airecord" }, SHA)).toBe(`https://github.example.com/acme/airecord/commit/${SHA}`);
    expect(releaseUrlOf({ provider: "gitee", host: null, owner: "acme", name: "airecord" }, SHA)).toBe("");
  });

  it("records that the server verified nothing and the client declared nothing", async () => {
    const provenance = backfillProvenance((await candidateOf(world()))!, { specVersionId: 77, backfilledAt: "2026-11-27T01:00:00.000Z" });
    expect(provenance).toEqual({
      server: {
        executor: "client", entry: "import_backfill", backfilledAt: "2026-11-27T01:00:00.000Z", importedAt: "2026-11-19T14:19:00.000Z",
        specVersionId: 77, revisionSha: SHA, contractVersion: "1.0.0",
        verification: { scope: "none", reanalyzed: 0, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 },
      },
      client: null,
    });
  });
});

type SavedInput = { features: Array<{ name: string }> };

function savedLike(run: { id: number }, result: SavedInput, activate = true) {
  return {
    specVersionId: 77, releaseId: 88, releaseChangeProjections: result.features.map((feature: { name: string }) => ({ featureName: feature.name, kind: "added" })), features: [],
    collapse: null, featureCollapses: [], misplacedScenarios: [], identityHijacksDropped: 0, featureFolds: [], activate, supersededBy: run.id,
  };
}

describe("the transaction body", () => {
  it("locks first, converts the draft, writes a receipt run and hands the merge entry the draft as a full analysis", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const state = world();
    const { connection, statements } = connectionOf(state);
    const outcome = await backfillDraftInTransaction(connection, target, options);

    expect(outcome).toEqual({
      productId: 12, repositoryId: 7, runId: 900, specVersionId: 77, releaseId: 88, revisionSha: SHA, committedAt: "2026-11-18T09:30:00.000Z",
      draft: { features: 2, scenarios: 3, withoutEvidence: 1 }, version: { features: 2, scenarios: 3, manualFeatures: 0, manualScenarios: 0 },
      releaseChanges: 2, droppedDraft: []
    });
    const sql = statements.map(([statement]) => statement);
    expect(sql[0]).toContain("FROM products WHERE organization_id = ? AND slug = ? FOR UPDATE");
    expect(sql[0]).toContain("FOR UPDATE");
    expect(sql[1]).toMatch(/^SELECT id FROM repositories WHERE product_id = \? FOR UPDATE$/);
    const convertedAt = sql.findIndex((statement) => statement.includes("UPDATE features SET source = 'generated'"));
    const runAt = sql.findIndex((statement) => statement.includes("INSERT INTO analysis_runs"));
    expect(convertedAt).toBeGreaterThan(1);
    expect(sql[convertedAt + 1]).toContain("UPDATE scenarios s JOIN features f ON f.id = s.feature_id SET s.source = 'generated'");
    expect(statements[runAt][1]).toEqual([7, "import_backfill", SHA, 3]);
    expect(sql[runAt]).toContain("before_sha");

    expect(saveMock.save).toHaveBeenCalledTimes(1);
    const [saveConnection, run, result, change, affectedKeys, coverage] = saveMock.save.mock.calls[0];
    expect(saveConnection).toBe(connection);
    expect(run).toMatchObject({
      id: 900, repositoryId: 7, productId: 12, organizationId: 3, productSlug: "airecord", productName: "AIRecord", owner: "acme", name: "airecord", provider: "github",
      connectionId: null, accountId: 3, analyzeMode: "full", outputLanguage: "zh-CN", beforeSha: null, afterSha: SHA,
      baseSpecVersionId: null, baseCapturedAt: null, triggerType: "import_backfill", analysisExecutor: "client",
    });
    expect(result.features.map((feature: { name: string }) => feature.name)).toEqual(["登录", "导出"]);
    // 步骤号来自导入时写的 step_order；没有的就是没有，不编一个 0。
    expect(result.features[0].scenarios.map((scenario: { step?: number | null }) => scenario.step)).toEqual([1, undefined]);
    expect(result.features[0].scenarios[1].evidence).toEqual([{ path: "lib/login.ts", startLine: 20, endLine: 24 }]);
    // 这一条导入时就没有证据：原样带着，不编。
    expect(result.features[1].scenarios[0].evidence).toEqual([]);
    expect(result.product).toEqual({ description: "", evidence: [] });
    // 服务端不知道那次快照看过哪些文件：窗口是空的，不是编出来的。
    expect(change).toEqual({ message: "首个账本版本（由导入的雷达快照回填）", committedAt: "2026-11-18T09:30:00.000Z", url: `https://github.com/acme/airecord/commit/${SHA}`, files: [] });
    expect(affectedKeys).toBeNull();
    expect(coverage).toBeUndefined();

    const provenanceAt = sql.findIndex((statement) => statement.includes("UPDATE spec_versions SET provenance_json"));
    expect(statements[provenanceAt][1]).toEqual([JSON.stringify(backfillProvenance((await candidateOf(state))!, { specVersionId: 77, backfilledAt: "2026-11-27T01:00:00.000Z" })), 77]);
  });

  it("writes nothing when a condition is not met: it locks, reads and stops", async () => {
    saveMock.save.mockReset();
    const { connection, statements } = connectionOf(world({ versionCount: 1, product: { ...world().product!, seededDirty: 1 } }));
    await expect(backfillDraftInTransaction(connection, target, options)).rejects.toMatchObject({ blockages: [{ code: "dirty_snapshot", detail: expect.any(String) }, { code: "already_has_versions", detail: expect.any(String) }] });
    await expect(backfillDraftInTransaction(connectionOf(world({ product: null })).connection, target, options)).rejects.toBeInstanceOf(ImportBackfillRefused);
    await expect(backfillDraftInTransaction(connectionOf(world({ product: null })).connection, target, options)).rejects.toMatchObject({ blockages: [{ code: "product_not_found" }] });
    expect(saveMock.save).not.toHaveBeenCalled();
    expect(statements.map(([statement]) => statement).filter((statement) => /^(UPDATE|INSERT|DELETE)/.test(statement))).toEqual([]);
  });

  it("refuses a commit time it cannot read before touching anything", async () => {
    const { connection, statements } = connectionOf(world());
    await expect(backfillDraftInTransaction(connection, target, { ...options, committedAt: "last tuesday" })).rejects.toThrow(/--committed-at is not a date/);
    expect(statements).toEqual([]);
  });

  it("carries the operator's acceptance of a drifted contract into the conditions it checks under the lock", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const drifted = world({ product: { ...world().product!, seededContractVersion: "0.9.0" } });
    await expect(backfillDraftInTransaction(connectionOf(drifted).connection, target, options)).rejects.toMatchObject({ blockages: [{ code: "contract_version_drift" }] });
    expect(saveMock.save).not.toHaveBeenCalled();
    expect((await backfillDraftInTransaction(connectionOf(drifted).connection, target, { ...options, acceptContractDrift: true })).specVersionId).toBe(77);
    expect(saveMock.save).toHaveBeenCalledTimes(1);
  });

  it("lets a draft feature whose scenarios were all deleted by a human go in without scenarios", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    // 功能还是导入原样，它名下的场景被人工删光了（来源都成了 manual）。
    const state = world({ draftScenarios: world().draftScenarios.slice(0, 2), scenarioTallies: [{ source: "manual", active: 0, count: 1 }] });
    const outcome = await backfillDraftInTransaction(connectionOf(state).connection, target, options);
    expect(outcome.draft).toEqual({ features: 2, scenarios: 2, withoutEvidence: 0 });
    expect(saveMock.save.mock.calls[0][2].features[1]).toEqual({ name: "导出", summary: "", scenarios: [] });
  });

  it("stops when the draft moved between reading the conditions and converting the rows", async () => {
    saveMock.save.mockReset();
    const { connection } = connectionOf(world({ converted: { scenarios: 2 } }));
    await expect(backfillDraftInTransaction(connection, target, options)).rejects.toThrow(/the draft changed while it was being read: expected 2 features and 3 scenarios, converted 2 and 2/);
    expect(saveMock.save).not.toHaveBeenCalled();
  });

  it("reports draft scenarios the merge entry left out, and counts what is manual in the version", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const state = world({
      versionFeatures: [{ source: "generated", count: 2 }, { source: "manual", count: 1 }],
      versionScenarios: [{ name: "登录", reference: "HP-1", source: "manual" }, { name: "导出", reference: "HP-1", source: "generated" }],
    });
    const outcome = await backfillDraftInTransaction(connectionOf(state).connection, target, options);
    expect(outcome.droppedDraft).toEqual([{ feature: "登录", reference: "EC-1" }]);
    expect(outcome.version).toEqual({ features: 3, scenarios: 2, manualFeatures: 1, manualScenarios: 1 });
  });

  it("leaves the rollback to the caller when the run is not the latest or the merge fails", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result, false));
    const { connection, rollback } = connectionOf(world());
    await expect(backfillDraftInTransaction(connection, target, options)).rejects.toThrow(/must be the latest run/);
    expect(rollback).not.toHaveBeenCalled();
    saveMock.save.mockRejectedValue(new Error("spec_conflict_rejected"));
    await expect(backfillDraftInTransaction(connection, target, options)).rejects.toThrow("spec_conflict_rejected");
  });
});

describe("rehearse, then write", () => {
  const poolOf = (state: World) => {
    const fake = connectionOf(state);
    return { pool: { getConnection: async () => fake.connection }, ...fake };
  };

  it("does the whole thing and rolls back when rehearsing", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const { pool, commit, rollback, release } = poolOf(world());
    const receipt = await backfillImportDraft(pool, target, { ...options, apply: false });
    expect(receipt.dryRun).toBe(true);
    expect(receipt.specVersionId).toBe(77);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("commits when writing", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const { pool, commit, rollback } = poolOf(world());
    expect((await backfillImportDraft(pool, target, { ...options, apply: true })).dryRun).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back and refuses to write duplicates away unless that was accepted; a rehearsal still reports them", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const state = world({ versionScenarios: [{ name: "登录", reference: "HP-1", source: "generated" }] });
    const writing = poolOf(state);
    await expect(backfillImportDraft(writing.pool, target, { ...options, apply: true })).rejects.toMatchObject({ blockages: [{ code: "draft_duplicates", detail: expect.stringContaining("2 条草稿场景") }] });
    expect(writing.rollback).toHaveBeenCalledTimes(1);
    expect(writing.commit).not.toHaveBeenCalled();

    const rehearsing = poolOf(state);
    const receipt = await backfillImportDraft(rehearsing.pool, target, { ...options, apply: false });
    expect(receipt.droppedDraft.map((item) => item.reference)).toEqual(["EC-1", "HP-1"]);
    expect(rehearsing.rollback).toHaveBeenCalledTimes(1);

    const accepted = poolOf(state);
    expect((await backfillImportDraft(accepted.pool, target, { ...options, apply: true, acceptDedupe: true })).dryRun).toBe(false);
    expect(accepted.commit).toHaveBeenCalledTimes(1);
  });

  it("refuses to write even a single duplicate away", async () => {
    saveMock.save.mockReset().mockImplementation(async (_connection: unknown, run: { id: number }, result: SavedInput) => savedLike(run, result));
    const one = poolOf(world({ versionScenarios: world().versionScenarios.slice(0, 2) }));
    await expect(backfillImportDraft(one.pool, target, { ...options, apply: true })).rejects.toMatchObject({ blockages: [{ code: "draft_duplicates", detail: expect.stringContaining("1 条草稿场景") }] });
    expect(one.commit).not.toHaveBeenCalled();
    expect((await backfillImportDraft(one.pool, target, { ...options, apply: true, acceptDedupe: true })).droppedDraft).toEqual([{ feature: "导出", reference: "HP-1" }]);
  });

  it("rolls back and releases the connection when the body throws", async () => {
    saveMock.save.mockReset();
    const { pool, rollback, release } = poolOf(world({ versionCount: 1 }));
    await expect(backfillImportDraft(pool, target, { ...options, apply: true })).rejects.toBeInstanceOf(ImportBackfillRefused);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("the command", () => {
  it("reads its arguments and refuses a usage that would guess", () => {
    expect(parseArgs(["--slug", "airecord", "--org", "3"])).toEqual({ slug: "airecord", organizationId: 3, committedAt: null, apply: false, acceptContractDrift: false, acceptDedupe: false, json: false });
    expect(parseArgs(["--slug", "a", "--org", "3", "--apply", "--committed-at", "2026-11-18T09:30:00Z", "--accept-dedupe", "--json"])).toMatchObject({ apply: true, committedAt: "2026-11-18T09:30:00Z", acceptDedupe: true, json: true });
    expect(() => parseArgs(["--slug"])).toThrow(/--slug 后面要跟一个值/);
    expect(() => parseArgs(["--slug", "--apply"])).toThrow(/--slug 后面要跟一个值/);
    expect(parseArgs([])).toMatchObject({ organizationId: null });
    expect(Number.isNaN(parseArgs(["--org", "three"]).organizationId)).toBe(true);
  });

  it("says what is missing before anything touches the database", () => {
    expect(usageProblems(parseArgs([]))).toEqual(["要用 --slug 指定产品", "要用 --org 指定产品所在的组织号"]);
    expect(usageProblems(parseArgs(["--slug", "a", "--org", "0"]))).toEqual(["--org 要是一个正整数"]);
    // 演练可以不给提交时间；写入必须给。
    expect(usageProblems(parseArgs(["--slug", "a", "--org", "3"]))).toEqual([]);
    expect(usageProblems(parseArgs(["--slug", "a", "--org", "3", "--apply"]))).toEqual([expect.stringContaining("--apply 必须同时给 --committed-at")]);
    expect(usageProblems(parseArgs(["--slug", "a", "--org", "3", "--apply", "--committed-at", "2026-11-18T09:30:00Z"]))).toEqual([]);
  });

  it("tells a rehearsal apart from a write and names what a write would remove", () => {
    const base = { dryRun: true, productId: 12, repositoryId: 7, runId: 900, specVersionId: 77, releaseId: 88, revisionSha: SHA, committedAt: "2026-11-18T09:30:00.000Z", releaseChanges: 2 };
    const clean = renderReceipt({ ...base, draft: { features: 2, scenarios: 3, withoutEvidence: 1 }, version: { features: 2, scenarios: 3, manualFeatures: 0, manualScenarios: 0 }, droppedDraft: [] });
    expect(clean).toContain("已经回滚");
    expect(clean).not.toContain("--accept-dedupe");
    expect(clean).toContain("1 条场景没有证据");
    const written = renderReceipt({ ...base, dryRun: false, draft: { features: 2, scenarios: 3, withoutEvidence: 0 }, version: { features: 2, scenarios: 2, manualFeatures: 0, manualScenarios: 1 }, droppedDraft: [{ feature: "登录", reference: "EC-1" }] });
    expect(written).toContain("已写入");
    expect(written).toContain("登录#EC-1");
    expect(written).not.toContain("--accept-dedupe");
    expect(renderReceipt({ ...base, draft: { features: 2, scenarios: 3, withoutEvidence: 0 }, version: { features: 2, scenarios: 2, manualFeatures: 0, manualScenarios: 0 }, droppedDraft: [{ feature: "登录", reference: "EC-1" }] })).toContain("--accept-dedupe");
    expect(renderBlockages([{ code: "dirty_snapshot", detail: "工作区有未提交改动" }])).toBe("不能回填：\n  - dirty_snapshot：工作区有未提交改动\n");
  });
});

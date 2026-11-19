import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { AnchorScenarioLink } from "../lib/behavior-unit-state";
import type { Execute } from "../lib/db";
import { assertLatestRun, upsertGeneratedSpec, upsertRelease, type RunContext } from "../lib/analysis";
// saveResult 由 Task 12 导出；命名空间引用保证 RED 阶段既有用例仍能加载本文件。
import * as analysis from "../lib/analysis";
import type { MergeResult } from "../lib/extraction-merge";
import { loadPreviousSpecText } from "../lib/spec-versions";
import type { ReleaseChangeFact } from "../lib/release-change-projection";

// saveResult 经 getDb().getConnection() 自取事务连接：mock db 模块注入 stub 连接。
// 既有用例全走显式 connection，不经 getDb，不受影响。
const dbMock = vi.hoisted(() => ({ connection: undefined as unknown }));
vi.mock("../lib/db", () => ({
  getDb: () => ({ execute: vi.fn(), getConnection: async () => dbMock.connection }),
  defaultExecute: async () => [[]],
}));

const run: RunContext = { id: 2, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: null, afterSha: "sha-2", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const result: AnalysisResult = {
  product: { description: "Authentication and product knowledge.", evidence: [{ path: "lib/db.ts", startLine: 1 }] },
  release: { title: "Title", summary: "Summary" },
  changes: [{ featureName: "Auth", kind: "changed", description: "Changed", userImpact: "", evidence: [] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [] }],
};
const change = { message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha-2", files: [] };
const specChanges: ReleaseChangeFact[] = [
  { id: 101, kind: "changed", entityType: "scenario", featureName: "Auth", scenarioReference: "EC-1", summary: "统一数字守护", before: null, after: { reference: "EC-1", context: "c", action: "a", outcome: "o", category: "edge", evidence: [{ path: "lib/auth.ts", startLine: 8 }] } },
  { id: 102, kind: "changed", entityType: "scenario", featureName: "Auth", scenarioReference: "EC-2", summary: "保护短标题", before: null, after: { reference: "EC-2", context: "c", action: "a", outcome: "o", category: "edge", evidence: [{ path: "lib/auth.ts", startLine: 9 }] } },
  { id: 103, kind: "added", entityType: "feature", featureName: "Billing", scenarioReference: null, summary: "新增账单", before: null, after: { name: "Billing", summary: "Billing", scenarios: [] } },
];

function connectionWithCount(count: number) {
  return {
    execute: vi.fn(async (sql: string) => {
      // 既有发布归当前 run（webhook 重放幂等）：不触发重分析重建分支
      if (sql.includes("analysis_run_id AS analysisRunId")) return [[{ id: 10, analysisRunId: run.id }]];
      if (sql.includes("SELECT id FROM releases")) return [[{ id: 10 }]];
      if (sql.includes("SELECT COUNT(*)")) return [[{ count }]];
      // 自动发布稿草稿（ensureAutoReleaseNoteDraft）：无 Highlight 变化 → 无草稿，不追加调用
      if (sql.includes("FROM spec_changes c")) return [[]];
      if (sql.includes("FROM release_notes WHERE release_id")) return [[]];
      return [{}];
    }),
  } as unknown as PoolConnection;
}

describe("analysis persistence guards", () => {
  it("rejects an obsolete analysis run", async () => {
    const connection = { execute: vi.fn(async () => [[{ id: 3 }]]) } as unknown as PoolConnection;
    await expect(assertLatestRun(connection, run)).rejects.toThrow("Analysis superseded by run 3");
    const empty = { execute: vi.fn(async () => [[]]) } as unknown as PoolConnection;
    await expect(assertLatestRun(empty, run)).rejects.toThrow("Analysis superseded by run 0");
  });

  it("accepts the latest analysis run", async () => {
    const connection = { execute: vi.fn(async () => [[{ id: 2 }]]) } as unknown as PoolConnection;
    await expect(assertLatestRun(connection, run)).resolves.toBeUndefined();
  });

  it("does not duplicate changes for an existing release", async () => {
    const connection = connectionWithCount(1);
    const { projections } = await upsertRelease(connection, run, result, change, null, specChanges);
    expect(projections).toEqual([]);
    expect(connection.execute).toHaveBeenCalledTimes(7);
    expect(connection.execute).not.toHaveBeenCalledWith(expect.stringContaining("DELETE FROM changes WHERE release_id"), expect.anything());
    expect(connection.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), expect.anything());
  });

  it("rebuilds projections when a re-analysis re-points the release to a new run", async () => {
    // reanalyze-latest 对同一 sha 落新 run/spec 版本：release 行被重指向新版本，
    // 旧的 changes 投影若不重建，发布页继续呈现被用户点名要修掉的旧分析结果。
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("analysis_run_id AS analysisRunId")) return [[{ id: 10, analysisRunId: run.id - 1 }]];
        if (sql.includes("SELECT id FROM releases")) return [[{ id: 10 }]];
        if (sql.includes("SELECT COUNT(*)")) return [[{ count: 0 }]];
        if (sql.includes("FROM spec_changes c")) return [[]];
        if (sql.includes("FROM release_notes WHERE release_id")) return [[]];
        return [{}];
      }),
    } as unknown as PoolConnection;
    const { projections } = await upsertRelease(connection, run, result, change, null, specChanges);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM changes WHERE release_id = ?"), [10]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM release_reviewed_items WHERE release_id = ?"), [10]);
    expect(projections).toHaveLength(2);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), expect.anything());
  });

  it("persists one source-linked projection per canonical feature and keeps reviewed out of user changes", async () => {
    const connection = connectionWithCount(0);
    const input: AnalysisResult = {
      ...result,
      changes: [
        { featureName: "Auth", kind: "changed", description: "旧自由文案不得落库", userImpact: "旧影响", evidence: [] },
        { featureName: "Auth", kind: "reviewed", description: "内部实现已检查", userImpact: "", evidence: [{ path: "lib/auth.ts", startLine: 8 }] },
      ],
    };
    const { projections } = await upsertRelease(connection, run, input, change, null, specChanges);

    expect(projections).toHaveLength(2);
    const changeInserts = (connection.execute as ReturnType<typeof vi.fn>).mock.calls.filter((call) => String(call[0]).includes("INSERT INTO changes"));
    expect(changeInserts).toHaveLength(2);
    expect(changeInserts[0][1]).toEqual([10, "Auth", "changed", "统一数字守护；保护短标题", "", JSON.stringify([{ path: "lib/auth.ts", startLine: 8 }, { path: "lib/auth.ts", startLine: 9 }])]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), [expect.any(Number), 101]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), [expect.any(Number), 102]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), [expect.any(Number), 103]);
    expect(connection.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO changes"), expect.arrayContaining(["旧自由文案不得落库"]));
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT IGNORE INTO release_reviewed_items"), expect.arrayContaining([10, "Auth", "内部实现已检查"]));
  });

  it("builds added projections from canonical features for the first baseline release", async () => {
    const connection = connectionWithCount(0);
    const { projections } = await upsertRelease(connection, run, result, change, null, [], [
      { name: "Auth", summary: "OAuth 登录", scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 8 }] }] },
      { name: "Billing", summary: "账单", scenarios: [] },
    ]);

    expect(projections).toHaveLength(2);
    expect(projections[0]).toMatchObject({ featureName: "Auth", kind: "added", sourceSpecChangeIds: [] });
    expect(projections[0].description).toContain("OAuth 登录");
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO changes"), expect.arrayContaining([10, "Auth", "added"]));
    expect(connection.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO change_sources"), expect.anything());
  });

  it("stores the release's changed files for evidence-path mapping", async () => {
    const connection = connectionWithCount(0);
    const files = [{ path: "components/login.tsx", status: "modified", patch: "" }, { path: "lib/token.ts", status: "added", patch: "" }];
    await upsertRelease(connection, run, result, { ...change, files });
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM release_files"), [10]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT IGNORE INTO release_files"), [10, "components/login.tsx", 1]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT IGNORE INTO release_files"), [10, "lib/token.ts", 1]);
  });

  it("generates scenario regression tasks inside the same transaction", async () => {
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id FROM releases")) return [[{ id: 10 }]];
        if (sql.includes("SELECT COUNT(*)")) return [[{ count: 1 }]];
        if (sql.includes("spec_version_id AS specVersionId")) return [[{ specVersionId: 44, repositoryId: 3 }]];
        if (sql.includes("FROM spec_changes c")) return [[{ id: 101, entityType: "scenario", kind: "changed", featureKey: "login", featureName: "统一登录", scenarioReference: "HP-1", featureId: 11, scenarioId: 501 }]];
        if (sql.includes("FROM release_files")) return [[{ path: "components/login.tsx" }]];
        if (sql.includes("spec_file_index")) return [[]];
        if (sql.includes("spec_scenarios ss ON ss.spec_feature_id")) return [[]];
        if (sql.includes("FROM regression_tasks")) return [[]];
        return [{}];
      }),
    } as unknown as PoolConnection;
    await upsertRelease(connection, run, result, change);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO regression_tasks"), [10, 501, null]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("regression_task_sources"), expect.anything());
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("regression_task_reasons"), expect.anything());
  });

  it("clears verification only when regenerated content actually changed (P1 transitions 1/2)", async () => {
    const connection = { execute: vi.fn(async () => [{}]) } as unknown as PoolConnection;
    await upsertGeneratedSpec(connection, run, [
      { name: "Auth", summary: "Auth", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [] }] },
      { name: "Carried", summary: "Same", scenarios: [] },
    ]);
    // 场景 upsert 带 source='generated' 守卫 + 内容比对：内容相同（carry-forward）不清核实。
    expect(connection.execute).toHaveBeenCalledWith(
      expect.stringContaining("verified_at = IF(source = 'generated' AND (context <> VALUES(context)"),
      expect.anything(),
    );
    // 功能 upsert 同样按 summary 内容比对。
    expect(connection.execute).toHaveBeenCalledWith(
      expect.stringContaining("verified_at = IF(source = 'generated' AND summary <> VALUES(summary)"),
      expect.anything(),
    );
    // 编辑路径不得出现「清 stale」：P1 解耦后 stale 只由核实动作或重新分析清除。
    expect(connection.execute).not.toHaveBeenCalledWith(expect.stringContaining("stale_since = NULL"), expect.anything());
  });

  it("moves an existing release to the latest spec version for the same SHA", async () => {
    const connection = connectionWithCount(0);
    await upsertRelease(connection, run, result, change);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE analysis_run_id = VALUES(analysis_run_id), spec_version_id = VALUES(spec_version_id)"), expect.any(Array));
  });

  it("retains generated parents that still have active children", async () => {
    const connection = { execute: vi.fn(async () => [{}]) } as unknown as PoolConnection;
    await upsertGeneratedSpec(connection, run, []);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("LEFT JOIN features child ON child.parent_id = f.id AND child.active = 1"), [4]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("AND child.id IS NULL"), [4]);
    // 空合并列表(极端情形)下没有任何重新激活 upsert:工作台全下线是诚实状态
    expect(connection.execute).toHaveBeenCalledTimes(2);
  });

  it("reactivates carried features passed in the merged spec, not just AI output", async () => {
    const connection = { execute: vi.fn(async () => [{}]) } as unknown as PoolConnection;
    // 增量模式:AI 原始输出只含 Auth;合并结果额外含 carried 的 Legacy 与 Manual(人工条目)
    await upsertGeneratedSpec(connection, run, [
      { name: "Auth", summary: "Auth", scenarios: [] },
      { name: "Legacy", summary: "Legacy", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" as const, evidence: [] }] },
      { name: "Manual feature", summary: "Curated", scenarios: [], source: "manual" as const },
    ]);
    const upserts = (connection.execute as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) => String(call[0]).includes("INSERT INTO features"));
    const names = upserts.map((call: unknown[]) => (call[1] as unknown[])[1]);
    expect(names).toEqual(["Auth", "Legacy", "Manual feature"]);
  });
});

describe("loadPreviousSpecText (P0 anchoring loader)", () => {
  function executeWith(version: unknown[], features: unknown[], scenarios: unknown[]): Execute {
    return vi.fn(async (sql: string) => {
      if (sql.includes("FROM spec_versions")) return [version];
      if (sql.includes("FROM spec_features")) return [features];
      if (sql.includes("FROM spec_scenarios")) return [scenarios];
      return [[]];
    }) as unknown as Execute;
  }

  it("loads the latest version's scenario-level text grouped by feature", async () => {
    const execute = executeWith(
      [{ id: 77 }],
      [{ id: 1, name: "统一登录", summary: "OAuth" }, { id: 2, name: "规格导出", summary: "JSON" }],
      [
        { featureId: 1, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" },
        { featureId: 2, reference: "ER-1", context: "x", action: "y", outcome: "z", category: "error" },
      ],
    );
    const spec = await loadPreviousSpecText(3, execute);
    expect(spec).toEqual([
      { name: "统一登录", summary: "OAuth", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] },
      { name: "规格导出", summary: "JSON", scenarios: [{ reference: "ER-1", context: "x", action: "y", outcome: "z", category: "error" }] },
    ]);
  });

  it("returns empty without a previous version or features", async () => {
    expect(await loadPreviousSpecText(3, executeWith([], [], []))).toEqual([]);
    expect(await loadPreviousSpecText(3, executeWith([{ id: 77 }], [], []))).toEqual([]);
  });

  it("prioritizes affected features ahead of position order (BM-6 A1 锚定向)", async () => {
    const execute = executeWith(
      [{ id: 77 }],
      [{ id: 1, name: "统一登录", summary: "OAuth" }, { id: 2, name: "规格导出", summary: "JSON" }, { id: 3, name: "产品简介编辑", summary: "描述" }],
      [
        { featureId: 1, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" },
        { featureId: 2, reference: "ER-1", context: "x", action: "y", outcome: "z", category: "error" },
        { featureId: 3, reference: "EC-1", context: "p", action: "q", outcome: "r", category: "edge" },
      ],
    );
    const spec = await loadPreviousSpecText(3, execute, ["产品简介编辑"]);
    // 受影响功能排最前（24k 截断时先保受影响功能的锚），其余保持 position 序。
    expect(spec.map((feature) => feature.name)).toEqual(["产品简介编辑", "统一登录", "规格导出"]);
    // 无命中时顺序不变
    const unchanged = await loadPreviousSpecText(3, execute, ["不存在功能"]);
    expect(unchanged.map((feature) => feature.name)).toEqual(["统一登录", "规格导出", "产品简介编辑"]);
  });
});

describe("saveResult 行为来源最终映射 (Task 12)", () => {
  const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const ORIGIN_KEY = 'scenario|["unit:login","anchor:login-hp","001"]';
  const link: AnchorScenarioLink = { runId: run.id, unitKey: "unit:login", anchorKey: "anchor:login-hp", localScenarioKey: ORIGIN_KEY };
  const resultWithOrigins: MergeResult = {
    ...result,
    features: [{
      name: "Auth",
      summary: "Auth",
      scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 8 }], originKeys: [ORIGIN_KEY] }],
    }],
  };

  function connection(options: { latestRunId?: number; anchorUpdateAffectedRows?: number } = {}) {
    let featureId = 600;
    let scenarioId = 700;
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id FROM analysis_runs")) return [[{ id: options.latestRunId ?? run.id }]];
      if (sql.includes("INSERT INTO spec_versions")) return [{ insertId: 99 }];
      if (sql.includes("INSERT INTO spec_features")) return [{ insertId: featureId++ }];
      if (sql.includes("INSERT INTO spec_scenarios")) return [{ insertId: scenarioId++ }];
      if (sql.includes("INSERT INTO spec_changes")) return [{ insertId: 500 }];
      // 无上一版规格 / 无人工条目 / 无墓碑：insertSpecVersion 首版基线
      if (sql.includes("SELECT id FROM spec_versions")) return [[]];
      if (sql.includes("FROM features LEFT JOIN features parents")) return [[]];
      if (sql.includes("SELECT name FROM features")) return [[]];
      if (sql.includes("SELECT f.name AS featureName")) return [[]];
      if (sql.includes("FROM spec_features sf")) return [[]]; // rebuildSpecFileIndex：空索引
      if (sql.includes("FROM spec_changes WHERE spec_version_id")) return [[]]; // markSpecDrift：无变化不打点
      // upsertRelease：既有发布归当前 run（幂等短路），已有 changes → ensureRegressionTasks 早退
      if (sql.includes("analysis_run_id AS analysisRunId")) return [[{ id: 10, analysisRunId: run.id }]];
      if (sql.includes("SELECT id FROM releases")) return [[{ id: 10 }]];
      if (sql.includes("SELECT COUNT(*)")) return [[{ count: 1 }]];
      if (sql.includes("spec_version_id AS specVersionId")) return [[{ specVersionId: null }]];
      if (sql.includes("FROM spec_changes c")) return [[]];
      if (sql.includes("UPDATE analysis_behavior_anchor_scenarios")) return [{ affectedRows: options.anchorUpdateAffectedRows ?? 1 }];
      if (sql.includes("UPDATE analysis_runs")) return [{ affectedRows: 1 }];
      return [{}];
    });
    return {
      execute,
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
    } as unknown as PoolConnection;
  }

  it("backfills final_scenario_id for anchor scenario links inside the same transaction", async () => {
    const stub = connection();
    dbMock.connection = stub;
    await analysis.saveResult(run, resultWithOrigins, change, null, undefined, [link]);
    expect(stub.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE analysis_behavior_anchor_scenarios SET final_scenario_id = ?"),
      [700, run.id, sha256(link.anchorKey), sha256(link.localScenarioKey)],
    );
    expect(stub.commit).toHaveBeenCalledTimes(1);
    expect(stub.rollback).not.toHaveBeenCalled();
  });

  it("rolls back when a link's local scenario key has no final scenario mapping", async () => {
    const stub = connection();
    dbMock.connection = stub;
    const missing: AnchorScenarioLink = { ...link, localScenarioKey: 'scenario|["unit:login","anchor:login-hp","099"]' };
    await expect(analysis.saveResult(run, resultWithOrigins, change, null, undefined, [missing])).rejects.toThrow(/behavior_final_mapping_missing/);
    expect(stub.rollback).toHaveBeenCalledTimes(1);
    expect(stub.commit).not.toHaveBeenCalled();
    // 缺失映射先全量收集再抛：不得发出任何半更新
    expect(stub.execute).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE analysis_behavior_anchor_scenarios"), expect.anything());
  });

  it("rolls back when the anchor link row no longer exists (affectedRows = 0)", async () => {
    const stub = connection({ anchorUpdateAffectedRows: 0 });
    dbMock.connection = stub;
    await expect(analysis.saveResult(run, resultWithOrigins, change, null, undefined, [link])).rejects.toThrow(/behavior_final_mapping_row_missing/);
    expect(stub.rollback).toHaveBeenCalledTimes(1);
    expect(stub.commit).not.toHaveBeenCalled();
  });

  it("keeps the superseded-run guard ahead of any spec writes", async () => {
    const stub = connection({ latestRunId: 999 });
    dbMock.connection = stub;
    await expect(analysis.saveResult(run, resultWithOrigins, change, null, undefined, [link])).rejects.toThrow("Analysis superseded by run 999");
    expect(stub.rollback).toHaveBeenCalledTimes(1);
    expect(stub.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_versions"), expect.anything());
    expect(stub.execute).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE analysis_behavior_anchor_scenarios"), expect.anything());
  });
});

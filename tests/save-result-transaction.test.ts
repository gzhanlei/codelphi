import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnchorScenarioLink } from "../lib/behavior-unit-state";
import { saveResult, saveResultInTransaction, type RunContext } from "../lib/analysis";
import type { AnalysisResult } from "../lib/ai";
import type { MergeResult } from "../lib/extraction-merge";
import { behavioralPathsOf } from "../lib/patch-scan";

// saveResult 经 getDb().getConnection() 自取事务连接：mock db 模块注入 stub 连接。
const dbMock = vi.hoisted(() => ({ connection: undefined as unknown }));
vi.mock("../lib/db", () => ({
  getDb: () => ({ execute: vi.fn(), getConnection: async () => dbMock.connection }),
  defaultExecute: async () => [[]],
}));

const run: RunContext = { id: 2, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: null, afterSha: "sha-2", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const result: MergeResult = {
  product: { description: "Authentication and product knowledge.", evidence: [{ path: "lib/db.ts", startLine: 1 }] },
  release: { title: "Title", summary: "Summary" },
  changes: [{ featureName: "Auth", kind: "changed", description: "Changed", userImpact: "", evidence: [] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 8 }], originKeys: ['scenario|["unit:login","anchor:login-hp","001"]'] }] }],
};
const commentOnlyPatch = "@@ -1,2 +1,2 @@\n-// old\n+// new\n x\n";
const link: AnchorScenarioLink = { runId: run.id, unitKey: "unit:login", anchorKey: "anchor:login-hp", localScenarioKey: 'scenario|["unit:login","anchor:login-hp","001"]' };

/** 和 tests/analysis-persistence.test.ts 里同一种替身连接：按语句片段回答，首版基线、既有发布归当前 run。 */
function connection() {
  let featureId = 600;
  let scenarioId = 700;
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT id FROM analysis_runs")) return [[{ id: run.id }]];
    if (sql.includes("INSERT INTO spec_versions")) return [{ insertId: 99 }];
    if (sql.includes("INSERT INTO spec_features")) return [{ insertId: featureId++ }];
    if (sql.includes("INSERT INTO spec_scenarios")) return [{ insertId: scenarioId++ }];
    if (sql.includes("INSERT INTO spec_changes")) return [{ insertId: 500 }];
    if (sql.includes("SELECT id FROM spec_versions")) return [[]];
    if (sql.includes("FROM features LEFT JOIN features parents")) return [[]];
    if (sql.includes("SELECT name FROM features")) return [[]];
    if (sql.includes("SELECT f.name AS featureName")) return [[]];
    if (sql.includes("FROM spec_features sf")) return [[]];
    if (sql.includes("FROM spec_changes WHERE spec_version_id")) return [[]];
    if (sql.includes("SELECT id, analysis_run_id AS analysisRunId FROM releases")) return [[{ id: 10, analysisRunId: run.id }]];
    if (sql.includes("SELECT id FROM releases")) return [[{ id: 10 }]];
    if (sql.includes("SELECT COUNT(*)")) return [[{ count: 0 }]];
    if (sql.includes("spec_version_id AS specVersionId")) return [[{ specVersionId: null }]];
    if (sql.includes("FROM spec_changes c")) return [[]];
    if (sql.includes("UPDATE analysis_behavior_anchor_scenarios")) return [{ affectedRows: 1 }];
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

const change = (files: Array<{ path: string; status: string; patch: string; hunks?: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> }>, behavioralPaths?: ReadonlySet<string>) =>
  ({ message: "change", committedAt: "2026-11-01T00:00:00.000Z", url: "https://github.com/commit/sha-2", files, ...(behavioralPaths ? { behavioralPaths } : {}) });

describe("behavioralPathsOf", () => {
  const commentOnly = [{ path: "lib/a.ts", status: "modified", patch: commentOnlyPatch }];

  it("parses the patches when the caller has not computed the set", () => {
    expect([...behavioralPathsOf({ files: commentOnly })]).toEqual([]);
  });

  it("takes the set the caller already computed (a proposal carries no patch text)", () => {
    expect([...behavioralPathsOf({ files: commentOnly, behavioralPaths: new Set(["lib/a.ts"]) })]).toEqual(["lib/a.ts"]);
  });
});

describe("saveResultInTransaction", () => {
  it("writes exactly what saveResult writes and leaves begin, commit, rollback and release to the caller", async () => {
    const viaWrapper = connection();
    dbMock.connection = viaWrapper;
    const throughWrapper = await saveResult(run, result, change([{ path: "lib/auth.ts", status: "modified", patch: commentOnlyPatch }]), null, undefined, [link]);
    const direct = connection();
    const inTransaction = await saveResultInTransaction(direct, run, result, change([{ path: "lib/auth.ts", status: "modified", patch: commentOnlyPatch }]), null, undefined, [link]);

    expect((direct.execute as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual((viaWrapper.execute as unknown as { mock: { calls: unknown[] } }).mock.calls);
    // 事务体多回报两样：activate（托管路径据此决定提交后要不要抛「被超越」）和 supersededBy（抛的时候报谁更新）。
    expect(inTransaction).toEqual({ ...throughWrapper, activate: true, supersededBy: run.id });
    expect(Object.keys(throughWrapper)).not.toContain("activate");
    expect(Object.keys(throughWrapper)).not.toContain("supersededBy");
    expect(direct.beginTransaction).not.toHaveBeenCalled();
    expect(direct.commit).not.toHaveBeenCalled();
    expect(direct.rollback).not.toHaveBeenCalled();
    expect((direct as unknown as { release: ReturnType<typeof vi.fn> }).release).not.toHaveBeenCalled();
    expect(viaWrapper.beginTransaction).toHaveBeenCalledTimes(1);
    expect(viaWrapper.commit).toHaveBeenCalledTimes(1);
  });

  it("rolls back nothing itself: an error thrown inside reaches the caller after nothing was committed", async () => {
    const direct = connection();
    (direct.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE analysis_behavior_anchor_scenarios")) return [{ affectedRows: 0 }];
      return (connection().execute as unknown as (sql: string) => Promise<unknown>)(sql);
    });
    await expect(saveResultInTransaction(direct, run, result, change([]), null, undefined, [link])).rejects.toThrow(/behavior_final_mapping_row_missing/);
    expect(direct.commit).not.toHaveBeenCalled();
    expect(direct.rollback).not.toHaveBeenCalled();
  });

  it("uses the behavioural set the caller computed when recording the release's files", async () => {
    const stub = connection();
    dbMock.connection = stub;
    // 补丁只有注释，按补丁算不是行为变更；调用方说它是，就以调用方的为准。
    await saveResult(run, result, change([{ path: "lib/auth.ts", status: "modified", patch: commentOnlyPatch, hunks: [{ oldStart: 7, oldCount: 2, newStart: 7, newCount: 2 }] }], new Set(["lib/auth.ts"])), null, undefined, [link]);
    expect(stub.execute).toHaveBeenCalledWith("INSERT IGNORE INTO release_files (release_id, path, behavioral_change) VALUES (?, ?, ?)", [10, "lib/auth.ts", 1]);
  });

  it("still derives the flag from the patch when the caller computed nothing", async () => {
    const stub = connection();
    dbMock.connection = stub;
    await saveResult(run, result, change([{ path: "lib/auth.ts", status: "modified", patch: commentOnlyPatch }]), null, undefined, [link]);
    expect(stub.execute).toHaveBeenCalledWith("INSERT IGNORE INTO release_files (release_id, path, behavioral_change) VALUES (?, ?, ?)", [10, "lib/auth.ts", 0]);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { Execute } from "../lib/db";
import { assertLatestRun, upsertGeneratedSpec, upsertRelease, type RunContext } from "../lib/analysis";
import { loadPreviousSpecText } from "../lib/spec-versions";

const run: RunContext = { id: 2, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: null, afterSha: "sha-2", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const result: AnalysisResult = {
  product: { description: "Authentication and product knowledge.", evidence: [{ path: "lib/db.ts", startLine: 1 }] },
  release: { title: "Title", summary: "Summary" },
  changes: [{ featureName: "Auth", kind: "changed", description: "Changed", userImpact: "", evidence: [] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [] }],
};
const change = { message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha-2", files: [] };

function connectionWithCount(count: number) {
  return {
    execute: vi.fn(async (sql: string) => {
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
    await upsertRelease(connection, run, result, change);
    // +1 = 自动发布稿草稿的候选查询（无 Highlight → 不生成）
    expect(connection.execute).toHaveBeenCalledTimes(7);
  });

  it("inserts changes when the release has none", async () => {
    const connection = connectionWithCount(0);
    await upsertRelease(connection, run, result, change);
    expect(connection.execute).toHaveBeenCalledTimes(8);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO changes"), [10, "Auth", "changed", "Changed", "", "[]"]);
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
});

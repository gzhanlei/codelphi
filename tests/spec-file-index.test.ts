import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { rebuildSpecFileIndex } from "../lib/spec-file-index";

function connectionWith(selectResult: unknown[]) {
  const execute = vi.fn();
  const connection = { execute } as unknown as PoolConnection;
  execute.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM spec_features")) return [selectResult];
    return [{}];
  });
  return { connection, execute };
}

describe("spec file index rebuild", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extracts evidence paths from the fresh spec snapshot and replaces the index", async () => {
    const { connection, execute } = connectionWith([
      { specFeatureId: 11, specScenarioId: 21, evidence: JSON.stringify([{ path: "lib/analysis.ts", startLine: 24 }]) },
      { specFeatureId: 11, specScenarioId: 22, evidence: JSON.stringify([{ path: "lib/analysis.ts" }, { path: "lib/spec-diff.ts", startLine: 9 }]) },
      { specFeatureId: 12, specScenarioId: null, evidence: null },
      { specFeatureId: 13, specScenarioId: 23, evidence: "not json" },
    ]);
    await rebuildSpecFileIndex(connection, 4, 900);
    const sqls = execute.mock.calls.map(([sql]) => sql as string);
    expect(sqls[0]).toContain("FROM spec_features");
    expect(sqls.some((sql) => sql.startsWith("DELETE FROM spec_file_index WHERE repository_id = ?"))).toBe(true);

    const inserts = execute.mock.calls.filter(([sql]) => (sql as string).startsWith("INSERT INTO spec_file_index"));
    const rows = inserts.map(([, parameters]) => parameters as unknown[]);
    expect(rows).toEqual([
      [4, 900, 11, 21, "lib/analysis.ts"],
      [4, 900, 11, 22, "lib/analysis.ts"],
      [4, 900, 11, 22, "lib/spec-diff.ts"],
    ]);
  });

  it("writes nothing when the snapshot has no evidence", async () => {
    const { connection, execute } = connectionWith([
      { specFeatureId: 11, specScenarioId: 21, evidence: "[]" },
      { specFeatureId: 12, specScenarioId: null, evidence: null },
    ]);
    await rebuildSpecFileIndex(connection, 4, 900);
    expect(execute.mock.calls.some(([sql]) => (sql as string).startsWith("INSERT INTO spec_file_index"))).toBe(false);
    expect(execute.mock.calls.some(([sql]) => (sql as string).startsWith("DELETE FROM spec_file_index"))).toBe(true);
  });
});

describe("spec file index migration", () => {
  it("creates the reverse index keyed by repository and path", () => {
    const sql = readFileSync(new URL("../migrations/017_spec_file_index.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS spec_file_index");
    expect(sql).toContain("spec_file_index_repo_path_idx");
    expect(sql).toContain("path VARCHAR(500) NOT NULL");
  });
});

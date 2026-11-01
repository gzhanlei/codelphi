import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import { assertLatestRun, upsertRelease, type RunContext } from "../lib/analysis";

const run: RunContext = { id: 2, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: null, afterSha: "sha-2" };
const result: AnalysisResult = {
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
    expect(connection.execute).toHaveBeenCalledTimes(3);
  });

  it("inserts changes when the release has none", async () => {
    const connection = connectionWithCount(0);
    await upsertRelease(connection, run, result, change);
    expect(connection.execute).toHaveBeenCalledTimes(4);
    expect(connection.execute).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO changes"), [10, "Auth", "changed", "Changed", "", "[]"]);
  });
});

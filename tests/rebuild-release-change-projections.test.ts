import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import {
  applyReleaseRebuild,
  planReleaseRebuild,
  restoreProjectionBackup,
  type LegacyChangeRow,
  type RebuildReleaseInput,
} from "../scripts/rebuild-release-change-projections";
import type { ReleaseChangeFact } from "../lib/release-change-projection";

function fact(id: number, summary: string): ReleaseChangeFact {
  return {
    id,
    kind: "changed",
    entityType: "scenario",
    featureName: "变化条目措辞变体判定",
    scenarioReference: `EC-${id}`,
    summary,
    before: null,
    after: { reference: `EC-${id}`, context: "c", action: "a", outcome: "o", category: "edge", evidence: [{ path: "lib/spec-diff.ts", startLine: 300 + id }] },
  };
}

function legacyChange(id: number, description: string): LegacyChangeRow {
  return { id, releaseId: 228, featureName: "变化条目措辞变体判定", kind: "changed", description, userImpact: description, evidence: [{ path: "lib/spec-diff.ts", startLine: 305 }] };
}

const variants = [
  "散文中的「≥1 对」「5 个」等数字噪声不再阻断变体折叠。",
  "散文里的个位数计数不再阻止同一行为的措辞变体折叠；404 与 400 仍被守护。",
  "散文里的个位数计数不再导致同一变化被误判为不同条目。",
];

function input(overrides: Partial<RebuildReleaseInput> = {}): RebuildReleaseInput {
  return {
    releaseId: 228,
    facts: variants.map((summary, index) => fact(index + 1, summary)),
    existingChanges: variants.map((description, index) => legacyChange(index + 1, description)),
    existingSources: [],
    ...overrides,
  };
}

describe("planReleaseRebuild", () => {
  it("rebuilds legacy wording variants as one source-linked canonical projection", () => {
    const plan = planReleaseRebuild(input());
    expect(plan).not.toBeNull();
    expect(plan?.projections).toHaveLength(1);
    expect(plan?.projections[0].sourceSpecChangeIds).toEqual([1, 2, 3]);
    expect(plan?.backup.changes).toHaveLength(3);
  });

  it("skips already source-linked releases and never wipes a zero-fact release", () => {
    expect(planReleaseRebuild(input({ existingSources: [{ changeId: 1, specChangeId: 1 }] }))).toBeNull();
    expect(planReleaseRebuild(input({ facts: [] }))).toBeNull();
  });
});

describe("applyReleaseRebuild", () => {
  it("backs up and replaces a release in one transaction", async () => {
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO release_change_projection_backups")) return [{ insertId: 777 }];
        if (sql.includes("INSERT INTO changes")) return [{ insertId: 500 }];
        return [{}];
      }),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    } as unknown as PoolConnection;

    const result = await applyReleaseRebuild(connection, input());

    expect(result).toEqual({ backupId: 777, projectionCount: 1 });
    expect(connection.execute).toHaveBeenCalledWith("SELECT id FROM releases WHERE id = ? FOR UPDATE", [228]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO release_change_projection_backups"), expect.arrayContaining([228]));
    expect(connection.execute).toHaveBeenCalledWith("DELETE FROM changes WHERE release_id = ?", [228]);
    expect(connection.execute).toHaveBeenCalledWith("INSERT INTO change_sources (change_id, spec_change_id) VALUES (?, ?)", [500, 3]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("rolls back without committing when replacement fails", async () => {
    const connection = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO release_change_projection_backups")) return [{ insertId: 777 }];
        if (sql.includes("DELETE FROM changes")) throw new Error("delete failed");
        return [{}];
      }),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    } as unknown as PoolConnection;

    await expect(applyReleaseRebuild(connection, input())).rejects.toThrow("delete failed");
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.commit).not.toHaveBeenCalled();
  });
});

describe("restoreProjectionBackup", () => {
  it("restores exact legacy IDs and source links", async () => {
    const connection = {
      execute: vi.fn(async () => [{}]),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    } as unknown as PoolConnection;
    const backup = {
      id: 777,
      releaseId: 228,
      changes: [legacyChange(9, "旧文案")],
      sources: [{ changeId: 9, specChangeId: 99 }],
    };

    await restoreProjectionBackup(connection, backup);

    expect(connection.execute).toHaveBeenCalledWith("DELETE FROM changes WHERE release_id = ?", [228]);
    expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO changes"), [9, 228, "变化条目措辞变体判定", "changed", "旧文案", "旧文案", JSON.stringify([{ path: "lib/spec-diff.ts", startLine: 305 }])]);
    expect(connection.execute).toHaveBeenCalledWith("INSERT INTO change_sources (change_id, spec_change_id) VALUES (?, ?)", [9, 99]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });
});

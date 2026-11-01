import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { RunContext } from "../lib/analysis";
import { insertSpecVersion } from "../lib/spec-versions";

const run: RunContext = { id: 8, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: "a", afterSha: "b", connectionId: null };
const scenario = { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" as const, evidence: [] };
const result: AnalysisResult = {
  release: { title: "Title", summary: "Summary" },
  changes: [],
  features: [
    { name: "Authentication", summary: "OAuth", scenarios: [{ ...scenario, outcome: "Onboarding" }] },
    { name: "New feature", summary: "Added", scenarios: [] },
  ],
};

function connection(previousVersions: Array<{ id: number }>, manual = false) {
  const changes: unknown[][] = [];
  let featureId = 100;
  const connection = {
    execute: vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("SELECT id FROM spec_versions")) return [previousVersions];
      if (sql.includes("FROM spec_features WHERE spec_version_id")) {
        return [[
          { id: 1, name: "Authentication", summary: "Old", parentKey: null, source: "generated" },
          { id: 2, name: "Legacy", summary: "Removed", parentKey: null, source: "generated" },
        ]];
      }
      if (sql.includes("FROM spec_scenarios WHERE spec_feature_id")) return [[{ featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: "[]" }]];
      if (sql.includes("SELECT id, name, summary, source FROM features")) return [manual ? [{ id: 5, name: "Manual feature", summary: "Curated", source: "manual" }] : []];
      if (sql.includes("FROM scenarios WHERE source = 'manual'")) return [[{ featureId: 5, reference: "HP-9", context: "User", action: "Reads", outcome: "Learns", category: "happy", source: "manual", evidence: "[]" }]];
      if (sql.includes("INSERT INTO spec_versions")) return [{ insertId: 99 }];
      if (sql.includes("INSERT INTO spec_features")) return [{ insertId: featureId++ }];
      if (sql.includes("INSERT INTO spec_changes")) changes.push(parameters);
      return [{}];
    }),
    changes,
  };
  return connection as unknown as PoolConnection & { changes: unknown[][] };
}

describe("spec version persistence", () => {
  it("writes a complete version and deterministic before/after changes", async () => {
    const db = connection([{ id: 11 }]);
    const versionId = await insertSpecVersion(db, run, result);
    expect(versionId).toBe(99);
    expect(db.changes).toHaveLength(4);
    expect(db.changes.map((change) => change[3])).toEqual(expect.arrayContaining(["added", "changed", "removed"]));
    expect(db.changes.every((change) => change[1] === 11)).toBe(true);
    expect(db.changes.some((change) => change[8] === null)).toBe(true);
    expect(db.changes.some((change) => change[9] === null)).toBe(true);
    expect(db.changes.some((change) => change[6] === "")).toBe(true);
    expect(db.changes.filter((change) => change[2] === "feature").every((change) => change[6] === "")).toBe(true);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining([null, "generated"]));
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["generated"]));
  });

  it("records no changes for a first version", async () => {
    const db = connection([]);
    await insertSpecVersion(db, run, { ...result, features: [result.features[0]] });
    expect(db.changes).toHaveLength(0);
  });

  it("includes manual features and scenarios in the immutable snapshot", async () => {
    const db = connection([], true);
    await insertSpecVersion(db, run, { ...result, features: [result.features[0]] });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Manual feature", "Curated"]));
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["HP-9", "Learns"]));
  });
});

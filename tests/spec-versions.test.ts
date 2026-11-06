import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { RunContext } from "../lib/analysis";
import { featureParentKey, insertSpecVersion, loadPreviousFeatureNames } from "../lib/spec-versions";

const run: RunContext = { id: 8, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: "a", afterSha: "b", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const scenario = { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" as const, evidence: [] };
const result: AnalysisResult = {
  product: { description: "Versioned product", evidence: [{ path: "lib/spec-versions.ts", startLine: 1 }] },
  release: { title: "Title", summary: "Summary" },
  changes: [],
  features: [
    { name: "Authentication", summary: "OAuth", scenarios: [{ ...scenario, outcome: "Onboarding" }] },
    { name: "New feature", summary: "Added", scenarios: [] },
  ],
};

function connection(previousVersions: Array<{ id: number }>, manual = false, tombstones: { feature?: string; scenario?: string } = {}) {
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
      if (sql.includes("SELECT name FROM features WHERE product_id")) return [tombstones.feature ? [{ name: tombstones.feature }] : []];
      if (sql.includes("SELECT f.name AS featureName")) return [tombstones.scenario ? [{ featureName: "Authentication", reference: tombstones.scenario }] : []];
      if (sql.includes("FROM features LEFT JOIN features parents")) return [manual ? [{ id: 5, name: "Manual feature", summary: "Curated", parentId: 42, parentKey: "Generated parent", source: "manual" }] : []];
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
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Manual feature", "Curated", "Generated parent"]));
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("LEFT JOIN features parents"), [4]);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("FROM features child WHERE child.parent_id = features.id AND child.active = 1"), [4]);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["HP-9", "Learns"]));
  });

  it("resolves live parent ids and immutable parent keys", () => {
    const names = new Map([[1, "Parent"]]);
    expect(featureParentKey({ parentId: 1 }, names)).toBe("Parent");
    expect(featureParentKey({ parentId: 2 }, names)).toBeNull();
    expect(featureParentKey({ parentId: 2, parentKey: "Generated parent" }, names)).toBe("Generated parent");
    expect(featureParentKey({ parentKey: "Historical parent" }, names)).toBe("Historical parent");
    expect(featureParentKey({ parentKey: null }, names)).toBeNull();
    expect(featureParentKey({}, names)).toBeNull();
  });

  it("does not resurrect manually deleted generated content", async () => {
    const db = connection([], false, { feature: "New feature", scenario: "HP-1" });
    await insertSpecVersion(db, run, result);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Authentication"]));
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["New feature"]));
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["HP-1"]));
  });
});

describe("loadPreviousFeatureNames", () => {
  it("unwraps the mysql2 [rows, fields] tuple and maps feature names", async () => {
    const execute = vi.fn(async () => [[{ name: "登录" }, { name: "支付" }], [{ name: "name" }]]);
    await expect(loadPreviousFeatureNames(3, execute)).resolves.toEqual(["登录", "支付"]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("spec_version_id = (SELECT id FROM spec_versions"), [3]);
  });

  it("returns an empty list when no spec version exists", async () => {
    const execute = vi.fn(async () => [[], []]);
    await expect(loadPreviousFeatureNames(3, execute)).resolves.toEqual([]);
  });
});

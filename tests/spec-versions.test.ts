import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { RunContext } from "../lib/analysis";
import { detectSpecCollapse, featureParentKey, insertSpecVersion, loadPreviousFeatureNames } from "../lib/spec-versions";

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
    const { specVersionId } = await insertSpecVersion(db, run, result);
    expect(specVersionId).toBe(99);
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

  it("carries forward unaffected previous features without recording their changes", async () => {
    const db = connection([{ id: 11 }]);
    const { features } = await insertSpecVersion(db, run, { ...result, features: [result.features[0]] }, { affectedKeys: new Set(["authentication"]) });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Legacy"]));
    const featureChanges = db.changes.filter((change) => change[2] === "feature");
    expect(featureChanges.some((change) => change[5] === "Legacy")).toBe(false);
    // 返回值是合并后的完整规格：AI 提取的受影响功能 + 沿用的未受影响功能，
    // M9 影子对比以此（而非 AI 原始输出）为对比对象。
    expect(features.map((feature) => feature.name)).toEqual(expect.arrayContaining(["Legacy", result.features[0].name]));
  });

  it("keeps full-mode semantics when no affected keys are given", async () => {
    const db = connection([{ id: 11 }]);
    await insertSpecVersion(db, run, { ...result, features: [result.features[0]] });
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Legacy"]));
  });

  it("drops AI features that rewrite carried keys and keeps the carried content (BM-4 身份门禁)", async () => {
    const db = connection([{ id: 11 }]);
    const hijack = { name: "Legacy", summary: "SQL Lab 对无 schema 表应用 RLS", scenarios: [{ ...scenario, outcome: "RLS 谓词注入" }] };
    const { features, identityHijacksDropped } = await insertSpecVersion(
      db,
      run,
      { ...result, features: [result.features[0], result.features[1], hijack] },
      { affectedKeys: new Set(["authentication"]) },
    );
    expect(identityHijacksDropped).toBe(1);
    // carried 内容保全：Legacy 仍是上一版原样（summary "Removed"），不是 AI 的劫持内容
    const legacy = features.find((feature) => feature.name === "Legacy");
    expect(legacy?.summary).toBe("Removed");
    expect(features.some((feature) => feature.name === "Legacy" && feature.summary === "SQL Lab 对无 schema 表应用 RLS")).toBe(false);
    // 真实新行为不受影响：新键（contract ②）与受影响键（contract ①）照常写入
    expect(features.map((feature) => feature.name)).toEqual(expect.arrayContaining(["Authentication", "New feature"]));
  });

  it("does not engage the identity gate in full mode", async () => {
    const db = connection([{ id: 11 }]);
    const hijack = { name: "Legacy", summary: "Rewritten", scenarios: [] };
    const { features, identityHijacksDropped } = await insertSpecVersion(db, run, { ...result, features: [...result.features, hijack] });
    expect(identityHijacksDropped).toBe(0);
    expect(features.some((feature) => feature.name === "Legacy" && feature.summary === "Rewritten")).toBe(true);
  });

  it("does not resurrect manually deleted generated content", async () => {
    const db = connection([], false, { feature: "New feature", scenario: "HP-1" });
    await insertSpecVersion(db, run, result);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Authentication"]));
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["New feature"]));
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["HP-1"]));
  });

  it("returns collapse: null for ordinary versions", async () => {
    const db = connection([{ id: 11 }]);
    const { collapse } = await insertSpecVersion(db, run, result);
    expect(collapse).toBeNull();
  });
});

describe("detectSpecCollapse (护栏)", () => {
  const scenario = { reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" as const, evidence: [] };
  const featuresWithScenarios = (count: number) => [{ name: "功能", summary: "s", scenarios: Array.from({ length: count }, () => ({ ...scenario })) }];

  it("flags a version whose scenario count drops past the threshold (生产 v95 形态：178→83)", () => {
    expect(detectSpecCollapse({ features: featuresWithScenarios(178) }, featuresWithScenarios(83))).toEqual({ previousScenarios: 178, currentScenarios: 83 });
  });

  it("passes versions within the threshold", () => {
    expect(detectSpecCollapse({ features: featuresWithScenarios(100) }, featuresWithScenarios(70))).toBeNull();
    expect(detectSpecCollapse({ features: featuresWithScenarios(100) }, featuresWithScenarios(120))).toBeNull();
  });

  it("ignores small specs and first versions", () => {
    expect(detectSpecCollapse({ features: featuresWithScenarios(19) }, featuresWithScenarios(0))).toBeNull();
    expect(detectSpecCollapse(null, featuresWithScenarios(0))).toBeNull();
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

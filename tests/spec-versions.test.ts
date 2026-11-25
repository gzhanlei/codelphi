import { describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AnalysisResult } from "../lib/ai";
import type { RunContext } from "../lib/analysis";
import type { MergeResult } from "../lib/extraction-merge";
import { detectFeatureCollapses, detectMisplacedScenarios, detectSpecCollapse, featureParentKey, foldVariantFeatures, insertSpecVersion, loadBaseVersionMap, loadLatestSpecVersionLanguage, loadPreviousFeatureNames, widenTombstonesByIdentity } from "../lib/spec-versions";
import { scenarioIdentityKey } from "../lib/spec-identity";
import { specScenarioKey } from "../lib/spec-diff";
const run: RunContext = { id: 8, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: "a", afterSha: "b", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const scenario = { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" as const, evidence: [] };
const previousScenario = (reference: string, path: string) => ({ featureId: 1, reference, context: "User", action: "Uses links", outcome: "Links work", category: "happy", source: "generated", evidence: JSON.stringify([{ path, startLine: 1 }]) });
const result: AnalysisResult = {
  product: { description: "Versioned product", evidence: [{ path: "lib/spec-versions.ts", startLine: 1 }] },
  release: { title: "Title", summary: "Summary" },
  changes: [],
  features: [
    { name: "Authentication", summary: "OAuth", scenarios: [{ ...scenario, outcome: "Onboarding" }] },
    { name: "New feature", summary: "Added", scenarios: [] },
  ],
};

function connection(previousVersions: Array<{ id: number }>, manual = false, tombstones: { feature?: string; scenario?: string } = {}, previousScenarios: Array<Record<string, unknown>> = [{ featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: "[]" }]) {
  const changes: unknown[][] = [];
  let featureId = 100;
  let changeId = 500;
  let scenarioId = 700;
  const connection = {
    execute: vi.fn(async (sql: string, parameters: unknown[] = []) => {
      // 这里没有真数据库来报错。占位符个数不等于参数个数的语句，发出去就是一条“列数与值数不一致”，当场拦住。
      expect(parameters, sql).toHaveLength((sql.match(/\?/g) ?? []).length);
      if (sql.includes("SELECT id FROM spec_versions")) return [previousVersions];
      if (sql.includes("FROM spec_features WHERE spec_version_id")) {
        return [[
          { id: 1, name: "Authentication", summary: "Old", parentKey: null, source: "generated" },
          { id: 2, name: "Legacy", summary: "Removed", parentKey: null, source: "generated" },
        ]];
      }
      if (sql.includes("FROM spec_scenarios WHERE spec_feature_id")) return [previousScenarios];
      if (sql.includes("SELECT name FROM features WHERE product_id")) return [tombstones.feature ? [{ name: tombstones.feature }] : []];
      if (sql.includes("SELECT f.name AS featureName")) return [tombstones.scenario ? [{ featureName: "Authentication", reference: tombstones.scenario }] : []];
      if (sql.includes("FROM features LEFT JOIN features parents")) return [manual ? [{ id: 5, name: "Manual feature", summary: "Curated", parentId: 42, parentKey: "Generated parent", source: "manual" }] : []];
      if (sql.includes("FROM scenarios WHERE source = 'manual'")) return [[{ featureId: 5, reference: "HP-9", context: "User", action: "Reads", outcome: "Learns", category: "happy", source: "manual", evidence: "[]" }]];
      if (sql.includes("INSERT INTO spec_versions")) return [{ insertId: 99 }];
      if (sql.includes("INSERT INTO spec_features")) return [{ insertId: featureId++ }];
      if (sql.includes("INSERT INTO spec_scenarios")) return [{ insertId: scenarioId++ }];
      if (sql.includes("INSERT INTO spec_changes")) {
        changes.push(parameters);
        return [{ insertId: changeId++ }];
      }
      return [{}];
    }),
    changes,
  };
  return connection as unknown as PoolConnection & { changes: unknown[][] };
}

describe("spec version persistence", () => {
  it("writes a complete version and deterministic before/after changes", async () => {
    const db = connection([{ id: 11 }]);
    const { specVersionId, specChanges } = await insertSpecVersion(db, run, result);
    expect(specVersionId).toBe(99);
    expect(db.changes).toHaveLength(4);
    expect(specChanges).toHaveLength(4);
    expect(specChanges.map((change) => change.id)).toEqual([500, 501, 502, 503]);
    expect(specChanges.map((change) => change.summary)).toEqual(db.changes.map((change) => change[7]));
    expect(db.changes.map((change) => change[3])).toEqual(expect.arrayContaining(["added", "changed", "uncertain"]));
    expect(db.changes.every((change) => change[1] === 11)).toBe(true);
    expect(db.changes.some((change) => change[8] === null)).toBe(true);
    expect(db.changes.some((change) => change[9] === null)).toBe(true);
    expect(db.changes.some((change) => change[6] === "")).toBe(true);
    expect(db.changes.filter((change) => change[2] === "feature").every((change) => change[6] === "")).toBe(true);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining([null, "generated"]));
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_scenarios"), expect.arrayContaining(["generated"]));
  });

  it("persists the explicit base version and reads it instead of inferring from insertion order", async () => {
    const db = connection([{ id: 11 }]);
    await insertSpecVersion(db, run, result);
    const insert = (db.execute as ReturnType<typeof vi.fn>).mock.calls.find(([sql]) => String(sql).includes("INSERT INTO spec_versions"));
    expect(insert?.[0]).toContain("base_spec_version_id");
    expect(insert?.[1]).toContain(11);

    const execute = vi.fn(async () => [[{ versionId: 99, baseVersionId: 11 }]]);
    await loadBaseVersionMap(execute, [99]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("v.base_spec_version_id"), [99]);
  });

  it("selects a historical base from runs that already existed at the run start", async () => {
    const db = connection([{ id: 11 }]);
    await insertSpecVersion(db, run, result, { base: "beforeRun" });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("analysis_run_id < ?"), [3, 8]);
  });

  it("loads the exact captured base version when one is provided", async () => {
    const db = connection([{ id: 11 }]);
    await insertSpecVersion(db, run, result, { baseVersionId: 11 });
    expect(db.execute).toHaveBeenCalledWith("SELECT id FROM spec_versions WHERE repository_id = ? AND id = ?", [3, 11]);
  });

  it("dedupes exact projections on both versions before writing release changes", async () => {
    const previous = [
      previousScenario("HP-1", "lib/github-repositories.ts"),
      { ...previousScenario("HP-1", "lib/github-repositories.ts"), featureId: 2 },
    ];
    const db = connection([{ id: 11 }], false, {}, previous);
    const currentScenario = {
      ...scenario,
      context: "User",
      action: "Uses links",
      outcome: "Links work",
      evidence: [{ path: "lib/github-repositories.ts", startLine: 1 }],
    };
    await insertSpecVersion(db, run, {
      ...result,
      features: [
        { name: "Authentication", summary: "Old", scenarios: [currentScenario] },
        { name: "GitHub repositories", summary: "Duplicate", scenarios: [{ ...currentScenario, reference: "ER-1" }] },
      ],
    });

    expect(db.changes).toEqual([]);
  });

  it("restores an exact scenario identity across a feature rename before computing changes", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "lib/behavior-unit-ai.ts")]);
    const currentScenario = {
      ...scenario,
      reference: "ER-2",
      context: "User",
      action: "Uses links",
      outcome: "Links work",
      evidence: [{ path: "lib/behavior-unit-ai.ts", startLine: 1 }],
    };
    await insertSpecVersion(db, run, {
      ...result,
      features: [
        { name: "行为清单单元提取与状态推导", summary: "Different", scenarios: [currentScenario] },
        { name: "Legacy", summary: "Removed", scenarios: [] },
      ],
    }, { behavioralChangePaths: new Set(["lib/behavior-unit-ai.ts"]) });

    expect(db.changes).toEqual([]);
  });

  it("persists uncertain removal judgment and evidence state", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "lib/behavior-unit-ai.ts")]);
    const { features } = await insertSpecVersion(db, run, { ...result, features: [{ name: "Legacy", summary: "Removed", scenarios: [] }] }, { behavioralChangePaths: new Set(["lib/behavior-unit-ai.ts"]) });

    expect(features.find((feature) => feature.name === "Authentication")?.scenarios.map((scenario) => scenario.reference)).toContain("HP-1");
    const change = db.changes.find((parameters) => parameters[2] === "feature");
    expect(change?.[2]).toBe("feature");
    expect(change?.[3]).toBe("uncertain");
    expect(change?.[12]).toBe("uncertain");
    expect(change?.[13]).toBe("not_observed");
    expect(JSON.parse(String(change?.[14]))).toEqual(["not_observed"]);
  });

  it("uses production deletion evidence to retire a fully proven removed feature", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "components/publish.tsx")]);
    await insertSpecVersion(db, run, { ...result, features: [{ name: "Legacy", summary: "Removed", scenarios: [] }] }, {
      behavioralChangePaths: new Set(["components/publish.tsx"]),
      changeFiles: [{ path: "components/publish.tsx", status: "removed", patch: "" }],
      fullAnalysis: true,
      coverageComplete: true,
    });

    expect(db.changes.some((parameters) => parameters[2] === "feature" && parameters[3] === "removed")).toBe(true);
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

  it("preserves an omitted scenario when its evidence did not change", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "server/web/src/utils/linkify.ts")]);
    const { features } = await insertSpecVersion(
      db,
      run,
      { ...result, features: [{ name: "Authentication", summary: "Fresh", scenarios: [] }] },
      { affectedKeys: new Set(["authentication"]), behavioralChangePaths: new Set(["docs/unrelated.md"]) },
    );
    expect(features.find((feature) => feature.name === "Authentication")?.scenarios.map((scenario) => scenario.reference)).toContain("HP-1");
  });

  it("keeps an omitted scenario uncertain without positive removal proof", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "server/web/src/utils/linkify.ts")]);
    const { features } = await insertSpecVersion(
      db,
      run,
      { ...result, features: [{ name: "Authentication", summary: "Fresh", scenarios: [] }] },
      { affectedKeys: new Set(["authentication"]), behavioralChangePaths: new Set(["server/web/src/utils/linkify.ts"]) },
    );
    expect(features.find((feature) => feature.name === "Authentication")?.scenarios.map((scenario) => scenario.reference)).toContain("HP-1");
  });

  it("preserves a completely omitted feature when all of its evidence is unchanged", async () => {
    const db = connection([{ id: 11 }], false, {}, [previousScenario("HP-1", "server/web/src/utils/linkify.ts")]);
    const { features } = await insertSpecVersion(
      db,
      run,
      { ...result, features: [] },
      { affectedKeys: new Set(["authentication"]), behavioralChangePaths: new Set(["docs/unrelated.md"]) },
    );
    expect(features.find((feature) => feature.name === "Authentication")?.scenarios.map((scenario) => scenario.reference)).toContain("HP-1");
  });

  it("keeps full-mode semantics when no affected keys are given", async () => {
    const db = connection([{ id: 11 }]);
    await insertSpecVersion(db, run, { ...result, features: [result.features[0]] });
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Legacy"]));
  });

  it("records feature additions in full mode even when their evidence is outside the behavioral window (生产 v201 事故形态)", async () => {
    // 全量重建时窗口行为集只覆盖本发布几个文件；tests-only 门禁若在全量模式生效，
    // 整库重提取的新功能会被整体吞掉（v201 实证：70 个新功能 0 条 added 行）。
    const db = connection([{ id: 11 }]);
    const rebuilt = {
      ...result,
      features: [
        result.features[0],
        { name: "New feature", summary: "Added", scenarios: [{ ...scenario, evidence: [{ path: "lib/brand-new.ts", startLine: 1 }] }] },
      ],
    };
    await insertSpecVersion(db, run, rebuilt, { behavioralChangePaths: new Set(["lib/mcp/server.ts"]) });
    const added = db.changes.find((change) => change[3] === "added" && change[2] === "feature");
    expect(added?.[5]).toBe("New feature");
  });

  it("keeps the tests-only fold in incremental mode (superset 盲评 #1009 契约)", async () => {
    const db = connection([{ id: 11 }]);
    const rebuilt = {
      ...result,
      features: [
        result.features[0],
        { name: "New feature", summary: "Added", scenarios: [{ ...scenario, evidence: [{ path: "lib/brand-new.ts", startLine: 1 }] }] },
      ],
    };
    const { features } = await insertSpecVersion(db, run, rebuilt, { affectedKeys: new Set(["authentication"]), behavioralChangePaths: new Set(["lib/other.ts"]) });
    expect(db.changes.some((change) => change[5] === "New feature")).toBe(false);
    // 折叠只是不落变化行，功能本体仍进不可变快照（append-only，不静默丢内容）
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["New feature"]));
    expect(features.map((feature) => feature.name)).toContain("New feature");
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

describe("detectFeatureCollapses (BM-7 单功能坍缩护栏)", () => {
  const scen = (reference: string, outcome: string, category: "happy" | "edge" | "error" = "happy") => ({ reference, context: "c", action: "a", outcome, category, evidence: [] });
  const feature = (name: string, scenarios: ReturnType<typeof scen>[]) => ({ name, summary: "s", scenarios });

  it("flags the 语义视图批量删除 shape: total grows while one feature loses most scenarios", () => {
    // run 64–66 三轮复现实例：13 场景 → 5（8 条删除、3 条改写），总量被新功能增量掩盖
    const previous = { features: [
      feature("语义视图批量删除", [
        scen("EC-1", "o1"), scen("EC-2", "o2"), scen("EC-3", "o3"), scen("EC-4", "o4"), scen("EC-5", "o5"), scen("EC-6", "o6"),
        scen("ER-1", "o7", "error"), scen("ER-2", "o8", "error"), scen("ER-3", "o9", "error"),
        scen("HP-1", "o10"), scen("HP-2", "o11"), scen("HP-3", "o12"), scen("HP-4", "o13"),
      ]),
      feature("新功能", [scen("HP-1", "new")]),
    ] };
    const current = [
      feature("语义视图批量删除", [scen("EC-1", "o1x", "edge"), scen("EC-2", "o2x", "edge"), scen("HP-1", "o10x", "edge"), scen("HP-2", "o11x", "edge"), scen("HP-3", "o12x", "edge")]),
      feature("新功能", [scen("HP-1", "new"), scen("HP-2", "new2")]),
    ];
    expect(detectFeatureCollapses(previous, current)).toEqual([
      { featureName: "语义视图批量删除", previousScenarios: 13, currentScenarios: 5, removed: 8, rewritten: 5 },
    ]);
  });

  it("does not flag a genuine update that keeps or grows the scenario set", () => {
    // run 64 SQL 编辑器形态：3 条逐字保留 + 改写 + 大量新增（真实 RLS 更新）
    const previous = { features: [feature("SQL 编辑器", [scen("ER-1", "e"), scen("HP-1", "h"), scen("HP-2", "h2", "error")])] };
    const current = [feature("SQL 编辑器", [
      scen("ER-1", "e"), scen("HP-1", "h"), scen("HP-2", "h2", "error"),
      scen("EC-1", "rls", "edge"), scen("EC-2", "rls2", "edge"), scen("EC-3", "rls3", "edge"),
    ])];
    expect(detectFeatureCollapses(previous, current)).toEqual([]);
  });

  it("counts renumbered displacement as rewritten, not removed", () => {
    // 同一行为换了引用号（EC-1 消失但 ER-9 行为等价）→ 位移，不触发删除阈值
    const previous = { features: [feature("A", [scen("EC-1", "gone-ref"), scen("HP-1", "h1"), scen("HP-2", "h2"), scen("HP-3", "h3"), scen("HP-4", "h4")])] };
    const current = [feature("A", [scen("ER-9", "gone-ref"), scen("HP-1", "h1"), scen("HP-2", "h2"), scen("HP-3", "h3"), scen("HP-4", "h4")])];
    expect(detectFeatureCollapses(previous, current)).toEqual([]);
  });

  it("ignores small features and fully removed features", () => {
    const previous = { features: [feature("小功能", [scen("HP-1", "a"), scen("HP-2", "b"), scen("HP-3", "c")]), feature("移除功能", [scen("HP-1", "x")])] };
    const current = [feature("小功能", [scen("HP-1", "a")])];
    expect(detectFeatureCollapses(previous, current)).toEqual([]);
  });

  it("returns empty for a first version", () => {
    expect(detectFeatureCollapses(null, [feature("A", [scen("HP-1", "a")])])).toEqual([]);
  });
});

describe("detectMisplacedScenarios (BM-6 跨域放置校验)", () => {
  const scen = (reference: string, evidence: string[], outcome = "o", category: "happy" | "edge" | "error" = "happy") => ({ reference, context: "c", action: "a", outcome, category, evidence: evidence.map((path) => ({ path, startLine: 1 })) });
  const feature = (name: string, scenarios: ReturnType<typeof scen>[]) => ({ name, summary: "s", scenarios });

  it("flags restore_impact scenarios citing another feature's evidence surface (run 64 REST API 形态)", () => {
    const previous = { features: [
      feature("REST API", [scen("HP-1", ["docs/admin_docs/security/security.mdx"])]),
      feature("仪表盘", [scen("EC-1", ["superset/dashboards/api.py"])]),
    ] };
    const current = [feature("REST API", [
      scen("HP-1", ["docs/admin_docs/security/security.mdx"]),
      scen("HP-2", ["superset/dashboards/api.py"], "恢复影响计数"),
    ])];
    expect(detectMisplacedScenarios(previous, current)).toEqual([
      { featureName: "REST API", scenarioReference: "HP-2", evidencePaths: ["superset/dashboards/api.py"], ownedByKey: "仪表盘", ownedByName: "仪表盘" },
    ]);
  });

  it("passes scenarios that hit the feature's own evidence surface", () => {
    const previous = { features: [feature("数据库连接配置", [scen("HP-1", ["frontend/DatabaseConnectionForm/constants.ts"])])] };
    const current = [feature("数据库连接配置", [scen("HP-2", ["db_engine_specs/athena.py", "frontend/DatabaseConnectionForm/constants.ts"], "Athena 表单")])];
    expect(detectMisplacedScenarios(previous, current)).toEqual([]);
  });

  it("does not flag pure expansion into unowned territory (不可机械判定，归人工核实)", () => {
    const previous = { features: [feature("SQL 编辑器", [scen("HP-1", ["docs/security.mdx"])])] };
    const current = [feature("SQL 编辑器", [scen("EC-1", ["superset/sql/parse.py"], "RLS 生效")])];
    expect(detectMisplacedScenarios(previous, current)).toEqual([]);
  });

  it("skips new keys and returns empty for a first version", () => {
    const previous = { features: [feature("旧功能", [scen("HP-1", ["a.py"])])] };
    expect(detectMisplacedScenarios(previous, [feature("新功能", [scen("HP-1", ["a.py"])])])).toEqual([]);
    expect(detectMisplacedScenarios(null, [feature("新功能", [scen("HP-1", ["a.py"])])])).toEqual([]);
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

describe("output language stamping (072)", () => {
  const executeCalls = (conn: { execute: unknown }) => (conn.execute as unknown as { mock: { calls: Array<[string, unknown[]]> } }).mock.calls;

  it("stamps the run output language onto the version row and English diff summaries", async () => {
    const conn = connection([{ id: 7 }]);
    await insertSpecVersion(conn, { ...run, outputLanguage: "en" }, result);
    const insert = executeCalls(conn).find(([sql]) => String(sql).includes("INSERT INTO spec_versions"));
    expect(insert?.[0]).toContain("output_language");
    expect(insert?.[1]).toContain("en");
    const change = conn.changes.find((parameters) => String(parameters[7]).startsWith("Added feature"));
    expect(change).toBeDefined();
  });

  it("defaults to zh-CN when the run carries no language", async () => {
    const conn = connection([{ id: 7 }]);
    await insertSpecVersion(conn, run, result);
    const insert = executeCalls(conn).find(([sql]) => String(sql).includes("INSERT INTO spec_versions"));
    expect(insert?.[1]).toContain("zh-CN");
    expect(conn.changes.find((parameters) => String(parameters[7]).startsWith("新增功能"))).toBeDefined();
  });

  it("loads the latest version language for switch detection", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([[{ outputLanguage: "en" }]]);
    await expect(loadLatestSpecVersionLanguage(4, execute)).resolves.toBe("en");
    execute.mockResolvedValueOnce([[{ outputLanguage: "zh-CN" }]]);
    await expect(loadLatestSpecVersionLanguage(4, execute)).resolves.toBe("zh-CN");
    execute.mockResolvedValueOnce([[]]);
    await expect(loadLatestSpecVersionLanguage(4, execute)).resolves.toBeNull();
  });
});

describe("BM-11 功能级变体折叠 (foldVariantFeatures)", () => {
  const previous = { name: "Authentication", summary: "OAuth", parentKey: null, source: "generated" as const, scenarios: [{ ...scenario }] };
  const variant = { name: "Authentication flow", summary: "OAuth", parentKey: null, source: "generated" as const, scenarios: [{ ...scenario }] };
  const unrelated = { name: "Billing panel", summary: "Invoices", parentKey: null, source: "generated" as const, scenarios: [{ ...scenario, outcome: "Charge fails" }] };
  const emptyTombstones = { featureKeys: new Set<string>(), scenarioKeys: new Set<string>() };

  it("renames a variant feature back to the previous identity when the old key disappeared (改名型)", () => {
    const { features, folds } = foldVariantFeatures([previous], [unrelated, variant], emptyTombstones);
    expect(folds).toEqual([{ fromName: "Authentication flow", fromKey: "authentication flow", intoName: "Authentication", intoKey: "authentication", mode: "renamed" }]);
    expect(features.map((feature) => feature.name).sort()).toEqual(["Authentication", "Billing panel"]);
  });

  it("merges variant scenarios into the carried feature when the old key survives (并存型)", () => {
    const carried = { ...previous, scenarios: [{ ...scenario }] };
    const fresh = { ...variant, scenarios: [{ ...scenario }, { ...scenario, reference: "HP-2", outcome: "Onboarding" }] };
    const { features, folds } = foldVariantFeatures([carried], [carried, fresh, unrelated], emptyTombstones);
    expect(folds).toEqual([{ fromName: "Authentication flow", fromKey: "authentication flow", intoName: "Authentication", intoKey: "authentication", mode: "merged" }]);
    const merged = features.find((feature) => feature.name === "Authentication");
    expect(merged?.scenarios.map((item) => item.reference)).toEqual(["HP-1", "HP-2"]);
    expect(features.some((feature) => feature.name === "Authentication flow")).toBe(false);
  });

  it("does not fold manual features or tombstoned keys (AGENTS.md 红线)", () => {
    const manualPrevious = { ...previous, source: "manual" as const };
    const { features, folds } = foldVariantFeatures([manualPrevious], [variant], emptyTombstones);
    expect(folds).toEqual([]);
    expect(features.map((feature) => feature.name)).toContain("Authentication flow");
    const tombstoned = foldVariantFeatures([previous], [variant], { featureKeys: new Set(["authentication"]), scenarioKeys: new Set<string>() });
    expect(tombstoned.folds).toEqual([]);
  });
});

describe("insertSpecVersion BM-11 装配折叠集成", () => {
  it("folds a rename variant in full mode: no removed+added pair, feature written under the old name", async () => {
    // 2026-11-19 全模式锚点级 carry（release 284 根治）：全量模式下旧键场景不再整批消失，
    // 改名变体从 renamed 语义转为 merged（旧键经 carried 幸存，变体并入）——终态不变：
    // 无 removed+added 对，功能写在旧名下。
    const db = connection([{ id: 11 }]);
    const rebuilt = {
      ...result,
      features: [
        { name: "Authentication flow", summary: "Old", scenarios: [{ ...scenario }] },
        result.features[1],
      ],
    };
    const { features, featureFolds } = await insertSpecVersion(db, run, rebuilt);
    expect(featureFolds).toHaveLength(1);
    expect(featureFolds[0]).toMatchObject({ mode: "merged", intoName: "Authentication" });
    const removed = db.changes.find((change) => change[2] === "feature" && change[3] === "removed");
    expect(removed?.[5]).not.toBe("Authentication");
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Authentication"]));
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_features"), expect.arrayContaining(["Authentication flow"]));
    expect(features.map((feature) => feature.name)).toEqual(expect.arrayContaining(["Authentication"]));
  });

  it("merges a variant into the carried feature in incremental mode (并存型)", async () => {
    const db = connection([{ id: 11 }]);
    const rebuilt = {
      ...result,
      features: [
        { name: "Authentication flow", summary: "Old", scenarios: [{ ...scenario }, { ...scenario, reference: "HP-2", outcome: "Onboarding" }] },
      ],
    };
    const { features, featureFolds } = await insertSpecVersion(db, run, rebuilt, { affectedKeys: new Set(["unrelated"]) });
    expect(featureFolds).toHaveLength(1);
    expect(featureFolds[0].mode).toBe("merged");
    expect(features.some((feature) => feature.name === "Authentication flow")).toBe(false);
    // 并入的新场景（HP-2）落快照（快照每版全量重写功能场景，carried 的 HP-1 本就随之落库）
    const inserted = (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) => String(call[0]).includes("INSERT INTO spec_scenarios"));
    expect(inserted.some((call: unknown[]) => (call[1] as unknown[])?.includes("HP-2"))).toBe(true);
  });
});

describe("insertSpecVersion 行为来源最终映射 (Task 12)", () => {
  const scenarioInserts = (db: { execute: unknown }) =>
    (db.execute as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) => String(call[0]).includes("INSERT INTO spec_scenarios"));

  it("maps every origin to the id of its final spec_scenarios row", async () => {
    const db = connection([]);
    const input: MergeResult = {
      ...result,
      features: [{ name: "Auth", summary: "OAuth", scenarios: [{ ...scenario, originKeys: ["scenario|k2", "scenario|k1"] }] }],
    };
    const { scenarioIdByLocalKey } = await insertSpecVersion(db, run, input);
    // 同一条最终场景的两个 origin（跨锚点共撑）都映射到同一行；originKeys 不落任何列
    expect(scenarioIdByLocalKey.get("scenario|k1")).toBe(700);
    expect(scenarioIdByLocalKey.get("scenario|k2")).toBe(700);
    expect(scenarioIdByLocalKey.size).toBe(2);
    const inserts = scenarioInserts(db);
    expect(inserts).toHaveLength(1);
    expect(JSON.stringify(inserts[0][1])).not.toContain("originKeys");
    expect(JSON.stringify(inserts[0][1])).not.toContain("scenario|k1");
  });

  it("returns an empty mapping for legacy results without origins", async () => {
    const db = connection([]);
    const { scenarioIdByLocalKey } = await insertSpecVersion(db, run, { ...result, features: [result.features[0]] });
    expect(scenarioIdByLocalKey.size).toBe(0);
  });

  it("keeps origins when a manual scenario replaces the generated one at the same reference", async () => {
    const db = connection([], true);
    const input: MergeResult = {
      ...result,
      features: [{ name: "Manual feature", summary: "AI wording", scenarios: [{ ...scenario, reference: "HP-9", originKeys: ["scenario|k9"] }] }],
    };
    const { scenarioIdByLocalKey, features } = await insertSpecVersion(db, run, input);
    // manual 文本胜出（红线不动），但 origin 必须存活并指向最终那一行
    const manual = features.find((feature) => feature.name === "Manual feature");
    expect(manual?.scenarios.filter((item) => item.reference === "HP-9")).toHaveLength(1);
    expect(scenarioIdByLocalKey.get("scenario|k9")).toBe(700);
  });

  it("unions origins onto the surviving scenario when the BM-11 fold drops a variant duplicate", async () => {
    const db = connection([{ id: 11 }]);
    // carried 的 Authentication（上一版 HP-1：Visitor/Signs in/Dashboard）在增量下原样沿用；
    // AI 变体 Authentication flow 折叠并入，首条与 carried HP-1 行为等价（duplicate），第二条新增
    const input: MergeResult = {
      ...result,
      features: [
        {
          name: "Authentication flow",
          summary: "Old",
          scenarios: [
            { ...scenario, originKeys: ["scenario|variant-dup"] },
            { ...scenario, reference: "HP-2", outcome: "Onboarding", originKeys: ["scenario|variant-new"] },
          ],
        },
      ],
    };
    const { scenarioIdByLocalKey, features, featureFolds } = await insertSpecVersion(db, run, input, { affectedKeys: new Set(["unrelated"]) });
    expect(featureFolds).toHaveLength(1);
    const merged = features.find((feature) => feature.name === "Authentication");
    expect(merged?.scenarios.map((item) => item.reference)).toEqual(["HP-1", "HP-2"]);
    // 被折叠判定丢弃的重复场景，其 origin 并入存活行：variant-dup → carried HP-1 的行 id
    expect(scenarioIdByLocalKey.get("scenario|variant-dup")).toBe(700);
    expect(scenarioIdByLocalKey.get("scenario|variant-new")).toBe(701);
  });

  it("rejects when one origin would map to two final scenario rows", async () => {
    const db = connection([]);
    const input: MergeResult = {
      ...result,
      features: [
        { name: "Feature A", summary: "a", scenarios: [{ ...scenario, originKeys: ["scenario|dup"] }] },
        { name: "Feature B", summary: "b", scenarios: [{ ...scenario, reference: "HP-9", outcome: "Different", originKeys: ["scenario|dup"] }] },
      ],
    };
    await expect(insertSpecVersion(db, run, input)).rejects.toThrow(/scenario\|dup/);
  });
});


describe("visibility conflict activation guard", () => {
  it("rejects a version with conflicting visibility outcomes before insertion", async () => {
    const db = connection([]);
    const conflicting: AnalysisResult = {
      ...result,
      features: [{
        name: "发布入口",
        summary: "匿名访客的发布入口",
        scenarios: [
          { reference: "HP-1", context: "匿名访客访问公开演示产品页", action: "打开页面", outcome: "显示登录后可分析", category: "happy", evidence: [] },
          { reference: "HP-2", context: "匿名访客访问公开演示产品页", action: "查看操作区", outcome: "不显示登录后可分析", category: "edge", evidence: [] },
        ],
      }],
    };

    await expect(insertSpecVersion(db, run, conflicting)).rejects.toThrow("spec_conflict_rejected");
    expect(db.execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO spec_versions"), expect.anything());
  });
});

describe("identity layer in the write path", () => {
  type Mock = ReturnType<typeof vi.fn>;
  const mockOf = (db: { execute: unknown }) => db.execute as Mock;
  const callsOf = (db: { execute: unknown }, fragment: string) => mockOf(db).mock.calls.filter(([sql]) => String(sql).includes(fragment));
  const writesOf = (db: { execute: unknown }) => mockOf(db).mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/i.test(String(sql)));

  /** 这条版本链的过去：功能曾经叫别的名字，所以它的身份不是它现在的名称键。 */
  const renamedPast = {
    previousFeatures: [{ versionId: 11, nameKey: "authentication", identity_key: "sign-in" }, { versionId: 11, nameKey: "legacy", identity_key: "old-legacy" }],
    previousScenarios: [{ versionId: 11, featureIdentityKey: "sign-in", reference: "HP-1", identity_key: '["sign-in","HP-1"]' }],
  };

  /** 在既有替身上补身份相关语句的回数据。 */
  function identityDb(input: {
    previousFeatures?: typeof renamedPast.previousFeatures;
    previousScenarios?: typeof renamedPast.previousScenarios;
    /** 登记表里认得的名称键。写成字符串就是“名称键即身份”；写成一对就是改过名的。 */
    registry?: Array<string | readonly [string, string]>;
    /** 登记表里“名称键即身份”的那些功能。 */
    knownFeatures?: string[];
    /** 被人工下线的功能当时拥有的身份。 */
    switchedOffFeatureIdentities?: string[];
    /** 被人工下线的场景当时的身份键。 */
    switchedOffScenarioIdentities?: string[];
    specScenarios?: Array<Record<string, unknown>>;
  } = {}) {
    const db = connection([{ id: 11 }], false, {}, input.specScenarios);
    const fallback = mockOf(db).getMockImplementation() as (sql: string, parameters: unknown[]) => Promise<unknown>;
    mockOf(db).mockImplementation(async (sql: string, parameters: unknown[] = []) => {
      // 身份查询和规格读取都落在 spec_features 上，靠“查的是 identity_key”把它们分开。
      if (sql.includes("identity_key FROM spec_features WHERE spec_version_id")) return [input.previousFeatures ?? []];
      if (sql.includes("FROM spec_scenarios ss JOIN")) return [input.previousScenarios ?? []];
      if (sql.includes("SELECT identity_key FROM features WHERE")) return [(input.switchedOffFeatureIdentities ?? []).map((identityKey) => ({ identity_key: identityKey }))];
      if (sql.includes("SELECT s.identity_key FROM scenarios")) return [(input.switchedOffScenarioIdentities ?? []).map((identityKey) => ({ identity_key: identityKey }))];
      if (sql.includes("FROM feature_identities")) return [(input.registry ?? input.knownFeatures ?? []).map((entry) => (typeof entry === "string" ? { nameKey: entry, identity_key: entry } : { nameKey: entry[0], identity_key: entry[1] }))];
      if (sql.includes("FROM scenario_identities")) return [[]];
      return fallback(sql, parameters);
    });
    return db;
  }
  const withLegacy = { ...result, features: [...result.features, { name: "Legacy", summary: "Removed", scenarios: [] }] };

  it("writes each row's identity after the existing columns and parameters", async () => {
    const db = identityDb(renamedPast);
    await insertSpecVersion(db, run, withLegacy);

    // 原有的七个参数原样在前，身份接在后面：按下标做的断言不受影响。
    const featureRows = callsOf(db, "INSERT INTO spec_features").map(([, parameters]) => parameters);
    // 最终清单按名称排序（mergeSpecSources），所以 Legacy 排在 New feature 前面。
    expect(featureRows.map((parameters) => parameters.slice(0, 7))).toEqual([
      [99, "authentication", "Authentication", "OAuth", null, "generated", 0],
      [99, "legacy", "Legacy", "Removed", null, "generated", 1],
      [99, "new feature", "New feature", "Added", null, "generated", 2],
    ]);
    expect(featureRows.map((parameters) => parameters.slice(7))).toEqual([["sign-in", null], ["old-legacy", null], ["new feature", null]]);

    const scenarioRows = callsOf(db, "INSERT INTO spec_scenarios").map(([, parameters]) => parameters);
    expect(scenarioRows.map((parameters) => parameters.slice(0, 9))).toEqual([[100, "HP-1", "Visitor", "Signs in", "Onboarding", "happy", null, "generated", "[]"]]);
    expect(scenarioRows.map((parameters) => parameters.slice(9))).toEqual([['["sign-in","HP-1"]']]);
  });

  it("puts the identity of each change row after the existing fifteen parameters", async () => {
    const db = identityDb(renamedPast);
    await insertSpecVersion(db, run, withLegacy);

    // [功能键, 编号, 功能身份, 场景身份]
    expect(db.changes.map((parameters) => [parameters[4], parameters[6], ...parameters.slice(15)])).toEqual(
      expect.arrayContaining([
        ["authentication", "HP-1", "sign-in", '["sign-in","HP-1"]'],
        ["new feature", "", "new feature", null],
      ]),
    );
    expect(db.changes.every((parameters) => parameters.length === 17)).toBe(true);
  });

  it("gives a proven-removed feature the identity it had in the previous version", async () => {
    const db = identityDb({ ...renamedPast, specScenarios: [previousScenario("HP-1", "components/publish.tsx")] });
    // Authentication 的实现文件被删了，证据齐全：这一版里它是确定移除的。
    await insertSpecVersion(db, run, { ...result, features: [{ name: "Legacy", summary: "Removed", scenarios: [] }] }, {
      behavioralChangePaths: new Set(["components/publish.tsx"]),
      changeFiles: [{ path: "components/publish.tsx", status: "removed", patch: "" }],
      fullAnalysis: true,
      coverageComplete: true,
    });

    // 本版里已经没有 Authentication，变化记录的身份只能来自上一版。
    // 功能移除只记一条功能级的变化：[功能键, 编号, 功能身份, 场景身份]。
    expect(db.changes.map((parameters) => [parameters[3], parameters[4], parameters[6], ...parameters.slice(15)])).toEqual([["removed", "authentication", "", "sign-in", null]]);
    // 功能和它的场景一起退休，各记一条关系。登记表本身不动。
    expect(callsOf(db, "INSERT IGNORE INTO feature_identity_links").map(([, parameters]) => parameters)).toEqual([[4, 99, "retire", "sign-in"]]);
    expect(callsOf(db, "INSERT IGNORE INTO scenario_identity_links").map(([, parameters]) => parameters)).toEqual([[4, 99, "retire", '["sign-in","HP-1"]']]);
    expect(callsOf(db, "UPDATE feature_identities")).toEqual([]);
  });

  it("records only what was minted in the registries, after the rows and in the same connection", async () => {
    const db = identityDb(renamedPast);
    await insertSpecVersion(db, run, withLegacy);

    expect(callsOf(db, "INSERT INTO feature_identities").map(([, parameters]) => parameters)).toEqual([[4, "new feature", "New feature", 99]]);
    // 沿用的身份登记表里早就有，不重复插入。
    expect(callsOf(db, "INSERT INTO scenario_identities")).toEqual([]);
    const order = mockOf(db).mock.calls.map(([sql]) => {
      const text = String(sql);
      if (text.includes("identity_key FROM spec_features WHERE spec_version_id")) return "plan";
      if (text.includes("INSERT INTO spec_versions")) return "version";
      if (text.includes("INSERT INTO feature_identities")) return "registry";
      return "other";
    });
    expect(order.indexOf("plan")).toBeLessThan(order.indexOf("version"));
    expect(order.indexOf("version")).toBeLessThan(order.indexOf("registry"));
  });

  it("continues identities the registries never saw when the previous version carries them", async () => {
    // 部署之后、回填之前的那几次发布：登记表是空的，上一版已经有身份。沿用上一版的，不按名称另造。
    const db = identityDb({ previousFeatures: renamedPast.previousFeatures, previousScenarios: renamedPast.previousScenarios });
    await insertSpecVersion(db, run, withLegacy);
    expect(callsOf(db, "INSERT INTO spec_features").map(([, parameters]) => parameters.slice(7, 8))).toEqual([["sign-in"], ["old-legacy"], ["new feature"]]);
  });

  it("mints from the name key when neither the previous version nor the registries know anything", async () => {
    const db = identityDb();
    const { identities } = await insertSpecVersion(db, run, withLegacy);

    expect(callsOf(db, "INSERT INTO spec_features").map(([, parameters]) => parameters.slice(7, 8))).toEqual([["authentication"], ["legacy"], ["new feature"]]);
    expect(identities?.features.get("authentication")).toMatchObject({ identityKey: "authentication", origin: "minted" });
  });

  it("leaves the identity columns null and stays away from the registries when the layer is switched off", async () => {
    vi.stubEnv("SPEC_IDENTITY_LAYER", "false");
    try {
      const db = identityDb(renamedPast);
      const { identities } = await insertSpecVersion(db, run, withLegacy);

      expect(callsOf(db, "INSERT INTO spec_features").map(([, parameters]) => parameters.slice(7))).toEqual([[null, null], [null, null], [null, null]]);
      expect(db.changes.every((parameters) => parameters.slice(15).every((value) => value === null))).toBe(true);
      expect(mockOf(db).mock.calls.some(([sql]) => /(?:FROM|INTO|UPDATE) (?:feature_identit|scenario_identit)/.test(String(sql)))).toBe(false);
      expect(identities).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a first version as the baseline and gives it identities minted from the name keys", async () => {
    // 没有上一版：身份全部新建，登记表的查询落到替身的默认回答上，也就是空的。
    const db = connection([]);
    const { baseline, identities } = await insertSpecVersion(db, run, withLegacy);

    expect(baseline).toBe(true);
    expect(identities?.minted.features.map((feature) => feature.identityKey)).toEqual(["authentication", "legacy", "new feature"]);
  });

  it("refuses the version before writing anything when identities cannot be assigned", async () => {
    // 上一版说 authentication 的身份是 sign-in，登记表说是 authentication。两边说法不一，不猜。
    const db = identityDb({ previousFeatures: renamedPast.previousFeatures, knownFeatures: ["authentication"] });

    await expect(insertSpecVersion(db, run, withLegacy)).rejects.toMatchObject({ code: "identity_registry_conflict" });
    expect(writesOf(db)).toEqual([]);
  });

  it("blocks by identity a renamed feature whose identity a person switched off, under any name it goes by", async () => {
    // 用户下线过一个人工功能，它当时的身份是 f1。模型这次换了个名字“乙”输出同一个功能：
    // 按名称键查墓碑查不到，按身份查得到。
    const renamedOutput = { ...withLegacy, features: [...withLegacy.features, { name: "乙", summary: "换个名字的同一个功能", scenarios: [] }] };
    const db = identityDb({ ...renamedPast, registry: [["乙", "f1"]], switchedOffFeatureIdentities: ["f1"] });

    const { features } = await insertSpecVersion(db, run, renamedOutput);

    expect(features.map((feature) => feature.name)).not.toContain("乙");
  });

  it("blocks by identity a scenario of a renamed feature that a person switched off, and keeps the feature's other scenarios", async () => {
    // 用户只下线过那个功能的 HP-1。模型换个名字重新输出这个功能时，HP-1 不该回来，HP-2 照常保留。
    const renamedOutput = {
      ...withLegacy,
      features: [...withLegacy.features, { name: "乙", summary: "换个名字的同一个功能", scenarios: [{ ...scenario, reference: "HP-1" }, { ...scenario, reference: "HP-2" }] }],
    };
    const db = identityDb({ ...renamedPast, registry: [["乙", "f1"]], switchedOffScenarioIdentities: [scenarioIdentityKey("f1", "HP-1")] });

    const { features } = await insertSpecVersion(db, run, renamedOutput);

    expect(features.find((feature) => feature.name === "乙")?.scenarios.map((item) => item.reference)).toEqual(["HP-2"]);
  });

  it("does not block it when the identity layer is switched off, because only names are checked then", async () => {
    vi.stubEnv("SPEC_IDENTITY_LAYER", "false");
    try {
      const renamedOutput = { ...withLegacy, features: [...withLegacy.features, { name: "乙", summary: "换个名字的同一个功能", scenarios: [] }] };
      const db = identityDb({ ...renamedPast, registry: [["乙", "f1"]], switchedOffFeatureIdentities: ["f1"] });

      const { features } = await insertSpecVersion(db, run, renamedOutput);

      expect(features.map((feature) => feature.name)).toContain("乙");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads which identities were switched off by hand, next to the names it already read", async () => {
    const db = identityDb({ ...renamedPast, registry: [["乙", "f1"]], switchedOffFeatureIdentities: ["f1"] });
    await insertSpecVersion(db, run, withLegacy);

    const identityQueries = mockOf(db).mock.calls.filter(([sql]) => String(sql).includes("identity_key IS NOT NULL"));
    // 人工下线的功能一条、人工下线的场景一条，都只读。
    expect(identityQueries.map(([sql]) => [String(sql).includes("FROM features WHERE") ? "features" : "scenarios", String(sql).startsWith("SELECT")])).toEqual([["features", true], ["scenarios", true]]);
  });

  it("returns the plan so the workbench rows can carry the same identities", async () => {
    const db = identityDb(renamedPast);
    const { identities, baseline } = await insertSpecVersion(db, run, withLegacy);
    // 有上一版，所以这一版不是基线。
    expect(baseline).toBe(false);

    expect(identities?.features.get("authentication")).toMatchObject({ identityKey: "sign-in", origin: "continued" });
    expect(identities?.features.get("authentication")?.scenarios.get("HP-1")?.identityKey).toBe('["sign-in","HP-1"]');
    expect(identities?.features.get("new feature")).toMatchObject({ identityKey: "new feature", origin: "minted" });
  });
});

describe("墓碑按身份加宽 (widenTombstonesByIdentity)", () => {
  const loaded = {
    featureKeys: new Set(["甲"]),
    scenarioKeys: new Set([specScenarioKey("甲", "HP-1")]),
    featureIdentities: ["f1"],
    scenarioIdentities: [scenarioIdentityKey("f1", "HP-1"), "不是我们的编码"],
  };
  /** 每个名称键现在解析到哪个身份：甲和乙是同一个功能（改过名），丙是另一个。 */
  const names: Array<readonly [string, string]> = [["甲", "f1"], ["乙", "f1"], ["丙", "f2"]];

  it("adds every name that resolves to a switched-off identity, for features and for scenarios", () => {
    expect(widenTombstonesByIdentity(loaded, names)).toEqual({
      featureKeys: new Set(["甲", "乙"]),
      scenarioKeys: new Set([specScenarioKey("甲", "HP-1"), specScenarioKey("乙", "HP-1")]),
    });
  });

  it("does not reach a different feature that merely shares a name prefix or a reference", () => {
    const widened = widenTombstonesByIdentity(loaded, names);
    expect(widened.featureKeys.has("丙")).toBe(false);
    expect(widened.scenarioKeys.has(specScenarioKey("丙", "HP-1"))).toBe(false);
    expect(widened.scenarioKeys.has(specScenarioKey("乙", "HP-2"))).toBe(false);
  });

  it("returns the name keys as they are when nothing was recorded by identity", () => {
    const plain = { featureKeys: new Set(["甲"]), scenarioKeys: new Set<string>(), featureIdentities: [], scenarioIdentities: [] };
    expect(widenTombstonesByIdentity(plain, names)).toEqual({ featureKeys: new Set(["甲"]), scenarioKeys: new Set() });
  });

  it("never narrows: a name key that was blocked stays blocked even if it now resolves elsewhere", () => {
    const widened = widenTombstonesByIdentity(loaded, [["甲", "f9"]]);
    expect(widened.featureKeys.has("甲")).toBe(true);
    expect(widened.scenarioKeys.has(specScenarioKey("甲", "HP-1"))).toBe(true);
    expect(widened.featureKeys.has("乙")).toBe(false);
  });
});

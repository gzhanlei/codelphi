import { describe, expect, it } from "vitest";
import { canonicalizeScenarios, compactSearchProjection, paginateById, projectFileRisks, type CanonicalScenarioInput } from "../lib/mcp/projections";
import { loadLedgerFreshness, resetFreshnessCacheForTests } from "../lib/mcp/freshness";

function scenario(id: number, reference = "EC-1", path = "lib/a.ts"): CanonicalScenarioInput {
  return { id, featureName: "功能", reference, specReference: "v230", evidencePaths: [path] };
}

describe("canonicalizeScenarios", () => {
  it("collapses only duplicate rows with the same in-version identity and retains every source", () => {
    const result = canonicalizeScenarios([scenario(1), scenario(2), scenario(3, "EC-2")]);

    expect(result.rawCount).toBe(3);
    expect(result.canonicalCount).toBe(2);
    expect(result.collapsedCount).toBe(1);
    expect(result.scenarios[0]).toMatchObject({
      scenarioIdentity: "EC-1",
      rawRecordIds: [1, 2],
      specReferences: ["v230"],
      identityStatus: "proven",
      identityScope: "v230",
    });
    expect(result.scenarios[1]).toMatchObject({ scenarioIdentity: "EC-2", rawRecordIds: [3], identityStatus: "proven" });
    expect(result.rawCount).toBe(result.canonicalCount + result.collapsedCount);
  });

  it("leaves records unresolved when version or evidence differs", () => {
    const result = canonicalizeScenarios([
      scenario(1, "EC-1", "lib/a.ts"),
      { ...scenario(2), specReference: "v231" },
      scenario(3, "EC-1", "lib/b.ts"),
    ]);

    expect(result.canonicalCount).toBe(3);
    expect(result.collapsedCount).toBe(0);
    expect(result.scenarios.every((item) => item.identityStatus === "unresolved" && item.identityScope === "unresolved")).toBe(true);
  });

  it("uses collision-safe keys for feature names containing pipes", () => {
    const result = canonicalizeScenarios([
      { ...scenario(1), featureName: "功能|子功能" },
      { ...scenario(2), featureName: "功能|子功能" },
    ]);
    expect(result.canonicalCount).toBe(1);
    expect(result.collapsedCount).toBe(1);
    expect(result.scenarios[0]).toMatchObject({ identityStatus: "proven", identityScope: "v230", rawRecordIds: [1, 2] });
  });
});

describe("paginateById", () => {
  it("uses stable id ordering and preserves compatible changes field", () => {
    const result = paginateById([{ id: 3 }, { id: 1 }, { id: 2 }], { offset: 1, limit: 1 });
    expect(result.changes.map((item) => item.id)).toEqual([2]);
    expect(result).toMatchObject({ offset: 1, limit: 1, total: 3, hasMore: true });
  });

  it("rejects offset without limit and oversized limits", () => {
    expect(() => paginateById([], { offset: 2 })).toThrow("offset requires limit");
    expect(() => paginateById([], { limit: 101 })).toThrow("limit must be between 1 and 100");
  });
});

describe("projectFileRisks", () => {
  it("returns a stable bounded risk list and distinguishes file from scenario coverage", () => {
    const result = projectFileRisks({
      requestedPaths: ["lib/a.ts", "lib/missing.ts"],
      snapshotSha: "abc",
      rows: Array.from({ length: 12 }, (_, index) => ({
        stableKey: `功能${index}`,
        source: index === 0 ? "manual" : "generated",
        changeIds: [index + 1],
        evidencePaths: [index === 0 ? "lib/other.ts" : "lib/a.ts"],
      })),
    });

    expect(result.risks).toHaveLength(10);
    expect(result.risks[0]).toMatchObject({ rank: 1, severity: "high", coverageType: "scenario" });
    expect(result.coveredPaths).toEqual(["lib/a.ts"]);
    expect(result.uncoveredPaths).toEqual(["lib/missing.ts"]);
    expect(result.totalCount).toBe(12);
    expect(result.hasMore).toBe(true);
  });
});

describe("compactSearchProjection (MCP 搜索输出压缩)", () => {
  const fullScenario = (id: number, reference: string) => ({
    id,
    featureId: 1,
    featureName: "统一登录",
    featureStableKey: "统一登录",
    reference,
    context: "c".repeat(200),
    action: "a".repeat(200),
    outcome: "o".repeat(200),
    evidence: [{ path: "lib/auth.ts", startLine: 10, endLine: 20, url: "https://github.com/x/blob/y/lib/auth.ts#L10", note: "n" }],
  });
  const fullHistory = (releaseId: number) => ({
    source: "release" as const,
    releaseId,
    sha: `sha-${releaseId}`,
    committedAt: new Date("2026-11-18T00:00:00Z"),
    specChangeId: releaseId,
    kind: "added",
    featureName: "统一登录",
    scenarioReference: "HP-1",
    summary: "s",
    before: { reference: "HP-1", category: "happy" as const, context: "b", action: "b", outcome: "b", evidence: [] },
    after: { reference: "HP-1", category: "happy" as const, context: "a", action: "a", outcome: "a", evidence: [] },
  });

  it("caps top-K, strips scenario full text and history before/after bodies, keeps anchors", () => {
    const result = compactSearchProjection({
      features: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `功能${index}`, summary: "s", stableKey: `功能${index}` })),
      scenarios: Array.from({ length: 14 }, (_, index) => fullScenario(index + 1, `HP-${index + 1}`)),
      history: Array.from({ length: 12 }, (_, index) => fullHistory(index + 1)),
    });
    expect(result.features).toHaveLength(8);
    expect(result.scenarios).toHaveLength(10);
    expect(result.history).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.scenarios[0]).toEqual({
      id: 1,
      featureName: "统一登录",
      featureStableKey: "统一登录",
      reference: "HP-1",
      evidence: [{ path: "lib/auth.ts", startLine: 10 }],
    });
    expect(result.history[0]).toEqual(expect.objectContaining({ source: "release", releaseId: 1, sha: "sha-1" }));
    expect(result.history[0]).not.toHaveProperty("before");
    expect(result.history[0]).not.toHaveProperty("after");
    expect(result.detailHint).toContain("get_scenario");
  });

  it("keeps ranked order, omits truncated flag within limits, and still returns the hint for empty results", () => {
    const ranked = compactSearchProjection({
      features: [{ id: 2, name: "B", summary: "s", stableKey: "b" }, { id: 1, name: "A", summary: "s", stableKey: "a" }],
      scenarios: [fullScenario(9, "HP-9")],
      history: [],
    });
    expect(ranked.features.map((feature) => feature.id)).toEqual([2, 1]); // 排序在 spec-search 已完成，这里不重排
    expect(ranked.scenarios).toHaveLength(1);
    expect(ranked.truncated).toBeUndefined();
    expect(ranked.detailHint).toContain("get_release");
    expect(compactSearchProjection({ features: [], scenarios: [], history: [] }).features).toEqual([]);
  });
});

describe("compactSearchProjection stale 门", () => {
  const baseScenario = {
    id: 1,
    featureId: 1,
    featureName: "统一登录",
    featureStableKey: "统一登录",
    reference: "HP-1",
    context: "c",
    action: "a",
    outcome: "o",
    evidence: [{ path: "lib/auth.ts", startLine: 10 }],
  };

  it("marks scenarios stale when their evidence paths intersect the behavioral change set", () => {
    const result = compactSearchProjection(
      { features: [], scenarios: [baseScenario, { ...baseScenario, id: 2, reference: "HP-2", evidence: [{ path: "lib/other.ts" }] }], history: [] },
      { freshness: { available: true, analyzedSha: "a", comparedAgainst: "main", changedBehavioralFiles: 1, changedFiles: 2 }, staleEvidencePaths: new Set(["lib/auth.ts"]) },
    );
    expect(result.freshness).toMatchObject({ available: true, analyzedSha: "a" });
    expect(result.scenarios[0].stale).toBe(true);
    expect(result.scenarios[1].stale).toBeUndefined();
  });

  it("omits stale flags and freshness when the comparison is unavailable (诚实降级)", () => {
    const result = compactSearchProjection(
      { features: [], scenarios: [baseScenario], history: [] },
      { freshness: { available: false, reason: "rate_limited" }, staleEvidencePaths: new Set(["lib/auth.ts"]) },
    );
    expect(result.freshness).toMatchObject({ available: false });
    expect(result.scenarios[0].stale).toBeUndefined();
  });
});

describe("loadLedgerFreshness (stale 门数据源)", () => {
  it("computes behavioral change set from the compare window and caches per repository+sha", async () => {
    resetFreshnessCacheForTests();
    let compareCalls = 0;
    const execute = (async (sql: string) => {
      if (String(sql).includes("FROM releases rel")) return [[{ repositoryId: 8, owner: "gzhanlei", name: "codelphi", connectionId: 1, provider: "github", analyzedSha: "aaa" }]];
      if (String(sql).includes("FROM products WHERE id")) return [[{ id: 9, slug: "codelphi", name: "CoDelphi", organizationId: 2 }]];
      return [[]];
    }) as never;
    const fakeChange = { files: [{ path: "lib/ai.ts", patch: "@@ -1,2 +1,3 @@\n+x" }, { path: "README.md", patch: "@@ -1,1 +1,2 @@\n+doc" }] };
    const data = await loadLedgerFreshness(9, execute, {
      getRepository: async () => ({ defaultBranch: "main" }),
      getChangeContext: async () => { compareCalls += 1; return fakeChange; },
    });
    expect(data.block).toMatchObject({ available: true, analyzedSha: "aaa", comparedAgainst: "main", changedBehavioralFiles: 1, changedFiles: 2 });
    expect(data.changedBehavioralPaths.has("lib/ai.ts")).toBe(true);
    expect(data.changedBehavioralPaths.has("README.md")).toBe(false); // 文档变更不计入行为变更集
    await loadLedgerFreshness(9, execute, { getRepository: async () => ({ defaultBranch: "main" }), getChangeContext: async () => { compareCalls += 1; return fakeChange; } });
    expect(compareCalls).toBe(1); // 缓存命中，GitHub compare 不重跑（本地 release 查询廉价，不缓存）
  });

  it("degrades to available=false when the comparison fails (never fakes freshness)", async () => {
    resetFreshnessCacheForTests();
    const execute = (async (sql: string) => {
      if (String(sql).includes("FROM releases rel")) return [[{ repositoryId: 8, owner: "gzhanlei", name: "codelphi", connectionId: 1, provider: "github", analyzedSha: "aaa" }]];
      if (String(sql).includes("FROM products WHERE id")) return [[{ id: 9, slug: "codelphi", name: "CoDelphi", organizationId: 2 }]];
      return [[]];
    }) as never;
    const data = await loadLedgerFreshness(9, execute, {
      getRepository: async () => ({ defaultBranch: "main" }),
      getChangeContext: async () => { throw new Error("rate limited"); },
    });
    expect(data.block).toMatchObject({ available: false, reason: "rate limited" });
    expect(data.changedBehavioralPaths.size).toBe(0);
  });

  it("returns no_release when the product has no releases", async () => {
    resetFreshnessCacheForTests();
    const execute = (async () => [[]]) as never;
    const data = await loadLedgerFreshness(9, execute);
    expect(data.block).toEqual({ available: false, reason: "no_release" });
  });
});

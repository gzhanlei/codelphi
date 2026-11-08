import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProductDetails } from "../lib/product-details";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }), defaultExecute: execute }));

const product = { id: 4, slug: "radar", name: "Radar", description: "Product knowledge", descriptionSource: "generated", descriptionEvidence: JSON.stringify([{ path: "lib/analysis.ts", startLine: 185 }]) };

describe("product details", () => {
  beforeEach(() => execute.mockReset());

  it("returns null for an unknown product", async () => {
    execute.mockResolvedValue([[]]);
    await expect(getProductDetails("missing", 7)).resolves.toBeNull();
  });

  it("keeps provider identity and supports empty product history", async () => {
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      return [[]];
    });
    const details = await getProductDetails("radar", 7);
    expect(details?.repository).toEqual({ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" });
    expect(details?.features).toEqual([]);
    expect(details?.releases).toEqual([]);
    expect(execute.mock.calls[0][1]).toEqual(["radar", 7]);
    expect(execute.mock.calls[0][0]).toContain("organization_id = ?");
  });

  it("loads feature, release and parsed behavior evidence without an organization filter", async () => {
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null }]];
      if (sql.includes("FROM features")) return [[{ id: 5, name: "Login", summary: "OAuth", parentId: null, source: "generated" }]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      if (sql.includes("FROM scenarios")) return [[{ id: 7, featureId: 5, reference: "happy", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      if (sql.includes("FROM spec_changes")) return [[{ id: 8, releaseId: 6, kind: "modified", entityType: "scenario", featureName: "Login", scenarioReference: "happy", summary: "Changed", beforeJson: "{\"old\":true}", afterJson: "{\"new\":true}" }]];
      if (sql.includes("r.hit_type AS hitType")) return [[]];
      if (sql.includes("AS changeId")) return [[]];
      if (sql.includes("COALESCE(ss.reference")) return [[]];
      if (sql.includes("FROM changes")) return [[{ id: 9, releaseId: 6, featureName: "Login", kind: "modified", description: "Changed", userImpact: "Impact", evidence: [] }]];
      if (sql.includes("AS baseVersionId")) return [[{ versionId: 3, baseVersionId: 2 }]];
      if (sql.includes("FROM spec_features WHERE spec_version_id IN")) return [[{ id: 5, versionId: 3, name: "Login", summary: "OAuth", parentKey: null, source: "generated" }]];
      if (sql.includes("FROM spec_scenarios ss JOIN")) return [[{ versionId: 3, featureId: 5, reference: "happy", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      if (sql.includes("FROM release_files WHERE behavioral_change")) return [[{ release_id: 6, path: "lib/analysis.ts" }]];
      if (!sql) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const details = await getProductDetails("radar");
    expect(details?.scenarios).toHaveLength(1);
    expect(details?.changes).toHaveLength(1);
    expect(details?.behaviorChanges[0]).toMatchObject({ before: { old: true }, after: { new: true } });
    expect(details?.foldedChanges).toEqual([]);
    expect(details).not.toHaveProperty("architecture");
    expect(details?.latestRun?.status).toBe("succeeded");
    expect(details?.product.descriptionEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
    expect(execute.mock.calls[0][1]).toEqual(["radar"]);
    expect(execute.mock.calls[0][0]).not.toContain("organization_id = ?");
  });

  it("recomputes wording-folded differences from the base and current spec versions", async () => {
    // 上一版（id 2）只在措辞上不同：行为等价 → 不落 spec_changes，但折叠明细可见。
    const baseFeatures = [{ id: 15, versionId: 2, name: "登录", summary: "登录并保持会话", parentKey: null, source: "generated" }];
    const baseScenarios = [{ versionId: 2, featureId: 15, reference: "HP-1", context: "提交的任务不属于该产品", action: "查询任务详情", outcome: "返回 404", category: "error", source: "generated", evidence: [] }];
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null }]];
      if (sql.includes("FROM features")) return [[]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      if (sql.includes("r.hit_type AS hitType")) return [[]];
      if (sql.includes("AS changeId")) return [[]];
      if (sql.includes("COALESCE(ss.reference")) return [[]];
      if (sql.includes("FROM changes")) return [[]];
      if (sql.includes("FROM spec_changes")) return [[]];
      if (sql.includes("AS baseVersionId")) return [[{ versionId: 3, baseVersionId: 2 }]];
      if (sql.includes("FROM spec_features WHERE spec_version_id IN")) return [[...baseFeatures, { id: 5, versionId: 3, name: "登录", summary: "登录并保持会话", parentKey: null, source: "generated" }]];
      if (sql.includes("FROM spec_scenarios ss JOIN")) return [[...baseScenarios, { versionId: 3, featureId: 5, reference: "HP-1", context: "提交的任务不属于当前产品", action: "查询任务详情", outcome: "返回 404。", category: "error", source: "generated", evidence: [] }]];
      if (sql.includes("FROM release_files WHERE behavioral_change")) return [[]];
      if (!sql) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const details = await getProductDetails("radar");
    expect(details?.foldedChanges).toHaveLength(1);
    expect(details?.foldedChanges[0]).toMatchObject({ reason: "wording", featureName: "登录", scenarioReference: "HP-1", releaseId: 6 });
    expect(String(details?.foldedChanges[0].summary)).toContain("仅措辞差异");
  });

  it("decorates evidence with blob URLs when the analyzed revision is known", async () => {
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null, afterSha: sha }]];
      if (sql.includes("FROM features")) return [[{ id: 5, name: "Login", summary: "OAuth", parentId: null, source: "generated" }]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha, url: `https://github.com/commit/${sha}`, committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      if (sql.includes("FROM scenarios")) return [[{ id: 7, featureId: 5, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: JSON.stringify([{ path: "lib/analysis.ts", startLine: 24 }]) }]];
      if (sql.includes("FROM spec_changes")) return [[{ id: 8, releaseId: 6, kind: "modified", entityType: "scenario", featureName: "Login", scenarioReference: "HP-1", summary: "Changed", beforeJson: JSON.stringify({ old: true, evidence: [{ path: "lib/analysis.ts", startLine: 30 }] }), afterJson: JSON.stringify({ new: true, evidence: [{ path: "lib/analysis.ts", startLine: 40 }] }) }]];
      if (sql.includes("r.hit_type AS hitType")) return [[]];
      if (sql.includes("AS changeId")) return [[]];
      if (sql.includes("COALESCE(ss.reference")) return [[]];
      if (sql.includes("FROM changes")) return [[{ id: 9, releaseId: 6, featureName: "Login", kind: "modified", description: "Changed", userImpact: "Impact", evidence: [{ path: "lib/analysis.ts", startLine: 50 }] }]];
      if (sql.includes("AS baseVersionId")) return [[{ versionId: 3, baseVersionId: null }]];
      if (sql.includes("FROM spec_features WHERE spec_version_id IN")) return [[{ id: 5, versionId: 3, name: "Login", summary: "OAuth", parentKey: null, source: "generated" }]];
      if (sql.includes("FROM spec_scenarios ss JOIN")) return [[{ versionId: 3, featureId: 5, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      if (sql.includes("FROM release_files WHERE behavioral_change")) return [[{ release_id: 6, path: "lib/analysis.ts" }]];
      if (!sql) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const details = await getProductDetails("radar");
    const blob = (line: number) => `https://github.com/gzhanlei/codelphi/blob/${sha}/lib/analysis.ts#L${line}`;
    expect(details?.product.descriptionEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185, url: blob(185) }]);
    expect(details?.scenarios[0].evidence).toEqual([{ path: "lib/analysis.ts", startLine: 24, url: blob(24) }]);
    expect(details?.changes[0].evidence).toEqual([{ path: "lib/analysis.ts", startLine: 50, url: blob(50) }]);
    expect(details?.behaviorChanges[0].before).toMatchObject({ evidence: [{ path: "lib/analysis.ts", startLine: 30, url: blob(30) }] });
    expect(details?.behaviorChanges[0].after).toMatchObject({ evidence: [{ path: "lib/analysis.ts", startLine: 40, url: blob(40) }] });
  });

  it("leaves evidence untouched when the latest run has no revision", async () => {
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "queued", errorMessage: null, afterSha: null }]];
      if (sql.includes("FROM features")) return [[]];
      if (sql.includes("FROM releases")) return [[]];
      return [[]];
    });
    const details = await getProductDetails("radar");
    expect(details?.product.descriptionEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
  });
});

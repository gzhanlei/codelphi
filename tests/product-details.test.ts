import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProductDetails, loadReleasePage } from "../lib/product-details";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }), defaultExecute: execute }));
const { loadFeatureFlowErrors, loadFeatureFlowGraphs } = vi.hoisted(() => ({ loadFeatureFlowErrors: vi.fn(), loadFeatureFlowGraphs: vi.fn() }));
vi.mock("../lib/feature-flow-store", () => ({ loadFeatureFlowErrors, loadFeatureFlowGraphs }));

const product = { id: 4, slug: "radar", name: "Radar", description: "Product knowledge", descriptionSource: "generated", descriptionEvidence: JSON.stringify([{ path: "lib/analysis.ts", startLine: 185 }]), outputLanguage: "en" };

describe("product details", () => {
  beforeEach(() => {
    execute.mockReset();
    loadFeatureFlowGraphs.mockReset().mockResolvedValue(new Map());
    loadFeatureFlowErrors.mockReset().mockResolvedValue(new Map());
  });

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

  it("carries a version's provenance into the release list: present for a client-analysed version, null for a hosted one", async () => {
    const row = { id: 6, title: "v1", summary: "Release", sha: "abc", url: "", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 };
    const rows = [
      { ...row, id: 7, provenance: JSON.stringify({ server: { executor: "client", specVersionId: 4 }, client: { model: "tenant-model", clientVersion: "0.1.0" } }) },
      { ...row, provenance: null },
    ];
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM releases")) return [rows];
      return [[]];
    });
    const details = await getProductDetails("radar", 7);
    // 查询要连上规格版本，才拿得到来源信息。
    const releaseQuery = execute.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("FROM releases"))!;
    expect(releaseQuery).toContain("LEFT JOIN spec_versions sv ON sv.id = r.spec_version_id");
    expect(releaseQuery).toContain("sv.provenance_json AS provenance");
    expect(details?.releases.map((release) => release.provenance)).toEqual([
      { executor: "client", model: "tenant-model", clientVersion: "0.1.0" },
      null,
    ]);
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
      if (sql.includes("FROM release_reviewed_items")) return [[{ id: 10, releaseId: 6, featureName: "Login", description: "Reviewed internals", evidence: [] }]];
      if (sql.includes("AS baseVersionId")) return [[{ versionId: 3, baseVersionId: 2 }]];
      if (sql.includes("FROM spec_features WHERE spec_version_id IN")) return [[{ id: 5, versionId: 3, name: "Login", summary: "OAuth", parentKey: null, source: "generated" }]];
      if (sql.includes("FROM spec_scenarios ss JOIN")) return [[{ versionId: 3, featureId: 5, reference: "happy", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      if (sql.includes("FROM release_files WHERE behavioral_change")) return [[{ release_id: 6, path: "lib/analysis.ts" }]];
      if (sql.includes("FROM analysis_coverage_receipts")) return [[{ specVersionId: 3, implFilesAssembled: 1, implFilesTotal: 2, implBytesAssembled: 1000, implBytesTotal: 4000, coverageRatio: 0.25, partitionsUsed: 1, partitionsCapped: 0 }]];
      if (sql.includes("analysis_completeness_ledger")) return [[{ runId: 9, sourceCoverage: "partial", behavioralEnumeration: "complete", extractionCompletion: "complete", evidenceIntegrity: "complete", mergeIntegrity: "partial", verification: "not_applicable", overall: "partial", details: { sourceCoverage: { state: "partial" }, behavioralEnumeration: { state: "complete" }, extractionCompletion: { state: "complete" }, evidenceIntegrity: { state: "complete" }, mergeIntegrity: { state: "partial" }, verification: { state: "not_applicable" }, overall: "partial" } }]];
      if (sql.includes("FROM release_reviewed_items")) return [[]];
      if (!sql) return [[]];
      if (sql.includes("FROM release_notes WHERE product_id")) return [[{ id: 1, releaseId: 10, status: "published", headline: null }]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const featureGraph = { entryNodeIds: [], nodes: [], edges: [], excludedScenarios: [] };
    loadFeatureFlowGraphs.mockResolvedValue(new Map([["Login", featureGraph]]));
    const details = await getProductDetails("radar");
    expect(details?.scenarios).toHaveLength(1);
    expect(details?.featureFlows.get("Login")).toEqual(featureGraph);
    expect(loadFeatureFlowGraphs).toHaveBeenCalledWith(expect.anything(), 3, [expect.objectContaining({ name: "Login" })]);
    expect(details?.changes).toHaveLength(1);
    expect(details?.reviewedChanges).toEqual([{ id: 10, releaseId: 6, featureName: "Login", kind: "reviewed", description: "Reviewed internals", userImpact: "", evidence: [] }]);
    expect(details?.behaviorChanges[0]).toMatchObject({ before: { old: true }, after: { new: true } });
    expect(details?.foldedChanges).toEqual([]);
    expect(details).not.toHaveProperty("architecture");
    expect(details?.latestRun?.status).toBe("succeeded");
    // R1 账本随详情返回（六维度 + overall），供规格页完整性行渲染
    expect(details?.completeness).toMatchObject({ overall: "partial", sourceCoverage: "partial", mergeIntegrity: "partial" });
    expect(details?.product.descriptionEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
    expect(details?.product.outputLanguage).toBe("en");
    expect(execute.mock.calls[0][0]).toContain("output_language AS outputLanguage");
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
      if (sql.includes("FROM analysis_coverage_receipts")) return [[{ specVersionId: 3, implFilesAssembled: 1, implFilesTotal: 2, implBytesAssembled: 1000, implBytesTotal: 4000, coverageRatio: 0.25, partitionsUsed: 1, partitionsCapped: 0 }]];
      if (sql.includes("analysis_completeness_ledger")) return [[{ runId: 9, sourceCoverage: "partial", behavioralEnumeration: "complete", extractionCompletion: "complete", evidenceIntegrity: "complete", mergeIntegrity: "partial", verification: "not_applicable", overall: "partial", details: { sourceCoverage: { state: "partial" }, behavioralEnumeration: { state: "complete" }, extractionCompletion: { state: "complete" }, evidenceIntegrity: { state: "complete" }, mergeIntegrity: { state: "partial" }, verification: { state: "not_applicable" }, overall: "partial" } }]];
      if (sql.includes("FROM release_reviewed_items")) return [[]];
      if (!sql) return [[]];
      if (sql.includes("FROM release_notes WHERE product_id")) return [[{ id: 1, releaseId: 10, status: "published", headline: null }]];
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
      if (sql.includes("FROM analysis_coverage_receipts")) return [[{ specVersionId: 3, implFilesAssembled: 1, implFilesTotal: 2, implBytesAssembled: 1000, implBytesTotal: 4000, coverageRatio: 0.25, partitionsUsed: 1, partitionsCapped: 0 }]];
      if (sql.includes("analysis_completeness_ledger")) return [[{ runId: 9, sourceCoverage: "partial", behavioralEnumeration: "complete", extractionCompletion: "complete", evidenceIntegrity: "complete", mergeIntegrity: "partial", verification: "not_applicable", overall: "partial", details: { sourceCoverage: { state: "partial" }, behavioralEnumeration: { state: "complete" }, extractionCompletion: { state: "complete" }, evidenceIntegrity: { state: "complete" }, mergeIntegrity: { state: "partial" }, verification: { state: "not_applicable" }, overall: "partial" } }]];
      if (sql.includes("FROM release_reviewed_items")) return [[]];
      if (!sql) return [[]];
      if (sql.includes("FROM release_notes WHERE product_id")) return [[{ id: 1, releaseId: 10, status: "published", headline: null }]];
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
    expect(details?.product.outputLanguage).toBe("en");
    expect(execute.mock.calls[0][0]).toContain("output_language AS outputLanguage");
  });
});


describe("product detail view profiles", () => {
  beforeEach(() => {
    execute.mockReset();
    loadFeatureFlowGraphs.mockReset().mockResolvedValue(new Map());
    loadFeatureFlowErrors.mockReset().mockResolvedValue(new Map());
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null }]];
      if (sql.includes("FROM features")) return [[{ id: 5, name: "Login", summary: "OAuth", parentId: null, source: "generated" }]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      return [[]];
    });
  });

  it("overview does not read historical folded diffs, reviewed items, or feature flows", async () => {
    const details = await getProductDetails("radar", 7, { view: "overview" });
    const queries = execute.mock.calls.map(([sql]) => String(sql));

    expect(details?.features).toHaveLength(1);
    expect(details?.foldedChanges).toEqual([]);
    expect(loadFeatureFlowGraphs).not.toHaveBeenCalled();
    expect(loadFeatureFlowErrors).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("FROM spec_features WHERE spec_version_id IN"))).toBe(false);
    expect(queries.some((sql) => sql.includes("FROM release_reviewed_items"))).toBe(false);
  });

  it("loads the presentation only for the overview profile and treats a missing table as not generated", async () => {
    const presentationRow = {
      product_id: 4, spec_version_id: 3, language: "zh-CN", status: "generated", source: "generated", tagline: null,
      capabilities_json: "[]", journeys_json: JSON.stringify([{ name: "登录后查看规格", steps: [{ featureName: "Login", reference: "happy" }] }]), coverage_json: null,
      fingerprint: "f", pending: 0, refreshing: 0, model_name: null, passes: 2, last_error: null, generated_at: null,
    };
    const fallback = execute.getMockImplementation()!;
    execute.mockImplementation(async (sql: string = "", params: unknown[] = []) => (sql.includes("FROM product_presentations") ? [[presentationRow]] : fallback(sql, params)));

    const overview = await getProductDetails("radar", 7, { view: "overview" });
    expect(overview?.presentation).toMatchObject({ productId: 4, status: "generated", pending: false, refreshing: false, passes: 2 });
    expect(overview?.presentation?.journeys[0].name).toBe("登录后查看规格");

    execute.mockClear();
    await getProductDetails("radar", 7, { view: "changes" });
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("FROM product_presentations"))).toBe(false);

    // 迁移尚未执行 / 读取失败：按「尚未生成」处理，产品页不 500
    execute.mockImplementation(async (sql: string = "", params: unknown[] = []) => {
      if (sql.includes("FROM product_presentations")) throw new Error("Table 'product_presentations' doesn't exist");
      return fallback(sql, params);
    });
    await expect(getProductDetails("radar", 7, { view: "overview" })).resolves.toMatchObject({ presentation: null });
  });

  it("spec loads feature flows without reading release-only historical data", async () => {
    await getProductDetails("radar", 7, { view: "spec" });
    const queries = execute.mock.calls.map(([sql]) => String(sql));

    expect(loadFeatureFlowGraphs).toHaveBeenCalledOnce();
    expect(loadFeatureFlowErrors).toHaveBeenCalledOnce();
    expect(queries.some((sql) => sql.includes("FROM spec_features WHERE spec_version_id IN"))).toBe(false);
    expect(queries.some((sql) => sql.includes("COALESCE(ss.reference"))).toBe(false);
    expect(queries.some((sql) => sql.includes("FROM release_reviewed_items"))).toBe(false);
  });

  it("overview restricts every regression task query to the latest release", async () => {
    await getProductDetails("radar", 7, { view: "overview" });
    const regressionQueries = execute.mock.calls.filter(([sql]) => String(sql).includes("COALESCE(ss.reference") || String(sql).includes("FROM regression_task_sources s") || String(sql).includes("FROM regression_task_reasons r"));

    expect(regressionQueries).toHaveLength(3);
    for (const [sql, params] of regressionQueries) {
      expect(String(sql)).toMatch(/(?:r|rel)\.id IN \(\?\)/);
      expect(params).toEqual([4, 6]);
    }
  });

  it("release pages include only their own regression tasks", async () => {
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null }]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      if (sql.includes("COALESCE(ss.reference")) return [[{ taskId: 9, releaseId: 6, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, specScenarioId: 501, specChangeId: null, reference: "HP-1", featureName: "Login", scenarioContext: null, scenarioAction: null, primaryChangeId: 8 }]];
      return [[]];
    });

    const page = await loadReleasePage("radar", 7, 0, 10);

    expect(page?.regressionTasks).toEqual([expect.objectContaining({ taskId: 9, releaseId: 6, reference: "HP-1" })]);
    const taskQuery = execute.mock.calls.find(([sql]) => String(sql).includes("COALESCE(ss.reference"));
    expect(String(taskQuery?.[0])).toContain("r.id IN (?)");
    expect(taskQuery?.[1]).toEqual([4, 6]);
  });
});

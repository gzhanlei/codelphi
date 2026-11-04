import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProductDetails } from "../lib/product-details";

const execute = vi.fn();
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/architecture-store", () => ({ getLatestArchitectureDocument: vi.fn(async () => undefined) }));

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
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main" }]];
      return [[]];
    });
    const details = await getProductDetails("radar", 7);
    expect(details?.repository).toEqual({ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main" });
    expect(details?.features).toEqual([]);
    expect(details?.releases).toEqual([]);
    expect(execute.mock.calls[0][1]).toEqual(["radar", 7]);
    expect(execute.mock.calls[0][0]).toContain("organization_id = ?");
  });

  it("loads feature, release and parsed behavior evidence without an organization filter", async () => {
    execute.mockImplementation(async (sql: string = "") => {
      if (sql.includes("FROM products")) return [[product]];
      if (sql.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main" }]];
      if (sql.includes("FROM analysis_runs")) return [[{ status: "succeeded", errorMessage: null }]];
      if (sql.includes("FROM features")) return [[{ id: 5, name: "Login", summary: "OAuth", parentId: null, source: "generated" }]];
      if (sql.includes("FROM releases")) return [[{ id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 }]];
      if (sql.includes("FROM scenarios")) return [[{ id: 7, featureId: 5, reference: "happy", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      if (sql.includes("FROM spec_changes")) return [[{ id: 8, releaseId: 6, kind: "modified", entityType: "scenario", featureName: "Login", scenarioReference: "happy", summary: "Changed", beforeJson: "{\"old\":true}", afterJson: "{\"new\":true}" }]];
      if (sql.includes("FROM changes")) return [[{ id: 9, releaseId: 6, featureName: "Login", kind: "modified", description: "Changed", userImpact: "Impact", evidence: [] }]];
      if (!sql) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const details = await getProductDetails("radar");
    expect(details?.scenarios).toHaveLength(1);
    expect(details?.changes).toHaveLength(1);
    expect(details?.behaviorChanges[0]).toMatchObject({ before: { old: true }, after: { new: true } });
    expect(details?.latestRun?.status).toBe("succeeded");
    expect(details?.product.descriptionEvidence).toEqual([{ path: "lib/analysis.ts", startLine: 185 }]);
    expect(execute.mock.calls[0][1]).toEqual(["radar"]);
    expect(execute.mock.calls[0][0]).not.toContain("organization_id = ?");
  });
});

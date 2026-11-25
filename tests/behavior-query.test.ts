import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryBehavior } from "../lib/behavior-query/query-behavior";

const product = { id: 9, slug: "radar", name: "Radar", description: "d" };
const search = vi.fn();
const lookupImpact = vi.fn();
const coverage = vi.fn();
const freshness = vi.fn();
const execute = vi.fn();
const runtime = { execute: execute as never, identity: { keyId: 7, organizationId: 5 }, search, lookupImpact, coverage, freshness };

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM products WHERE organization_id")) return [[product]];
    if (String(sql).includes("FROM repositories r")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
    if (String(sql).includes("FROM releases WHERE product_id")) return [[{ id: 4, title: "r", sha: "abc123", committedAt: new Date(), specVersionId: 44 }]];
    return [[]];
  });
  coverage.mockResolvedValue({ evidenceBackedScenarioCount: 1, scenarioCount: 1 } as never);
  freshness.mockResolvedValue({ block: { available: true }, changedBehavioralPaths: new Set() } as never);
});

describe("generic behavior questions", () => {
  it("returns current behavior facts, file impacts, evidence and coverage without an inner RPC", async () => {
    search.mockResolvedValue({
      features: [{ id: 1, name: "通知", summary: "s", stableKey: "通知" }],
      scenarios: [{ id: 2, featureId: 1, featureName: "通知", featureStableKey: "通知", reference: "HP-1", context: "c", action: "a", outcome: "o", evidence: [{ path: "lib/notifications.ts", startLine: 202 }] }],
      history: [],
    } as never);
    lookupImpact.mockResolvedValue([{ path: "lib/notifications.ts", features: [{ stableKey: "通知", featureName: "通知", scenarios: [{ id: 2, source: "manual", evidence: [{ path: "lib/notifications.ts" }] }] }] }] as never);
    const response = await queryBehavior(runtime, { slug: "radar", question: "修改通知时哪些行为不能变？", paths: ["lib/notifications.ts"] });
    expect(response.status).toBe("success");
    expect(response.facts[0]).toMatchObject({ stableKey: "通知", reference: "HP-1", outcome: "o" });
    expect(response.observedOutcomes).toEqual([{ stableKey: "通知", reference: "HP-1", text: "o" }]);
    expect(response.impacts[0]).toMatchObject({ stableKey: "通知", severity: "high" });
    expect(response.coverage).toMatchObject({ snapshotSha: "abc123", requestedPathCount: 1, matchedPathCount: 1, uncoveredPathCount: 0, evidenceBackedScenarioCount: 1 });
    expect(response.productDecisions).toEqual([]);
    expect(response.decisionPolicy).toBe("not_inferred");
    expect(response.suggestedQueries.length).toBeGreaterThan(0);
    expect(search).toHaveBeenCalledWith(9, "修改通知时哪些行为不能变？", runtime.execute, "fallback");
  });

  it("uses fallback history and marks empty answers as unknown instead of nonexistent behavior", async () => {
    search.mockResolvedValue({ features: [], scenarios: [], history: [] } as never);
    const response = await queryBehavior(runtime, { slug: "radar", question: "不存在的通知行为" });
    expect(response.status).toBe("empty");
    expect(response.unknowns).toContainEqual({ code: "no_matching_behavior" });
    expect(response.facts).toEqual([]);
  });

  it("reports uncovered paths and unavailable freshness", async () => {
    search.mockResolvedValue({ features: [], scenarios: [], history: [] } as never);
    freshness.mockRejectedValue(new Error("offline"));
    const response = await queryBehavior(runtime, { slug: "radar", question: "通知", paths: ["lib/new.ts"] });
    expect(response.unknowns).toContainEqual({ code: "uncovered_paths", paths: ["lib/new.ts"] });
    expect(response.unknowns).toContainEqual({ code: "freshness_unavailable" });
    expect(response.status).toBe("partial");
  });

  it("rejects blank questions and cross-organization products stay empty", async () => {
    await expect(queryBehavior(runtime, { slug: "radar", question: " " })).rejects.toThrow("question");
    execute.mockImplementation(async () => [[]]);
    const response = await queryBehavior(runtime, { slug: "radar", question: "通知" });
    expect(response).toEqual({});
  });
});

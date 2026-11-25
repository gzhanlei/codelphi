import { describe, expect, it, vi } from "vitest";
import { handleMcpRpc, MCP_TOOLS } from "../lib/mcp/server";

const execute = vi.fn();
const search = vi.fn();
const lookupImpact = vi.fn();
const coverage = vi.fn();
const freshness = vi.fn();
const runtime = { execute: execute as never, identity: { keyId: 7, organizationId: 5 }, search, lookupImpact, coverage, freshness };
const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("ask_behavior MCP tool", () => {
  it("is exposed in tools/list and accepts free-form behavior questions", async () => {
    expect(MCP_TOOLS.some((tool) => tool.name === "ask_behavior")).toBe(true);
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories r")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM releases WHERE product_id")) return [[{ id: 4, title: "r", sha: "abc123", committedAt: new Date(), specVersionId: 44 }]];
      return [[]];
    });
    search.mockResolvedValue({ features: [], scenarios: [{ id: 2, featureId: 1, featureName: "通知", featureStableKey: "通知", reference: "HP-1", context: "c", action: "a", outcome: "o", evidence: [] }], history: [] } as never);
    lookupImpact.mockResolvedValue([] as never);
    coverage.mockResolvedValue(null as never);
    freshness.mockResolvedValue({ block: { available: true }, changedBehavioralPaths: new Set() } as never);
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "ask_behavior", arguments: { slug: "radar", question: "通知设置有哪些历史约束？", paths: ["lib/notifications.ts"] } }));
    const result = response?.result as { structuredContent: { schemaVersion: string; question: string } };
    expect(result.structuredContent.schemaVersion).toBe("codelphi.behavior.v1");
    expect(result.structuredContent.question).toBe("通知设置有哪些历史约束？");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRpc, MCP_PROTOCOL_VERSION, MCP_TOOLS } from "../lib/mcp/server";
import type { Execute } from "../lib/db";

const execute = vi.fn();
const runtime = { execute: execute as unknown as Execute, identity: { keyId: 7, organizationId: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async () => [[]]);
});

const rpc = (method: string, params?: Record<string, unknown>, id: string | number = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mcp server (A1)", () => {
  it("answers initialize with protocol version and tool capability", async () => {
    const response = await handleMcpRpc(runtime, rpc("initialize"));
    expect(response?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "codelphi-mcp" } });
    expect(response?.result).toHaveProperty("capabilities.tools");
  });

  it("lists the read-only tool surface with JSON schemas", async () => {
    const response = await handleMcpRpc(runtime, rpc("tools/list"));
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["list_projects", "get_project_summary", "get_feature", "get_scenario", "search_scenarios", "list_releases", "get_release", "send_feedback"]);
  });

  it("returns no response for notifications (no id)", async () => {
    expect(await handleMcpRpc(runtime, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("scopes list_projects to the key's organization", async () => {
    execute.mockResolvedValue([[{ slug: "radar", name: "Radar", description: "d" }]]);
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "list_projects", arguments: {} }));
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("organization_id = ?"), [5]);
    expect((response?.result as { structuredContent: { projects: unknown[] } }).structuredContent.projects).toHaveLength(1);
  });

  it("returns an empty result instead of an error for cross-organization slugs (防枚举)", async () => {
    // 产品不属于该组织：resolveOrgProduct 返回 null → 空结果，不暴露存在性
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_project_summary", arguments: { slug: "other-org-product" } }));
    expect((response?.result as { structuredContent: Record<string, unknown> }).structuredContent).toEqual({});
    expect(response?.result).not.toHaveProperty("error");
  });

  it("carries stable links and evidence blob urls on feature results", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM spec_features sf")) return [[{ name: "统一登录", specVersionId: 44 }]];
      if (String(sql).includes("FROM features f WHERE f.product_id")) return [[{ id: 12 }]];
      if (String(sql).includes("FROM features WHERE id = ?")) return [[{ id: 12, name: "统一登录", summary: "s", source: "generated" }]];
      if (String(sql).includes("FROM scenarios WHERE feature_id")) return [[{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feature", arguments: { slug: "radar", stableKey: "统一登录" } }));
    const result = (response?.result as { structuredContent: { scenarios: Array<{ evidence: Array<{ url: string | null }> }> } }).structuredContent;
    expect(result.scenarios[0].evidence[0].url).toBe("https://github.com/gzhanlei/radar/blob/abc123/lib/auth.ts#L10");
  });

  it("exposes coverage from B1 receipts in the project summary", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[]];
      if (String(sql).includes("COUNT(*) AS count FROM features")) return [[{ count: 14 }]];
      if (String(sql).includes("FROM releases")) return [[{ id: 6, title: "v1", sha: "abc", committedAt: new Date(), specVersionId: 44 }]];
      if (String(sql).includes("FROM analysis_coverage_receipts")) return [[{ specVersionId: 44, implFilesAssembled: 30, implFilesTotal: 60, implBytesAssembled: 80_000, implBytesTotal: 200_000, coverageRatio: 0.4, partitionsUsed: 2, partitionsCapped: 0 }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_project_summary", arguments: { slug: "radar" } }));
    const summary = (response?.result as { structuredContent: { evidenceCoverage: { coverageRatio: number }; featureCount: number } }).structuredContent;
    expect(summary.featureCount).toBe(14);
    expect(summary.evidenceCoverage.coverageRatio).toBe(0.4);
  });

  it("rejects unknown tools and methods with JSON-RPC errors", async () => {
    expect((await handleMcpRpc(runtime, rpc("tools/call", { name: "create_project" })))?.error?.code).toBe(-32601);
    expect((await handleMcpRpc(runtime, rpc("resources/list")))?.error?.code).toBe(-32601);
  });

  it("never exposes write tools", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    for (const forbidden of ["create_project", "edit_scenario", "invite_member", "update_billing", "publish_release_notes"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

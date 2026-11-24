import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRpc } from "../lib/mcp/server";
import type { Execute } from "../lib/db";

const execute = vi.fn();
const runtime = { execute: execute as unknown as Execute, identity: { organizationId: 5 } };
const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async () => [[]]);
});

describe("MCP impact golden validation", () => {
  it("returns only scenarios linked to the requested evidence and preserves their evidence", async () => {
    execute.mockImplementation(async (sql: string) => {
      const query = String(sql);
      if (query.includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (query.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (query.includes("s.evidence LIKE ?")) return [[
        { id: 1, featureId: 1, featureName: "发布入口", reference: "HP-1", context: "匿名访客", action: "打开发布页", outcome: "进入发布流程", source: "generated", evidence: [{ path: "components/publish.tsx", startLine: 10 }] },
        { id: 2, featureId: 1, featureName: "发布入口", reference: "HP-2", context: "登录用户", action: "打开发布页", outcome: "进入发布流程", source: "generated", evidence: [{ path: "components/publish.tsx", startLine: 20 }] },
      ]];
      return [[]];
    });

    const response = await handleMcpRpc(runtime, rpc("lookup_by_files", { slug: "radar", paths: ["components/publish.tsx"] }));
    const result = (response?.result as { structuredContent: { files: Array<{ features: Array<{ scenarios: Array<{ reference: string; evidence: Array<{ path: string; startLine: number }> }> }> }> } }).structuredContent;
    const scenarios = result.files[0].features[0].scenarios;
    expect(scenarios.map((scenario) => scenario.reference)).toEqual(["HP-1", "HP-2"]);
    expect(scenarios.map((scenario) => scenario.reference)).not.toContain("HP-9");
    expect(scenarios[0].evidence[0]).toMatchObject({ path: "components/publish.tsx", startLine: 10 });
  });

  it("returns uncertain lifecycle evidence without presenting it as confirmed removal", async () => {
    execute.mockImplementation(async (sql: string) => {
      const query = String(sql);
      if (query.includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (query.includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (query.includes("FROM releases WHERE id = ?")) return [[{ id: 315, title: "v", summary: "s", sha: "abc123", url: "u", committedAt: new Date(), specVersionId: 327 }]];
      if (query.includes("FROM spec_changes c JOIN releases")) return [[{
        id: 1,
        kind: "uncertain",
        entityType: "scenario",
        featureName: "发布入口",
        scenarioReference: "HP-1",
        summary: "「发布入口」未决场景 HP-1",
        highlightType: null,
        ...(query.includes("c.judgment") ? { judgment: "uncertain", evidenceState: "not_observed", reasonCodes: ["not_observed"] } : {}),
        beforeJson: { reference: "HP-1", context: "匿名访客", action: "打开发布页", outcome: "进入发布流程", category: "happy", evidence: [{ path: "components/publish.tsx", startLine: 10 }] },
        afterJson: null,
      }]];
      return [[]];
    });

    const response = await handleMcpRpc(runtime, rpc("get_release", { slug: "radar", releaseId: 315 }));
    const result = (response?.result as { structuredContent: { changes: Array<Record<string, unknown>> } }).structuredContent;
    expect(result.changes[0]).toMatchObject({
      kind: "uncertain",
      judgment: "uncertain",
      evidenceState: "not_observed",
      reasonCodes: ["not_observed"],
      before: { reference: "HP-1", evidence: [{ path: "components/publish.tsx", startLine: 10 }] },
    });
    expect(result.changes[0].kind).not.toBe("removed");
  });
});

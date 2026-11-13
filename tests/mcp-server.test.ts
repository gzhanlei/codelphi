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
    expect(tools.map((tool) => tool.name)).toEqual(["list_projects", "get_project_summary", "get_feature", "get_scenario", "search_scenarios", "lookup_by_files", "list_releases", "get_release", "get_knowledge_health", "get_feature_connections", "get_release_notes", "get_digest", "send_feedback"]);
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
      if (String(sql).includes("analysis_completeness_ledger")) return [[{ runId: 12, sourceCoverage: "partial", behavioralEnumeration: "complete", extractionCompletion: "complete", evidenceIntegrity: "complete", mergeIntegrity: "partial", verification: "not_applicable", overall: "partial", details: {} }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_project_summary", arguments: { slug: "radar" } }));
    const summary = (response?.result as { structuredContent: { evidenceCoverage: { coverageRatio: number }; completeness: { overall: string; sourceCoverage: string } | null; featureCount: number; specSnapshot: { specVersionId: number; sha: string; committedAt: unknown } | null } }).structuredContent;
    expect(summary.featureCount).toBe(14);
    expect(summary.evidenceCoverage.coverageRatio).toBe(0.4);
    // R1 账本随 summary 暴露（整体状态 + 六维度），诚实披露不合并成单一百分比
    expect(summary.completeness).toMatchObject({ overall: "partial", sourceCoverage: "partial" });
    // 账本是快照：调用方需要知道规格对应哪个 commit，才能把账本状态与工作区状态分开
    expect(summary.specSnapshot).toMatchObject({ specVersionId: 44, sha: "abc" });
  });

  it("reports a null spec snapshot when the product has no releases", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("COUNT(*) AS count FROM features")) return [[{ count: 3 }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_project_summary", arguments: { slug: "radar" } }));
    const summary = (response?.result as { structuredContent: { specSnapshot: unknown } }).structuredContent;
    expect(summary.specSnapshot).toBeNull();
  });

  it("reverse-looks up affected features and scenarios by evidence file paths", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("s.evidence LIKE ?")) {
        return [[
          { id: 1, featureId: 1, featureName: "统一登录", reference: "HP-1", context: "已登录", action: "访问设置页", outcome: "跳转", source: "manual", evidence: [{ path: "lib/auth.ts", startLine: 10 }] },
          { id: 2, featureId: 2, featureName: "规格导出", reference: "EC-1", context: "导出中", action: "点击导出", outcome: "下载", source: "generated", evidence: [{ path: "lib/auth.ts" }] },
        ]];
      }
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "lookup_by_files", arguments: { slug: "radar", paths: ["lib/auth.ts", "lib/auth.ts", "uncovered.ts"] } }));
    const result = (response?.result as { structuredContent: { files: Array<{ path: string; features: Array<{ featureName: string; stableKey: string; scenarioCount: number; scenarios: Array<{ reference: string; source: string; evidence: Array<{ url: string | null }> }> }> }> } }).structuredContent;
    expect(result.files).toHaveLength(1); // 未覆盖的 uncovered.ts 不返回，lib/auth.ts 去重
    expect(result.files[0].path).toBe("lib/auth.ts");
    expect(result.files[0].features.map((feature) => feature.featureName)).toEqual(["统一登录", "规格导出"]);
    expect(result.files[0].features[0].stableKey).toBe("统一登录");
    expect(result.files[0].features[0].scenarios[0].source).toBe("manual");
    expect(result.files[0].features[0].scenarios[0].evidence[0].url).toBe("https://github.com/gzhanlei/radar/blob/abc123/lib/auth.ts#L10");
  });

  it("rejects lookup_by_files calls without usable paths (INVALID_PARAMS)", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      return [[]];
    });
    const empty = await handleMcpRpc(runtime, rpc("tools/call", { name: "lookup_by_files", arguments: { slug: "radar", paths: [] } }));
    expect(empty?.error?.code).toBe(-32602);
    const overflow = await handleMcpRpc(runtime, rpc("tools/call", { name: "lookup_by_files", arguments: { slug: "radar", paths: Array.from({ length: 21 }, (_, index) => `f${index}.ts`) } }));
    expect(overflow?.error?.code).toBe(-32602);
  });

  it("rejects unknown tools and methods with JSON-RPC errors", async () => {
    expect((await handleMcpRpc(runtime, rpc("tools/call", { name: "create_project" })))?.error?.code).toBe(-32601);
    expect((await handleMcpRpc(runtime, rpc("resources/list")))?.error?.code).toBe(-32601);
  });

  it("returns the published release note with human overrides and evidence paths (A2 工具面)", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM release_notes WHERE release_id")) return [[{ id: 5, status: "published", emphasis: "重点", shareToken: "tok", publishedAt: new Date() }]];
      if (String(sql).includes("FROM release_note_blocks b")) {
        return [[
          { position: 1, kind: "added", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", summaryOverride: "人工改写后的文案", highlightType: "News", beforeJson: null, afterJson: { scenarios: [{ evidence: [{ path: "lib/chat.ts" }] }] } },
          { position: 2, kind: "changed", featureName: "定价答复", scenarioReference: "EC-1", summary: "确定性答复", summaryOverride: null, highlightType: null, beforeJson: null, afterJson: null },
        ]];
      }
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_release_notes", arguments: { slug: "radar", releaseId: 9 } }));
    const result = (response?.result as { structuredContent: { status: string; publicUrl: string | null; blocks: Array<{ summary: string; overridden: boolean; evidencePaths: string[] }> } }).structuredContent;
    expect(result.status).toBe("published");
    expect(result.publicUrl).toContain("/share/notes/tok");
    expect(result.blocks[0].summary).toBe("人工改写后的文案");
    expect(result.blocks[0].overridden).toBe(true);
    expect(result.blocks[0].evidencePaths).toEqual(["lib/chat.ts"]);
    expect(result.blocks[1].summary).toBe("确定性答复");
    expect(result.blocks[1].overridden).toBe(false);
  });

  it("returns empty for a release without a note and exposes digest audience counts", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM digests WHERE product_id")) {
        return [[{ periodStart: "2026-11-04", periodEnd: "2026-11-10", contentJson: JSON.stringify({ period: { start: "2026-11-04", end: "2026-11-10" }, changes: [{ id: 11 }], audiences: { support: [{ id: 11 }], sales: [], marketing: [{ id: 11 }] } }), createdAt: new Date() }]];
      }
      return [[]];
    });
    const noNote = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_release_notes", arguments: { slug: "radar", releaseId: 404 } }));
    expect((noNote?.result as { structuredContent: Record<string, unknown> }).structuredContent).toEqual({});
    const digest = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_digest", arguments: { slug: "radar" } }));
    const result = (digest?.result as { structuredContent: { period: { start: string }; audienceCounts: Record<string, number> } }).structuredContent;
    expect(result.period.start).toBe("2026-11-04");
    expect(result.audienceCounts).toEqual({ support: 1, sales: 0, marketing: 1 });
  });

  it("returns deterministic feature connections scoped to the product", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM scenarios s JOIN features f")) {
        return [[
          { id: 1, featureId: 1, featureName: "统一登录", reference: "HP-1", evidence: [{ path: "lib/auth.ts" }] },
          { id: 2, featureId: 2, featureName: "规格导出", reference: "HP-1", evidence: [{ path: "lib/auth.ts" }] },
        ]];
      }
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feature_connections", arguments: { slug: "radar" } }));
    const result = (response?.result as { structuredContent: { connections: Array<{ featureName: string; connections: Array<{ targetFeatureName: string; sharedFiles: Array<{ path: string }> }> }> } }).structuredContent;
    expect(result.connections).toHaveLength(2);
    const login = result.connections.find((entry) => entry.featureName === "统一登录")!;
    expect(login.connections[0].targetFeatureName).toBe("规格导出");
    expect(login.connections[0].sharedFiles[0].path).toBe("lib/auth.ts");
  });

  it("exposes fact-only knowledge health via MCP", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM features WHERE product_id")) return [[{ id: 1, name: "统一登录", staleSince: new Date("2026-11-01"), verifiedAt: null, lastEditedBy: "alice", lastEditedAt: new Date("2026-11-06") }]];
      if (String(sql).includes("FROM scenarios s JOIN features f")) return [[]];
      if (String(sql).includes("FROM regression_tasks t")) return [[{ taskId: 1, releaseId: 9, status: "passed", checkedBy: "bob", checkedAt: new Date(), skipReason: null, failureNote: null, primaryChangeId: null, featureName: "统一登录", reference: "HP-1", subject: { kind: "scenario", scenarioId: 1 }, reasons: [], sources: [] }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_knowledge_health", arguments: { slug: "radar" } }));
    const report = (response?.result as { structuredContent: { report: { staleCount: number; maintenance: Array<{ editor: string }>; regression: { total: number } } } }).structuredContent.report;
    expect(report.staleCount).toBe(1);
    expect(report.maintenance[0].editor).toBe("alice");
    expect(report.regression.total).toBe(1);
  });

  it("never exposes write tools", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    for (const forbidden of ["create_project", "edit_scenario", "invite_member", "update_billing", "publish_release_notes"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

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
  it("answers initialize with protocol version, tool capability and workflow instructions", async () => {
    const response = await handleMcpRpc(runtime, rpc("initialize"));
    expect(response?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "codelphi-mcp" } });
    expect(response?.result).toHaveProperty("capabilities.tools");
    // instructions 随连接下发（零配置连接的工作流触发源）：覆盖计划期反查与 push 后对账两个关键时机
    const instructions = String((response?.result as { instructions?: string }).instructions ?? "");
    expect(instructions).toContain("lookup_by_files");
    expect(instructions).toContain("get_release");
    expect(instructions).toContain("send_feedback");
  });

  it("lists the read-only tool surface with JSON schemas", async () => {
    const response = await handleMcpRpc(runtime, rpc("tools/list"));
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["list_projects", "get_project_summary", "get_feature", "get_scenario", "search_scenarios", "lookup_by_files", "list_releases", "get_release", "reconcile_release", "get_feedback", "wait_for_release", "get_knowledge_health", "get_feature_connections", "get_release_notes", "get_digest", "send_feedback"]);
  });

  it("declares canonical and risk view parameters in tool schemas", () => {
    const feature = MCP_TOOLS.find((tool) => tool.name === "get_feature")!;
    const files = MCP_TOOLS.find((tool) => tool.name === "lookup_by_files")!;
    expect(feature.inputSchema.properties).toHaveProperty("view");
    expect(files.inputSchema.properties).toHaveProperty("view");
  });

  it("falls back to release evidence when current scenario search is empty", async () => {
    const search = MCP_TOOLS.find((tool) => tool.name === "search_scenarios")!;
    expect(search.inputSchema.properties).toHaveProperty("scope");
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM spec_changes")) return [[{
        releaseId: 35, sha: "abc123", committedAt: new Date(), specChangeId: 1069, kind: "added",
        featureName: "Web 管理后台", scenarioReference: "ER-1", summary: "非 HTTP(S) 保持纯文本",
        after: { context: "c", action: "a", outcome: "o", evidence: [] },
      }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "search_scenarios", arguments: { slug: "radar", query: "链接", scope: "fallback" } }));
    const content = (response?.result as { structuredContent: { history: Array<{ source: string; releaseId: number }> } }).structuredContent;
    expect(content.history).toEqual([expect.objectContaining({ source: "release", releaseId: 35 })]);
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

  it("narrows connections to the neighborhood of one evidence file", async () => {
    execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("s.evidence LIKE ?")) {
        // SQL LIKE 预过滤会误中 lib/auth.tsx（子串），精确性靠读侧复核：auth.tsx 行必须被剔除
        return [[
          { id: 1, featureId: 1, featureName: "统一登录", reference: "HP-1", evidence: [{ path: "lib/auth.ts" }] },
          { id: 2, featureId: 2, featureName: "规格导出", reference: "HP-1", evidence: [{ path: "lib/auth.ts" }] },
          { id: 3, featureId: 3, featureName: "类型文档", reference: "HP-1", evidence: [{ path: "lib/auth.tsx" }] },
          { id: 4, featureId: 4, featureName: "独立功能", reference: "HP-1", evidence: [{ path: "lib/solo.ts" }] },
        ]];
      }
      expect(params).toBeDefined();
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feature_connections", arguments: { slug: "radar", path: "lib/auth.ts" } }));
    const result = (response?.result as { structuredContent: { connections: Array<{ featureName: string; connections: unknown[] }> } }).structuredContent;
    expect(result.connections.map((entry) => entry.featureName)).toEqual(["统一登录", "规格导出"]); // auth.tsx 与独立文件不参与该邻域；按 featureId 确定性排序
    const call = execute.mock.calls.find(([sql]) => String(sql).includes("s.evidence LIKE ?"))!;
    expect(call[1]).toEqual([9, "%lib/auth.ts%"]);
  });

  it("narrows connections to a single feature by stable key", async () => {
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
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feature_connections", arguments: { slug: "radar", feature: "统一登录" } }));
    const result = (response?.result as { structuredContent: { connections: Array<{ featureName: string }> } }).structuredContent;
    expect(result.connections.map((entry) => entry.featureName)).toEqual(["统一登录"]);
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

  it("maps requires-style parameter errors to INVALID_PARAMS", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[]];
      if (String(sql).includes("FROM releases WHERE id = ?")) return [[{ id: 229, title: "v", summary: "s", sha: "abc", url: "u", committedAt: new Date() }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_release", arguments: { slug: "radar", releaseId: 229, offset: 1 } }));
    expect(response?.error?.code).toBe(-32602);
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
          { position: 2, kind: "changed", featureName: "定价答复", scenarioReference: "EC-1", summary: "确定性答复", summaryOverride: null, highlightType: null, beforeJson: null, afterJson: { reference: "EC-1", evidence: [{ path: "lib/direct.ts" }] } },
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
    expect(result.blocks[1].evidencePaths).toEqual(["lib/direct.ts"]);
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

  it("resolves the evidence sha with a per-repository latest-run subquery (无界 join 会取到旧 run)", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM features WHERE id = ?")) return [[{ id: 12, name: "统一登录", summary: "s", source: "generated" }]];
      if (String(sql).includes("FROM scenarios WHERE feature_id")) return [[{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }]];
      return [[]];
    });
    await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feature", arguments: { slug: "radar", stableKey: "统一登录" } }));
    const reposQuery = execute.mock.calls.find(([sql]) => String(sql).includes("FROM repositories"))!;
    expect(String(reposQuery[0])).toContain("ar.repository_id = r.id");
    expect(String(reposQuery[0])).toContain("ORDER BY ar.id DESC LIMIT 1");
  });

  it("records send_feedback with the per-repository latest-run revision subquery", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("INSERT INTO feedback_reports")) return [{ insertId: 77 }];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "send_feedback", arguments: { slug: "radar", kind: "bug", message: "对账发现变化清单不完整" } }));
    const result = (response?.result as { structuredContent: { feedbackId: number } }).structuredContent;
    expect(result.feedbackId).toBe(77);
    const insertQuery = execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO feedback_reports"))!;
    const sql = String(insertQuery[0]);
    expect(sql).toContain("ar.repository_id = r.id");
    expect(sql).toContain("ORDER BY ar.id DESC LIMIT 1");
    expect(sql).not.toContain("LEFT JOIN (SELECT repository_id, after_sha FROM analysis_runs");
  });

  it("reconciles a release using direct scenario evidence and a name-level intent", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM releases WHERE id = ?")) return [[{ id: 229, title: "v", summary: "s", sha: "abc123", url: "u", committedAt: new Date(), specVersionId: 230, analysisRunId: 333 }]];
      if (String(sql).includes("FROM analysis_runs WHERE id = ?")) return [[{ id: 333, status: "succeeded", after_sha: "abc123", error_message: null }]];
      if (String(sql).includes("FROM release_files")) return [[{ path: "lib/a.ts" }]];
      if (String(sql).includes("FROM spec_changes c JOIN releases")) return [[{ id: 1, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-1", summary: "s", highlightType: null, beforeJson: null, afterJson: { reference: "EC-1", evidence: [{ path: "lib/a.ts" }] } }]];
      return [[]];
    });

    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "reconcile_release", arguments: { slug: "radar", releaseId: 229, expectedIntents: [{ stableKey: "功能" }] } }));
    const result = (response?.result as { structuredContent: { verdict: string; intentResults: Array<{ status: string }>; unexpected: unknown[] } }).structuredContent;
    expect(result.verdict).toBe("pass");
    expect(result.intentResults[0].status).toBe("matched");
    expect(result.unexpected).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("beforeJson");
  });

  it("does not pass reconciliation when run SHA differs from release SHA", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM releases WHERE id = ?")) return [[{ id: 229, title: "v", summary: "s", sha: "release-sha", url: "u", committedAt: new Date(), specVersionId: 230, analysisRunId: 333 }]];
      if (String(sql).includes("FROM analysis_runs WHERE id = ?")) return [[{ id: 333, status: "succeeded", after_sha: "different-run-sha", error_message: null }]];
      if (String(sql).includes("FROM release_files")) return [[{ path: "lib/a.ts" }]];
      if (String(sql).includes("FROM spec_changes c JOIN releases")) return [[{ id: 1, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-1", summary: "s", highlightType: null, beforeJson: null, afterJson: { reference: "EC-1", evidence: [{ path: "lib/a.ts" }] } }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "reconcile_release", arguments: { slug: "radar", releaseId: 229, expectedIntents: [{ stableKey: "功能" }] } }));
    const result = (response?.result as { structuredContent: { verdict: string; analysis: { status: string } } }).structuredContent;
    expect(result.verdict).toBe("review");
    expect(result.analysis.status).toBe("unknown");
  });

  it("applies the same pagination contract to canonical release projections", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM releases WHERE id = ?")) return [[{ id: 229, title: "v", summary: "s", sha: "abc123", url: "u", committedAt: new Date(), specVersionId: 230 }]];
      if (String(sql).includes("FROM spec_changes c JOIN releases")) {
        return [[
          { id: 1, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-1", summary: "s", highlightType: null, beforeJson: null, afterJson: null },
          { id: 2, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-2", summary: "s", highlightType: null, beforeJson: null, afterJson: null },
        ]];
      }
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_release", arguments: { slug: "radar", releaseId: 229, view: "canonical", limit: 1, offset: 1 } }));
    const result = (response?.result as { structuredContent: { scenarios: Array<{ rawRecordIds: number[] }>; total: number; hasMore: boolean } }).structuredContent;
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].rawRecordIds).toEqual([2]);
    expect(result).toMatchObject({ total: 2, hasMore: false });
  });

  it("paginates release changes with stable ids and compatible response fields", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("FROM releases WHERE id = ?")) return [[{ id: 229, title: "v", summary: "s", sha: "abc123", url: "u", committedAt: new Date() }]];
      if (String(sql).includes("COUNT(*) AS total FROM spec_changes")) return [[{ total: 3 }]];
      if (String(sql).includes("FROM spec_changes c JOIN releases")) {
        return [[
          { id: 1, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-1", summary: "s", highlightType: null, beforeJson: null, afterJson: null },
          { id: 2, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-2", summary: "s", highlightType: null, beforeJson: null, afterJson: null },
          { id: 3, kind: "added", entityType: "scenario", featureName: "功能", scenarioReference: "EC-3", summary: "s", highlightType: null, beforeJson: null, afterJson: null },
        ]];
      }
      return [[]];
    });

    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_release", arguments: { slug: "radar", releaseId: 229, limit: 1, offset: 1 } }));
    const result = (response?.result as { structuredContent: { changes: Array<{ id: number }>; offset: number; limit: number; total: number; hasMore: boolean } }).structuredContent;
    expect(result.changes.map((change) => change.id)).toEqual([2]);
    expect(result).toMatchObject({ offset: 1, limit: 1, total: 3, hasMore: true });
  });

  it("returns a bounded risk projection with uncovered paths", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("s.evidence LIKE ?")) {
        return [[{ id: 1, featureId: 1, featureName: "统一登录", reference: "HP-1", context: "c", action: "a", outcome: "o", source: "manual", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }]];
      }
      return [[]];
    });

    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "lookup_by_files", arguments: { slug: "radar", paths: ["lib/auth.ts", "lib/missing.ts"], view: "risk" } }));
    const result = (response?.result as { structuredContent: { snapshotSha: string; coveredPaths: string[]; uncoveredPaths: string[]; risks: Array<{ severity: string }> } }).structuredContent;
    expect(result.snapshotSha).toBe("abc123");
    expect(result.coveredPaths).toEqual(["lib/auth.ts"]);
    expect(result.uncoveredPaths).toEqual(["lib/missing.ts"]);
    expect(result.risks[0].severity).toBe("high");
  });

  it("deduplicates risk rows across requested paths without hiding the true total", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[{ provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main", sha: "abc123" }]];
      if (String(sql).includes("s.evidence LIKE ?")) {
        return [[{ id: 1, featureId: 1, featureName: "统一登录", reference: "HP-1", context: "c", action: "a", outcome: "o", source: "generated", evidence: [{ path: "lib/a.ts" }, { path: "lib/b.ts" }] }]];
      }
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "lookup_by_files", arguments: { slug: "radar", paths: ["lib/a.ts", "lib/b.ts"], view: "risk" } }));
    const result = (response?.result as { structuredContent: { rawScenarioCount: number; canonicalScenarioCount: number; totalCount: number; risks: unknown[] } }).structuredContent;
    expect(result.rawScenarioCount).toBe(1);
    expect(result.canonicalScenarioCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(result.risks).toHaveLength(1);
  });

  it("returns feedback lifecycle without inventing verification", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[]];
      if (String(sql).includes("FROM feedback_reports WHERE id = ?")) return [[{ id: 14, kind: "bug", status: "new", verdict: "needs_human", verdict_reason: "需要人工", adjudicated_at: new Date("2026-11-15T18:00:00Z"), github_issue_url: null, corrective_run_id: null, regression_stable_key: null }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_feedback", arguments: { slug: "radar", feedbackId: 14 } }));
    const result = (response?.result as { structuredContent: { correctiveAnalysis: { status: string }; verification: { status: string } } }).structuredContent;
    expect(result.correctiveAnalysis.status).toBe("not_run");
    expect(result.verification.status).toBe("unavailable");
  });

  it("waits for the exact SHA only when the run and release are both complete", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("candidateCount")) return [[{ candidateCount: 1 }]];
      if (String(sql).includes("after_sha LIKE ?")) return [[{ id: 333, status: "succeeded", after_sha: "abc1234", error_message: null }]];
      if (String(sql).includes("FROM releases WHERE product_id = ? AND sha LIKE ?")) return [[{ id: 231, sha: "abc1234" }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "wait_for_release", arguments: { slug: "radar", sha: "abc1234", timeoutSeconds: 0 } }));
    const result = (response?.result as { structuredContent: { status: string; releaseId: number; analysisRunId: number } }).structuredContent;
    expect(result).toMatchObject({ status: "completed", releaseId: 231, analysisRunId: 333 });
    const runQuery = execute.mock.calls.find(([sql]) => String(sql).includes("after_sha LIKE ?"))!;
    expect(String(runQuery[0])).toContain("SELECT ar.id, ar.status, ar.after_sha, ar.error_message");
    expect(String(runQuery[0])).toContain("ORDER BY ar.created_at DESC, ar.id DESC");
  });

  it("supports an unambiguous short SHA prefix", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("candidateCount")) return [[{ candidateCount: 1 }]];
      if (String(sql).includes("after_sha LIKE ?")) return [[{ id: 333, status: "succeeded", after_sha: "abc1234", error_message: null }]];
      if (String(sql).includes("FROM releases WHERE product_id = ? AND sha LIKE ?")) return [[{ id: 231, sha: "abc1234" }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "wait_for_release", arguments: { slug: "radar", sha: "abc1234", timeoutSeconds: 0 } }));
    const result = (response?.result as { structuredContent: { status: string; releaseId: number } }).structuredContent;
    expect(result).toMatchObject({ status: "completed", releaseId: 231 });
    const runQuery = execute.mock.calls.find(([sql]) => String(sql).includes("after_sha LIKE ?"))!;
    expect(runQuery[1]).toEqual(["abc1234%", 9]);
  });

  it("exposes scoped release health in the project summary", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM repositories")) return [[]];
      if (String(sql).includes("COUNT(*) AS count FROM features")) return [[{ count: 14 }]];
      if (String(sql).includes("FROM releases WHERE product_id = ? ORDER BY committed_at DESC")) return [[{ id: 231, title: "v1", sha: "abc", committedAt: new Date(), specVersionId: 230 }]];
      if (String(sql).includes("totalReleaseCount")) return [[{ totalReleaseCount: 223, eligibleReleaseCount: 167, linkedReleaseCount: 167, legacyReleaseCount: 0 }]];
      if (String(sql).includes("eligibleChangeCount")) return [[{ totalChangeCount: 2260, eligibleChangeCount: 2239, reviewedExcludedCount: 21, sourceLinkedChangeCount: 2239, sourceLinkCount: 13699, orphanLinkCount: 0 }]];
      if (String(sql).includes("FROM schema_migrations")) return [[{ name: "075.sql", appliedAt: "2026-11-15T19:00:00Z" }]];
      if (String(sql).includes("FROM analysis_runs")) return [[{ id: 333, status: "succeeded", after_sha: "abc", error_message: null }]];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "get_project_summary", arguments: { slug: "radar" } }));
    const health = (response?.result as { structuredContent: { releaseHealth: { sourceLinkedRatio: number; canonicalProjectionRatio: number; legacyReleaseCount: number } } }).structuredContent.releaseHealth;
    expect(health).toMatchObject({ sourceLinkedRatio: 1, canonicalProjectionRatio: 1, legacyReleaseCount: 0, totalChangeCount: 2260, eligibleChangeCount: 2239, reviewedExcludedCount: 21 });
    const orphanQuery = execute.mock.calls.find(([sql]) => String(sql).includes("orphanLinkCount"))!;
    expect(String(orphanQuery[0])).toContain("r.product_id = ? AND (c.id IS NULL OR r.id IS NULL OR sc.id IS NULL)");
    expect(String(orphanQuery[0])).not.toContain("OR r.id IS NULL)");
  });

  it("validates and stores a name-level regression anchor", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM products WHERE organization_id")) return [[{ id: 9, slug: "radar", name: "Radar", description: "d" }]];
      if (String(sql).includes("FROM spec_features")) return [[{ stable_key: "功能" }]];
      if (String(sql).includes("INSERT INTO feedback_reports")) return [{ insertId: 77 }];
      return [[]];
    });
    const response = await handleMcpRpc(runtime, rpc("tools/call", { name: "send_feedback", arguments: { slug: "radar", kind: "bug", message: "对账发现变化清单不完整", regressionStableKey: "功能" } }));
    expect((response?.result as { structuredContent: { feedbackId: number } }).structuredContent.feedbackId).toBe(77);
    const insert = execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO feedback_reports"))!;
    expect(insert[1]).toContain("功能");
  });

  it("never exposes write tools", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    for (const forbidden of ["create_project", "edit_scenario", "invite_member", "update_billing", "publish_release_notes"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

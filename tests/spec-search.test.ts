import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchBehavior, searchSpec } from "../lib/spec-search";

const execute = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("spec search", () => {
  it("matches features by name or summary and scenarios by text with LIKE escaping", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM features f")) return [[{ id: 12, name: "统一登录", summary: "OAuth 登录" }]];
      if (sql.includes("FROM scenarios s")) return [[{ id: 3, featureId: 12, featureName: "统一登录", reference: "HP-1", context: "已登录", action: "访问设置页", outcome: "跳转 /workspace" }]];
      return [[]];
    });
    const result = await searchSpec(3, "登录", execute);
    expect(result.features).toHaveLength(1);
    expect(result.scenarios).toHaveLength(1);
    const featureCall = execute.mock.calls.find(([sql]) => (sql as string).includes("FROM features f"))!;
    expect(featureCall[1]).toEqual([3, "%登录%", "%登录%"]);
    const scenarioCall = execute.mock.calls.find(([sql]) => (sql as string).includes("FROM scenarios s"))!;
    expect(String(scenarioCall[0])).toContain("s.evidence LIKE ?");
    expect(scenarioCall[1]).toEqual([3, "%登录%", "%登录%", "%登录%", "%登录%", "%登录%"]);
  });

  it("escapes LIKE wildcards in the query", async () => {
    execute.mockResolvedValue([[]]);
    await searchSpec(3, "100%_free", execute);
    expect(execute.mock.calls[0][1]).toEqual([3, "%100\\%\\_free%", "%100\\%\\_free%"]);
  });

  it("returns empty results when the query is blank", async () => {
    await expect(searchSpec(3, "   ", execute)).resolves.toEqual({ features: [], scenarios: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns stable keys so callers can address get_feature/get_scenario directly", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM features f")) return [[{ id: 12, name: "MCP 只读工具面", summary: "s" }]];
      if (sql.includes("FROM scenarios s")) return [[{ id: 3, featureId: 12, featureName: "统一登录", reference: "HP-1", context: "c", action: "a", outcome: "o", evidence: [] }]];
      return [[]];
    });
    const result = await searchSpec(3, "登录", execute);
    expect(result.features[0].stableKey).toBe("mcp 只读工具面");
    expect(result.scenarios[0].featureStableKey).toBe("统一登录");
  });
});


describe("behavior history search", () => {
  it("falls back to release evidence only when current scenarios are empty", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_changes")) return [[{
        releaseId: 35,
        sha: "3142b968",
        committedAt: new Date("2026-11-07T07:53:07Z"),
        specChangeId: 1069,
        kind: "added",
        featureName: "Web 管理后台",
        scenarioReference: "ER-1",
        summary: "非 HTTP(S) 保持纯文本",
        after: { context: "答复含 javascript:", action: "渲染", outcome: "不生成链接", evidence: [{ path: "server/web/src/components/__tests__/AssistantChatDrawer.spec.ts", startLine: 166 }] },
      }]];
      return [[]];
    });
    const result = await searchBehavior(9, "链接", execute, "fallback");
    expect(result.scenarios).toEqual([]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({ source: "release", releaseId: 35, specChangeId: 1069, featureName: "Web 管理后台" });
    expect(result.history[0].after?.outcome).toBe("不生成链接");
  });

  it("does not query release history in current mode or after a current scenario hit", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM scenarios s")) return [[{ id: 3, featureId: 12, featureName: "统一登录", reference: "HP-1", context: "c", action: "a", outcome: "o", evidence: [] }]];
      return [[]];
    });
    const result = await searchBehavior(9, "登录", execute, "current");
    expect(result.history).toEqual([]);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("FROM spec_changes"))).toBe(false);

    const fallback = await searchBehavior(9, "登录", execute, "fallback");
    expect(fallback.history).toEqual([]);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("FROM spec_changes"))).toBe(false);
  });

  it("expands 助手 to 助理 without changing result identity", async () => {
    execute.mockResolvedValue([[]]);
    await searchBehavior(9, "助手", execute, "current");
    const featureCall = execute.mock.calls.find(([sql]) => String(sql).includes("FROM features f"))!;
    expect(featureCall[1]).toContain("%助手%");
    expect(featureCall[1]).toContain("%助理%");
  });
});

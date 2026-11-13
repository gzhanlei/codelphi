import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchSpec } from "../lib/spec-search";

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

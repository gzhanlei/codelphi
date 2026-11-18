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

  it("collapses add/remove churn of the same feature+scenario to the latest entry, capped at 30", async () => {
    const change = (specChangeId: number, reference: string, kind: string) => ({
      releaseId: specChangeId,
      sha: `sha-${specChangeId}`,
      committedAt: new Date(Date.UTC(2026, 10, 18) - specChangeId * 86_400_000),
      specChangeId,
      kind,
      featureName: "反馈 AI 自动裁决",
      scenarioReference: reference,
      summary: `${kind} ${reference}`,
      before: null,
      after: kind === "removed" ? null : { context: "c", action: "a", outcome: "o" },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_changes")) {
        return [[
          // 同一 (feature, reference) 的 added→removed→added 兴替链：只保留最新一条
          change(301, "HP-5", "added"),
          change(295, "HP-5", "removed"),
          change(288, "HP-5", "added"),
          // reference 为空的功能级变化按 specChangeId 分组，各自保留
          { ...change(280, "HP-8", "added"), scenarioReference: null },
          { ...change(279, "HP-8", "added"), scenarioReference: null },
        ]];
      }
      return [[]];
    });
    const result = await searchBehavior(9, "裁决", execute, "history");
    expect(result.history).toHaveLength(3); // HP-5 最新一条 + 两条独立的功能级变化
    expect(result.history[0]).toMatchObject({ specChangeId: 301, scenarioReference: "HP-5" });
    expect(result.history.some((entry) => entry.specChangeId === 295 || entry.specChangeId === 288)).toBe(false);
  });

  it("expands 助手 to 助理 without changing result identity", async () => {
    execute.mockResolvedValue([[]]);
    await searchBehavior(9, "助手", execute, "current");
    const featureCall = execute.mock.calls.find(([sql]) => String(sql).includes("FROM features f"))!;
    expect(featureCall[1]).toContain("%助手%");
    expect(featureCall[1]).toContain("%助理%");
  });

  it("splits multi-token queries so any token recalls (compound CJK words get 2-char grams)", async () => {
    execute.mockResolvedValue([[]]);
    await searchSpec(9, "反馈裁决 sweep 证据路径", execute);
    const featureCall = execute.mock.calls.find(([sql]) => String(sql).includes("FROM features f"))!;
    const params = featureCall[1] as string[];
    // 完整查询保留 + 每个分词各自召回
    expect(params).toContain("%反馈裁决 sweep 证据路径%");
    expect(params).toContain("%sweep%");
    expect(params).toContain("%证据路径%");
    // CJK 复合词前后 2 字 gram：反馈裁决 → 反馈/裁决，反馈裁决整串 LIKE 无法命中「反馈 AI 自动裁决」
    expect(params).toContain("%反馈%");
    expect(params).toContain("%裁决%");
  });

  it("ranks features and scenarios by matched variant count, keeping SQL order for ties", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM features f")) {
        return [[
          { id: 1, name: "会话管理", summary: "OAuth 会话" },      // 命中 1 变体（会话）
          { id: 2, name: "统一登录与会话", summary: "OAuth 登录" }, // 命中 2 变体（登录+会话）
          { id: 3, name: "登录页面", summary: "登录表单" },         // 命中 1 变体（登录）
        ]];
      }
      return [[]];
    });
    const result = await searchSpec(9, "登录 OAuth 会话", execute);
    expect(result.features.map((feature) => feature.id)).toEqual([2, 1, 3]); // 2 变体 > 1 变体，同分保持 SQL 序
  });
});

import { describe, expect, it, vi } from "vitest";
import { analyzeWithAI, capEvidence, featureContinuitySection, incrementalScopeSection, parseAnalysisContent } from "../lib/ai";

const result = {
  product: { description: "统一认证与产品知识中心。", evidence: [{ path: "app/auth/login/route.ts", startLine: 1 }] },
  release: { title: "改进登录", summary: "接入统一登录。" },
  changes: [{ featureName: "认证", kind: "changed", description: "使用 OAuth", userImpact: "统一账号", evidence: [{ path: "app/auth/login/route.ts", startLine: 1 }] }],
  features: [{ name: "认证", summary: "统一登录", scenarios: [{ reference: "HP-1", context: "未登录用户", action: "点击登录", outcome: "进入 Chandler 授权", category: "happy", evidence: [{ path: "app/auth/login/route.ts", startLine: 1 }] }] }],
};

describe("AI analysis output", () => {
  it("parses strict JSON and fenced responses", () => {
    expect(parseAnalysisContent(JSON.stringify(result)).release.title).toBe("改进登录");
    expect(parseAnalysisContent(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``).features[0].scenarios[0].reference).toBe("HP-1");
  });

  it("caps oversized evidence lists before schema validation", () => {
    const oversized = structuredClone(result);
    oversized.changes[0].evidence = Array.from({ length: 6 }, (_, index) => ({ path: `lib/file-${index}.ts`, startLine: index + 1 }));
    expect(parseAnalysisContent(JSON.stringify(oversized)).changes[0].evidence).toHaveLength(5);
    oversized.features[0].scenarios[0].evidence = Array.from({ length: 7 }, (_, index) => ({ path: `lib/scenario-${index}.ts`, startLine: index + 1 }));
    expect(parseAnalysisContent(JSON.stringify(oversized)).features[0].scenarios[0].evidence).toHaveLength(5);
  });

  it("tolerates missing optional collections while capping evidence", () => {
    const empty = capEvidence({}) as { changes?: unknown; features?: unknown };
    expect(empty.changes).toBeUndefined();
    expect(empty.features).toBeUndefined();
    const partial = capEvidence({ product: {}, changes: [{}], features: [{ scenarios: [{}] }, {}] }) as { product: { evidence?: unknown }; changes: Array<{ evidence?: unknown }>; features: Array<{ scenarios?: Array<{ evidence?: unknown }> }> };
    expect(partial.product.evidence).toBeUndefined();
    expect(partial.changes[0].evidence).toBeUndefined();
    expect(partial.features[0].scenarios?.[0].evidence).toBeUndefined();
    expect(partial.features[1].scenarios).toBeUndefined();
  });

  it("requires traceable product description evidence", () => {
    const missing = structuredClone(result) as Record<string, unknown>;
    delete missing.product;
    expect(() => parseAnalysisContent(JSON.stringify(missing))).toThrow();
    const withoutEvidence = structuredClone(result);
    withoutEvidence.product.evidence = [];
    expect(() => parseAnalysisContent(JSON.stringify(withoutEvidence))).toThrow();
  });

  it("caps product description evidence", () => {
    const oversized = structuredClone(result);
    oversized.product.evidence = Array.from({ length: 7 }, (_, index) => ({ path: `lib/overview-${index}.ts`, startLine: index + 1 }));
    expect(parseAnalysisContent(JSON.stringify(oversized)).product.evidence).toHaveLength(5);
  });

  it("rejects responses without a complete JSON object", () => {
    expect(() => parseAnalysisContent("not json")).toThrow("AI response did not contain a JSON object");
    expect(() => parseAnalysisContent("}{")).toThrow("AI response did not contain a JSON object");
  });

  it("rejects unsupported scenario categories", () => {
    const invalid = structuredClone(result);
    invalid.features[0].scenarios[0].category = "unknown";
    expect(() => parseAnalysisContent(JSON.stringify(invalid))).toThrow();
  });
});

describe("feature naming continuity", () => {
  it("renders the previous feature list with continuity instructions", () => {
    const section = featureContinuitySection(["登录", "支付"]);
    expect(section).toContain("【上一版规格的功能清单");
    expect(section).toContain("- 登录");
    expect(section).toContain("- 支付");
    expect(section).toContain("不得重命名、不得合并重组");
  });

  it("returns null without previous names and caps long lists", () => {
    expect(featureContinuitySection(undefined)).toBeNull();
    expect(featureContinuitySection([])).toBeNull();
    expect(featureContinuitySection(["  "])).toBeNull();
    const section = featureContinuitySection(Array.from({ length: 70 }, (_, i) => `功能${i}`));
    expect(section).toContain("功能59");
    expect(section).not.toContain("功能60");
    expect(section).toContain("已截断");
  });

  it("renders the incremental scope section only for listed features", () => {
    const section = incrementalScopeSection(["登录", "支付"]);
    expect(section).toContain("【增量分析模式】");
    expect(section).toContain("- 登录");
    expect(section).toContain("必须且只能包含上述功能");
    expect(incrementalScopeSection(undefined)).toBeNull();
    expect(incrementalScopeSection([])).toBeNull();
  });

  it("requires affected features to keep full scenario coverage in incremental mode", () => {
    const section = incrementalScopeSection(["登录"]);
    expect(section).toContain("同等完整");
    expect(section).toContain("不得少于全量分析的覆盖");
    expect(section).toContain("不适用「每个功能保留最关键的 1-5 个场景」的约束");
    expect(section).toContain("happy/edge/error 全部类别逐一检查");
  });

  it("sends the continuity section in the gateway prompt when previous names are given", async () => {
    vi.stubEnv("AI_API_KEY", "key");
    vi.stubEnv("AI_MODEL", "test-model");
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    }));
    await analyzeWithAI([{ path: "lib/a.ts", content: "1: x" }], { message: "m", files: [] }, { previousFeatureNames: ["登录", "支付"] });
    const userMessage = bodies[0].messages.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain("【上一版规格的功能清单");
    expect(userMessage).toContain("- 支付");

    bodies.length = 0;
    await analyzeWithAI([{ path: "lib/a.ts", content: "1: x" }], { message: "m", files: [] }, { affectedFeatureNames: ["登录"] });
    expect(bodies[0].messages[1].content).toContain("【增量分析模式】");
    bodies.length = 0;
    await analyzeWithAI([{ path: "lib/a.ts", content: "1: x" }], { message: "m", files: [] });
    expect(bodies[0].messages[1].content).not.toContain("【上一版规格的功能清单");
    expect(bodies[0].messages[1].content).not.toContain("【增量分析模式】");
    vi.unstubAllGlobals();
  });
});

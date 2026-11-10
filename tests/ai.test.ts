import { describe, expect, it, vi } from "vitest";
import { analyzeBehavioralGroup, analyzeWithAI, behavioralDescribePrompt, behavioralJudgmentPrompt, capEvidence, featureContinuitySection, incrementalScopeSection, parseAnalysisContent, parseBehavioralDescriptions, specAnchoringSection } from "../lib/ai";

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

  it("promotes the result alias to outcome when the model drops the canonical key", () => {
    // 生产事故复刻（run 174–179）：模型把「结果」直译为 result 键，49/49 场景缺 outcome
    const drifted = structuredClone(result) as { features: Array<{ scenarios: Array<Record<string, unknown>> }> };
    const scenario = drifted.features[0].scenarios[0];
    delete scenario.outcome;
    scenario.result = "进入 Chandler 授权";
    const parsed = parseAnalysisContent(JSON.stringify(drifted));
    expect(parsed.features[0].scenarios[0].outcome).toBe("进入 Chandler 授权");
    expect((parsed.features[0].scenarios[0] as unknown as Record<string, unknown>).result).toBeUndefined();
  });

  it("strips invisible characters from evidence paths before the allow-set check", () => {
    // W0-2 superset 重跑实测：模型在合法 diff 路径前后带零宽字符，精确匹配被误杀
    const drifted = structuredClone(result);
    drifted.features[0].scenarios[0].evidence[0].path = "\u200bapp/auth/login/route.ts ";
    const parsed = parseAnalysisContent(JSON.stringify(drifted));
    expect(parsed.features[0].scenarios[0].evidence[0].path).toBe("app/auth/login/route.ts");
  });

  it("keeps an explicit outcome over the result alias and still rejects scenarios missing both", () => {
    const both = structuredClone(result) as { features: Array<{ scenarios: Array<Record<string, unknown>> }> };
    both.features[0].scenarios[0].result = "别名不应覆盖显式字段";
    expect(parseAnalysisContent(JSON.stringify(both)).features[0].scenarios[0].outcome).toBe("进入 Chandler 授权");
    const neither = structuredClone(result) as { features: Array<{ scenarios: Array<Record<string, unknown>> }> };
    delete neither.features[0].scenarios[0].outcome;
    expect(() => parseAnalysisContent(JSON.stringify(neither))).toThrow();
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
    expect(section).toContain("与全量分析相当");
    expect(section).toContain("3-8 个场景");
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

describe("spec wording anchoring (P0 noise control)", () => {
  const anchored = [{
    name: "统一登录",
    summary: "使用 Chandler OAuth",
    scenarios: [
      { reference: "HP-1", context: "未登录用户", action: "点击登录", outcome: "进入 Chandler 授权", category: "happy" },
      { reference: "ER-1", context: "state 校验失败", action: "回调处理", outcome: "跳转登录错误页", category: "error" },
    ],
  }];

  it("renders the previous spec text with verbatim-reuse rules", () => {
    const section = specAnchoringSection(anchored);
    expect(section).toContain("【上一版规格全文——行为未变的条目必须逐字沿用】");
    expect(section).toContain("功能：统一登录（简介：使用 Chandler OAuth）");
    expect(section).toContain("- HP-1｜happy｜情境：未登录用户｜操作：点击登录｜结果：进入 Chandler 授权");
    expect(section).toContain("同义改写、调整语序、增删标点都算违规");
  });

  it("returns null without usable previous spec content", () => {
    expect(specAnchoringSection(undefined)).toBeNull();
    expect(specAnchoringSection([])).toBeNull();
    expect(specAnchoringSection([{ name: "空功能", summary: "s", scenarios: [] }])).toBeNull();
  });

  it("truncates oversized spec text within the character budget", () => {
    const huge = Array.from({ length: 400 }, (_, index) => ({
      name: `功能${index}`,
      summary: "s",
      scenarios: Array.from({ length: 5 }, (_, scenarioIndex) => ({
        reference: `HP-${scenarioIndex + 1}`,
        context: "很长的情境描述".repeat(30),
        action: "很长的操作描述".repeat(30),
        outcome: "很长的结果描述".repeat(30),
        category: "happy",
      })),
    }));
    const section = specAnchoringSection(huge, 24_000)!;
    expect(section.length).toBeLessThan(30_000);
    expect(section).toContain("已截断");
    expect(section).toContain("逐字沿用规则");
  });

  it("sends the anchoring section instead of the names-only continuity section", async () => {
    vi.stubEnv("AI_API_KEY", "key");
    vi.stubEnv("AI_MODEL", "test-model");
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    }));
    await analyzeWithAI([{ path: "lib/a.ts", content: "1: x" }], { message: "m", files: [] }, { previousFeatureNames: ["登录"], previousSpec: anchored });
    const userMessage = bodies[0].messages.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain("【上一版规格全文——行为未变的条目必须逐字沿用】");
    expect(userMessage).toContain("- HP-1｜happy｜情境：未登录用户");
    expect(userMessage).not.toContain("【上一版规格的功能清单");
    vi.unstubAllGlobals();
  });
});

describe("behavioral enumeration two-step extraction (W0-9)", () => {
  const targets = [
    { path: "superset/utils/oauth2.py", patch: "@@ -408,7 +408,9 @@\n+        if is_guest:\n+            return None", contextBlocks: [{ startLine: 400, endLine: 412, content: "400: ...\n408: if is_guest:\n409:     return None" }] },
    { path: "superset/commands/database/create.py", patch: "@@ -95,7 +95,16 @@ def run(self):\n+            except (OAuth2RedirectError, MissingOAuth2TokenError):\n+                pass", contextBlocks: [{ startLine: 95, endLine: 115, content: "95: database = self._create_database()\n96: try:\n97:     add_permissions(database)\n98: except (OAuth2RedirectError, MissingOAuth2TokenError):\n99:     pass" }] },
  ];
  const change = { message: "behavioral window", committedAt: "", url: "", files: [{ path: targets[0].path, status: "modified", patch: targets[0].patch }] };

  it("describe prompt demands per-hunk before/after and forbids judgment language", () => {
    const prompt = behavioralDescribePrompt(targets, change);
    expect(prompt).toContain("superset/utils/oauth2.py");
    expect(prompt).toContain("每个变更块都必须有一条复述");
    expect(prompt).toContain("只复述事实，不要判断是否值得写、是否用户可感知");
    expect(prompt).toContain("except (OAuth2RedirectError, MissingOAuth2TokenError)");
  });

  it("describe parse keeps only known paths and drops malformed entries", () => {
    const content = JSON.stringify({ files: [
      { path: "superset/utils/oauth2.py", changes: [{ hunk: "408-424", before: "访客请求失败后自动重试授权", after: "访客请求直接返回错误，不再进入重试" }] },
      { path: "未知名/文件.ts", changes: [{ hunk: "1-2", before: "a", after: "b" }] },
      { path: "superset/utils/oauth2.py", changes: [{ hunk: "x", before: 42 }] },
    ] });
    const parsed = parseBehavioralDescriptions(content, targets);
    expect(parsed).toEqual([{ path: "superset/utils/oauth2.py", hunk: "408-424", before: "访客请求失败后自动重试授权", after: "访客请求直接返回错误，不再进入重试" }]);
  });

  it("judge prompt carries the inclusion bias, reviewed fallback, control-flow hint, and no escape hatch", () => {
    const descriptions = [{ path: "superset/utils/oauth2.py", hunk: "408-424", before: "访客请求失败后自动重试授权", after: "访客请求直接返回错误" }];
    const prompt = behavioralJudgmentPrompt(descriptions, targets, ["嵌入式 SDK"], change);
    expect(prompt).toContain("拿不准 → 一律输出场景");
    expect(prompt).toContain("宁可多写一条，不可漏写一条");
    expect(prompt).toContain("kind=reviewed");
    expect(prompt).toContain("不再向上抛出");
    expect(prompt).toContain("禁止用 result 等同义键名");
    expect(prompt).toContain("嵌入式 SDK");
    expect(prompt).not.toContain("不要为它输出场景");
  });

  it("parses behavioral output tolerantly: missing product/release injected, empty features legal", async () => {
    vi.stubEnv("AI_MODEL", "test-model");
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_BASE_URL", "https://gateway.test");
    const describePayload = { choices: [{ message: { content: JSON.stringify({ files: [{ path: "superset/utils/oauth2.py", changes: [{ hunk: "408-424", before: "旧：访客请求失败后自动重试授权", after: "新：访客请求直接返回错误" }] }] }) } }], usage: {} };
    const judgePayload = { choices: [{ message: { content: JSON.stringify({ changes: [{ featureName: "审计", kind: "added", description: "d", userImpact: "", evidence: [{ path: "superset/utils/oauth2.py", startLine: 409 }] }], features: [] }) } }], usage: {} };
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body).messages[1].content);
      const payload = bodies.length === 1 ? describePayload : judgePayload;
      return new Response(JSON.stringify(payload), { status: 200 });
    }));
    const parsed = await analyzeBehavioralGroup(targets, ["嵌入式 SDK"], change, { runId: 1, accountId: null, chargeComponent: "main" });
    // 两次调用：先复述后判定；判定 prompt 携带复述结果
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("改前");
    expect(bodies[1]).toContain("宁可多写一条");
    // product/release 缺省注入（合并层只取分区首趟，占位不进规格），features 空数组合法
    expect(parsed.product.description).toContain("superset/utils/oauth2.py");
    expect(parsed.features).toEqual([]);
    expect(parsed.changes[0].evidence[0].path).toBe("superset/utils/oauth2.py");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});


import { describe, expect, it } from "vitest";
import { capEvidence, parseAnalysisContent } from "../lib/ai";

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

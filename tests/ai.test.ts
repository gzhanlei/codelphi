import { describe, expect, it } from "vitest";
import { parseAnalysisContent } from "../lib/ai";

const result = {
  release: { title: "改进登录", summary: "接入统一登录。" },
  changes: [{ featureName: "认证", kind: "changed", description: "使用 OAuth", userImpact: "统一账号", evidence: [{ path: "app/auth/login/route.ts", startLine: 1 }] }],
  features: [{ name: "认证", summary: "统一登录", scenarios: [{ reference: "HP-1", context: "未登录用户", action: "点击登录", outcome: "进入 Chandler 授权", category: "happy", evidence: [{ path: "app/auth/login/route.ts", startLine: 1 }] }] }],
};

describe("AI analysis output", () => {
  it("parses strict JSON and fenced responses", () => {
    expect(parseAnalysisContent(JSON.stringify(result)).release.title).toBe("改进登录");
    expect(parseAnalysisContent(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``).features[0].scenarios[0].reference).toBe("HP-1");
  });

  it("rejects unsupported scenario categories", () => {
    const invalid = structuredClone(result);
    invalid.features[0].scenarios[0].category = "unknown";
    expect(() => parseAnalysisContent(JSON.stringify(invalid))).toThrow();
  });
});

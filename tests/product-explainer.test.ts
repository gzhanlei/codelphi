import { describe, expect, it } from "vitest";
import { buildExplainerMarkdown } from "../lib/product-explainer";

const overview = {
  slug: "radar",
  description: "产品知识中心",
  headline: "产品知识中心",
  headlineSource: "generated",
  headlineEvidence: [{ path: "lib/analysis.ts", startLine: 185 }],
  freshness: "Spec v8 · abcdef1",
  analysisLabel: "最近分析成功",
  capabilities: [{ id: 1, name: "登录|统一认证", summary: "OAuth", source: "generated" as const, scenarioCount: 3, href: "/products/radar?view=spec&feature=1" }],
  changes: [{ id: 1, releaseId: 8, kind: "changed" as const, entityType: "scenario" as const, featureName: "规格", scenarioReference: "HP-1", summary: "结果更明确", before: {}, after: {} }],
  changeStats: { added: 0, removed: 0, changed: 1 },
  latestRelease: { id: 8, title: "规格改进", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 },
  trust: { featureCount: 1, scenarioCount: 3, manualFeatureCount: 0, manualScenarioCount: 1, evidencePathCount: 2, specVersionId: 8 },
};

describe("product explainer", () => {
  it("exports product knowledge without architecture diagrams or repository evidence", () => {
    const markdown = buildExplainerMarkdown(overview);
    expect(markdown).toContain("# 产品知识中心 {#summary}");
    expect(markdown).toContain("@answer scope=\"Spec v8 · abcdef1 · 最近分析成功\"");
    expect(markdown).toContain("@meta locale=zh-CN");
    expect(markdown).toContain("登录\\|统一认证");
    expect(markdown).toContain("结果更明确");
    expect(markdown).toContain("{#change-1}");
    expect(markdown).toContain("@facts id=spec-facts");
    expect(markdown).not.toContain("@diagram architecture");
    expect(markdown).not.toContain("{#architecture}");
    expect(markdown).not.toContain("repo_url=");
  });

  it("handles manual capabilities and empty changes", () => {
    const markdown = buildExplainerMarkdown({ ...overview, changes: [], capabilities: [{ ...overview.capabilities[0], source: "manual" as const }] });
    expect(markdown).toContain("人工维护");
    expect(markdown).toContain("登录\\|统一认证 | 3 | 人工维护");
    expect(markdown).toContain("本次分析未发现规格行为变化");
    expect(markdown).toContain("| 规格版本 | 8 |");
  });

  it("handles a missing release and spec version", () => {
    const markdown = buildExplainerMarkdown({ ...overview, latestRelease: undefined as never, changes: [], trust: { ...overview.trust, specVersionId: null } });
    expect(markdown).toContain("| 规格版本 | 未生成 |");
    expect(markdown).not.toContain("架构");
  });
});

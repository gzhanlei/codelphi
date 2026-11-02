import { describe, expect, it } from "vitest";
import { buildExplainerMarkdown } from "../lib/product-explainer";

const overview = {
  slug: "radar",
  headline: "产品知识中心",
  freshness: "Spec v8 · abcdef1",
  analysisLabel: "最近分析成功",
  capabilities: [{ id: 1, name: "登录|统一认证", summary: "OAuth", source: "generated" as const, scenarioCount: 3, href: "/products/radar?view=spec&feature=1" }],
  changes: [{ id: 1, releaseId: 8, kind: "changed" as const, entityType: "scenario" as const, featureName: "规格", scenarioReference: "HP-1", summary: "结果更明确", before: {}, after: {} }],
  latestRelease: { id: 8, title: "规格改进", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 },
  trust: { featureCount: 1, scenarioCount: 3, manualFeatureCount: 0, manualScenarioCount: 1, evidencePathCount: 2, specVersionId: 8 },
  architecture: { id: 5, specVersionId: 8, revision: "abcdef123456", status: "accepted", errorMessage: null, href: "/api/architecture/5" },
};

describe("product explainer", () => {
  it("reuses the overview and accepted architecture spec", () => {
    const markdown = buildExplainerMarkdown(overview, { includeArchitecture: true, repositoryUrl: "https://github.com/gzhanlei/radar" });
    expect(markdown).toContain("# 产品知识中心 {#summary}");
    expect(markdown).toContain("@answer scope=\"Spec v8 · abcdef1 · 最近分析成功\"");
    expect(markdown).toContain("@meta locale=zh-CN repo_url=https://github.com/gzhanlei/radar repo_revision=abcdef123456");
    expect(markdown).toContain("@diagram architecture source=architecture.json");
    expect(markdown).toContain("登录\\|统一认证");
    expect(markdown).toContain("结果更明确");
    expect(markdown).toContain("{#change-1}");
    expect(markdown).toContain("@facts id=spec-facts");
  });

  it("handles missing architecture, manual capabilities and empty changes", () => {
    const markdown = buildExplainerMarkdown({ ...overview, architecture: undefined, changes: [], capabilities: [{ ...overview.capabilities[0], source: "manual" as const }] }, { includeArchitecture: true, repositoryUrl: "https://github.com/gzhanlei/radar" });
    expect(markdown).not.toContain("@diagram architecture");
    expect(markdown).toContain("尚未生成架构文档");
    expect(markdown).toContain("人工维护");
    expect(markdown).toContain("登录\\|统一认证 | 3 | 人工维护");
    expect(markdown).toContain("本次分析未发现规格行为变化");
    expect(markdown).toContain("repo_revision=abcdef123456");
    expect(markdown).toContain("| 规格版本 | 8 |");
  });

  it("rejects a failed diagram even when inclusion is requested", () => {
    const markdown = buildExplainerMarkdown({ ...overview, architecture: { ...overview.architecture, status: "failed" } }, { includeArchitecture: true });
    expect(markdown).not.toContain("@diagram architecture");
  });

  it("handles a missing release and an empty repository URL", () => {
    const markdown = buildExplainerMarkdown({ ...overview, latestRelease: undefined as never, changes: [], architecture: undefined, trust: { ...overview.trust, specVersionId: null } }, { includeArchitecture: true, repositoryUrl: "" });
    expect(markdown).toContain("尚未生成架构文档");
    expect(markdown).toContain("| 规格版本 | 未生成 |");
    expect(markdown).not.toContain("repo_url=");
  });

  it("falls back to the release SHA for an empty architecture revision", () => {
    const markdown = buildExplainerMarkdown({ ...overview, architecture: { ...overview.architecture, revision: "" } }, { includeArchitecture: false, repositoryUrl: "https://github.com/gzhanlei/radar" });
    expect(markdown).toContain("repo_revision=abcdef123456");
  });

  it("handles failed architecture without an error message", () => {
    const markdown = buildExplainerMarkdown({ ...overview, architecture: { ...overview.architecture, status: "failed", errorMessage: null } }, { includeArchitecture: false });
    expect(markdown).toContain("架构状态：failed");
    expect(markdown).not.toContain("@diagram architecture");
  });

  it("omits the diagram when no accepted architecture exists", () => {
    const markdown = buildExplainerMarkdown({ ...overview, architecture: { ...overview.architecture, status: "failed", errorMessage: "Layout failed", href: undefined } }, { includeArchitecture: false });
    expect(markdown).not.toContain("@diagram architecture");
    expect(markdown).toContain("Layout failed");
  });
});

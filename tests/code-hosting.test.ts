import { describe, expect, it } from "vitest";
import { getCodeHostingAdapter, githubCodeHostingAdapter, resolveAnalysisTarget } from "../lib/code-hosting";
import { createRemoteSourceIndex } from "../lib/remote-source-index";

describe("code hosting provider registry", () => {
  it("resolves GitHub for explicit and legacy default calls", () => {
    expect(getCodeHostingAdapter()).toBe(githubCodeHostingAdapter);
    expect(getCodeHostingAdapter("github").provider).toBe("github");
    expect(githubCodeHostingAdapter.parseRepository("gzhanlei/codelphi")).toEqual({ owner: "gzhanlei", name: "codelphi", defaultBranch: "main" });
    expect(githubCodeHostingAdapter.repositoryUrl({ owner: "gzhanlei", name: "codelphi" })).toBe("https://github.com/gzhanlei/codelphi");
  });

  it("passes persisted provider, access and product identity to an analysis target", () => {
    const persisted = resolveAnalysisTarget({ productId: 7, productSlug: "7", productName: "Product 7", connectionId: null, organizationId: 1, provider: "github" });
    expect(persisted.adapter.provider).toBe("github");
    expect(persisted.access).toEqual({ connectionId: null, organizationId: 1 });
    expect(persisted.product).toEqual({ id: 7, slug: "7", name: "Product 7" });
    const explicit = resolveAnalysisTarget({ productId: 8, productSlug: "shop", productName: "Shop", connectionId: 9, organizationId: 4, provider: "github" });
    expect(explicit.access).toEqual({ connectionId: 9, organizationId: 4 });
    expect(explicit.product).toEqual({ id: 8, slug: "shop", name: "Shop" });
  });

  if (false) {
    // @ts-expect-error persisted provider and organization are required inside analysis
    resolveAnalysisTarget({ productId: 7, productSlug: "7", productName: "Product 7", connectionId: null });
  }

  it("explains only GitHub 404 registration failures for the selected credential", () => {
    const explain = githubCodeHostingAdapter.explainRegistrationError!;
    expect(explain("GitHub API 404", { connectionId: 9, organizationId: 7 })).toBeNull();
    expect(explain(new Error("GitHub API 500"), { connectionId: 9, organizationId: 7 })).toBeNull();
    expect(explain(new Error("GitHub API 404: Not Found"), { connectionId: 9, organizationId: 7 })?.message).toContain("尚未授权该仓库");
    expect(explain(new Error("GitHub API 404: Not Found"), { connectionId: null, organizationId: 7 })?.message).toContain("服务器 Token");
  });

  it("exposes a GitHub source backend through the provider contract", () => {
    const backend = getCodeHostingAdapter("github").createSourceBackend({ token: "test-token" });
    expect(backend.kind).toBe("github_api");
  });

  it("exposes a GitLab source backend through the provider contract (C2 接入层)", () => {
    const backend = getCodeHostingAdapter("gitlab").createSourceBackend({ token: "glpat-test" });
    expect(backend.kind).toBe("gitlab_api");
  });

  it.each(["gitee", "gitea"])("keeps %s as an explicit future extension", (provider) => {
    expect(() => getCodeHostingAdapter(provider)).toThrow(`${provider} 的分析适配尚未开放`);
  });

  it("uses the provider registry only when no source backend is injected", async () => {
    await expect(createRemoteSourceIndex(
      { owner: "gitee", repo: "example", revision: "sha" },
      { provider: "gitee", access: {}, scopeRoots: [] },
    )).rejects.toThrow("gitee 的分析适配尚未开放");
  });
});

import { describe, expect, it } from "vitest";
import { getCodeHostingAdapter, githubCodeHostingAdapter, resolveAnalysisTarget } from "../lib/code-hosting";
import { createRemoteSourceIndex } from "../lib/remote-source-index";

describe("code hosting provider registry", () => {
  it("resolves GitHub for explicit and legacy default calls", () => {
    expect(getCodeHostingAdapter()).toBe(githubCodeHostingAdapter);
    expect(getCodeHostingAdapter("github").provider).toBe("github");
    expect(githubCodeHostingAdapter.parseRepository("gzhanlei/radar")).toEqual({ owner: "gzhanlei", name: "radar", defaultBranch: "main" });
    expect(githubCodeHostingAdapter.repositoryUrl({ owner: "gzhanlei", name: "radar" })).toBe("https://github.com/gzhanlei/radar");
  });

  it("resolves provider, access and product defaults for an analysis target", () => {
    const fallback = resolveAnalysisTarget({ productId: 7, connectionId: null });
    expect(fallback.adapter.provider).toBe("github");
    expect(fallback.access).toEqual({ connectionId: null, organizationId: 1 });
    expect(fallback.product).toEqual({ id: 7, slug: "7", name: "Product 7" });
    const explicit = resolveAnalysisTarget({ productId: 8, productSlug: "shop", productName: "Shop", connectionId: 9, organizationId: 4, provider: "github" });
    expect(explicit.access).toEqual({ connectionId: 9, organizationId: 4 });
    expect(explicit.product).toEqual({ id: 8, slug: "shop", name: "Shop" });
  });

  it("exposes a GitHub source backend through the provider contract", () => {
    const backend = getCodeHostingAdapter("github").createSourceBackend({ token: "test-token" });
    expect(backend.kind).toBe("github_api");
  });

  it.each(["gitee", "gitlab", "gitea"])("keeps %s as an explicit future extension", (provider) => {
    expect(() => getCodeHostingAdapter(provider)).toThrow(`${provider} 的分析适配尚未开放`);
  });

  it("uses the provider registry only when no source backend is injected", async () => {
    await expect(createRemoteSourceIndex(
      { owner: "gitee", repo: "example", revision: "sha" },
      { provider: "gitee", access: {}, scopeRoots: [] },
    )).rejects.toThrow("gitee 的分析适配尚未开放");
  });
});

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductPage from "../app/products/[slug]/[product]/page";
import { publicDemoSlugs } from "@/lib/env";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess } from "@/lib/product-access";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { getSessionUser } from "@/lib/session";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));
vi.mock("@/lib/public-demo", () => ({ resolvePublicDemoProduct: vi.fn(async () => null) }));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("@/lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/demo-shell", () => ({ DemoShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/analyze-button", () => ({ AnalyzeButton: ({ slug }: { slug: string }) => createElement("button", { "data-analyze": slug }, "立即分析") }));
vi.mock("@/components/analysis-feedback-button", () => ({ AnalysisFeedbackButton: () => null }));
vi.mock("@/components/remove-product-button", () => ({ RemoveProductButton: () => null }));
vi.mock("@/components/product-navigation", () => ({
  ProductTabs: ({ productBase }: { productBase: string }) => createElement("span", { "data-base": productBase }),
  ProductView: ({ canEdit }: { canEdit: boolean }) => createElement("div", { "data-can-edit": String(canEdit) }),
  RepositoryLink: () => null,
  RunStatus: () => null,
}));

const demo = { id: 9, slug: "reporadar", name: "Radar", organizationId: 3, organizationSlug: "default" };

const details = {
  product: { id: 9, slug: "reporadar", name: "Radar", description: "demo", descriptionSource: "generated", descriptionEvidence: null },
  repository: { owner: "gzhanlei", name: "radar", defaultBranch: "main" },
  features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], latestRun: undefined,
} as never;

async function renderPage(org: string, slug: string) {
  return renderToStaticMarkup(await ProductPage({ params: Promise.resolve({ slug: org, product: slug }), searchParams: Promise.resolve({}) }));
}

describe("public demo product page (canonical org-qualified route)", () => {
  beforeEach(() => {
    vi.mocked(getProductDetails).mockResolvedValue(details);
  });
  afterEach(() => { delete process.env.PUBLIC_DEMO_SLUGS; });

  it("renders anonymously for a demo product resolved under the URL org", async () => {
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(demo);
    const html = await renderPage("default", "reporadar");
    expect(html).toContain(">Radar</h1>");
    expect(html).toContain('data-can-edit="true"');
    expect(html).not.toContain("data-remove-product");
    expect(resolvePublicDemoProduct).toHaveBeenCalledWith("default", "reporadar");
    // demo 详情按 (org, slug) 精确解析，不再有全局 slug 兜底
    expect(getProductDetails).toHaveBeenCalledWith("reporadar", 3);
  });

  it("links demo view tabs through the canonical org-qualified base path", async () => {
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(demo);
    const html = await renderPage("default", "reporadar");
    expect(html).toContain('data-base="/products/default/reporadar"');
  });

  it("hides the settings tab from anonymous demo visitors", async () => {
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(demo);
    const html = await renderPage("default", "reporadar");
    expect(html).not.toContain("?view=settings");
  });

  it("still redirects anonymous visitors for non-demo slugs", async () => {
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(null);
    await expect(renderPage("default", "other-product")).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("falls back to demo for signed-in users without access to a demo slug", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "someone-else", email: "x@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(demo);
    const html = await renderPage("default", "reporadar");
    expect(html).toContain('data-can-edit="true"');
  });

  it("keeps 404 for signed-in users without access to a non-demo slug", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "someone-else", email: "x@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    vi.mocked(resolvePublicDemoProduct).mockResolvedValue(null);
    await expect(renderPage("default", "other-product")).rejects.toThrow("NOT_FOUND");
  });

  it("keeps 404 when the access resolution lands on a different workspace than the URL org", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "product-member", email: "x@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue({
      product: { id: 9, slug: "reporadar", name: "Radar", description: "", organizationId: 5 },
      organization: { id: 5, slug: "another-workspace", name: "Another", role: "viewer" },
      role: "viewer",
      via: "product",
    });
    await expect(renderPage("default", "reporadar")).rejects.toThrow("NOT_FOUND");
  });
});

describe("publicDemoSlugs", () => {
  it("parses comma-separated slugs, lowercases them, and defaults to empty", () => {
    process.env.PUBLIC_DEMO_SLUGS = " Reporadar , demo-two ,";
    expect([...publicDemoSlugs()]).toEqual(["reporadar", "demo-two"]);
    delete process.env.PUBLIC_DEMO_SLUGS;
    expect(publicDemoSlugs().size).toBe(0);
  });
});

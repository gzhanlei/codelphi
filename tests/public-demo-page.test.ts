import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductPage from "../app/products/[slug]/page";
import { publicDemoSlugs } from "@/lib/env";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("@/lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("@/lib/product-rename", () => ({ findProductByOldSlug: vi.fn(async () => null) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/demo-shell", () => ({ DemoShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/analyze-button", () => ({ AnalyzeButton: ({ slug }: { slug: string }) => createElement("button", { "data-analyze": slug }, "立即分析") }));
vi.mock("@/components/analysis-feedback-button", () => ({ AnalysisFeedbackButton: () => null }));
vi.mock("@/components/remove-product-button", () => ({ RemoveProductButton: () => null }));
vi.mock("@/components/product-navigation", () => ({
  ProductTabs: () => null,
  ProductView: ({ canEdit }: { canEdit: boolean }) => createElement("div", { "data-can-edit": String(canEdit) }),
  RepositoryLink: () => null,
  RunStatus: () => null,
}));

const details = {
  product: { id: 9, slug: "reporadar", name: "Radar", description: "demo", descriptionSource: "generated", descriptionEvidence: null },
  repository: { owner: "gzhanlei", name: "radar", defaultBranch: "main" },
  features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], latestRun: undefined,
} as never;

async function renderPage(slug: string) {
  return renderToStaticMarkup(await ProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
}

describe("public demo product page", () => {
  beforeEach(() => {
    process.env.PUBLIC_DEMO_SLUGS = "reporadar";
    vi.mocked(getProductDetails).mockResolvedValue(details);
  });
  afterEach(() => { delete process.env.PUBLIC_DEMO_SLUGS; });

  it("renders anonymously for an allowlisted slug without org scoping", async () => {
    const html = await renderPage("reporadar");
    expect(html).toContain("<h1>Radar<button");
    expect(html).toContain('data-can-edit="true"');
    expect(html).not.toContain("data-remove-product");
  });

  it("loads product details without an organization filter in demo mode", async () => {
    await renderPage("reporadar");
    expect(getProductDetails).toHaveBeenCalledWith("reporadar");
  });

  it("still redirects anonymous visitors for non-allowlisted slugs", async () => {
    await expect(renderPage("other-product")).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("falls back to demo for signed-in users without access to an allowlisted slug", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "someone-else", email: "x@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    const html = await renderPage("reporadar");
    expect(html).toContain('data-can-edit="true"');
  });

  it("keeps 404 for signed-in users without access to a non-allowlisted slug", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "someone-else", email: "x@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    await expect(renderPage("other-product")).rejects.toThrow("NOT_FOUND");
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

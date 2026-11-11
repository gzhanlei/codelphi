import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductPage from "../app/products/[slug]/[product]/page";
import { notFound } from "next/navigation";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess, type ProductAccess } from "@/lib/product-access";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("@/lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("@/lib/public-demo", () => ({ resolvePublicDemoProduct: vi.fn(async () => null) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/demo-shell", () => ({ DemoShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/analyze-button", () => ({ AnalyzeButton: () => null }));
vi.mock("@/components/analysis-feedback-button", () => ({ AnalysisFeedbackButton: ({ slug }: { slug: string }) => createElement("span", { "data-analysis-feedback": slug }, "提交反馈") }));
vi.mock("@/components/product-navigation", () => ({ ProductTabs: () => null, ProductView: () => null, RepositoryLink: () => null, RunStatus: () => null }));
vi.mock("@/components/remove-product-button", () => ({ RemoveProductButton: ({ slug }: { slug: string }) => createElement("button", { "data-remove-product": slug }, "移除产品") }));

function access(overrides: Partial<ProductAccess>): ProductAccess {
  return {
    product: { id: 2, slug: "namedict", name: "NameDict", description: "词典", organizationId: 7 },
    organization: { id: 7, slug: "workspace", name: "Workspace", role: "owner" },
    role: "owner",
    via: "organization",
    ...overrides,
  };
}

describe("product page removal action (canonical org-qualified route)", () => {
  beforeEach(() => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({}));
    vi.mocked(getProductDetails).mockResolvedValue({
      product: { id: 2, slug: "namedict", name: "NameDict", description: "词典", descriptionSource: "manual", descriptionEvidence: null },
      repository: { owner: "gzhanlei", name: "namedict", defaultBranch: "main" },
      features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], latestRun: undefined,
    } as never);
  });

  async function renderPage(view?: string) {
    return renderToStaticMarkup(await ProductPage({ params: Promise.resolve({ slug: "workspace", product: "namedict" }), searchParams: Promise.resolve(view ? { view } : {}) }));
  }

  it("authenticates against the URL org segment, not the cookie workspace", async () => {
    await renderPage();
    expect(requireProductAccess).toHaveBeenCalledWith(expect.objectContaining({ sub: "user" }), "namedict", "viewer", expect.anything(), undefined, "workspace");
  });

  it("shows removal to workspace owners and editors", async () => {
    expect(await renderPage()).toContain('data-remove-product="namedict"');
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "editor", organization: { id: 7, slug: "workspace", name: "Workspace", role: "editor" } }));
    expect(await renderPage()).toContain('data-remove-product="namedict"');
  });

  it("does not show removal to viewers", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "viewer", organization: { id: 7, slug: "workspace", name: "Workspace", role: "viewer" } }));
    expect(await renderPage()).not.toContain("data-remove-product");
  });

  it("does not show removal to product-scoped editors", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "editor", via: "product", organization: { id: 7, slug: "workspace", name: "Workspace", role: "editor" } }));
    expect(await renderPage()).not.toContain("data-remove-product");
  });

  it("calls notFound when access is denied or the product is missing", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
    vi.mocked(requireProductAccess).mockResolvedValue(access({}));
    vi.mocked(getProductDetails).mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(2);
  });

  it("shows the product description on every view (header consolidation, clamped)", async () => {
    expect(await renderPage()).toContain("词典");
    expect(await renderPage("spec")).toContain("词典");
  });

  it("shows diagnostics only for a failed analysis, not legacy architecture state", async () => {
    const details = await getProductDetails("namedict", 7);
    if (!details) throw new Error("fixture missing");
    vi.mocked(getProductDetails).mockResolvedValue({ ...details, latestRun: { status: "failed" } } as never);
    expect(await renderPage()).toContain("data-analysis-feedback");
    vi.mocked(getProductDetails).mockResolvedValue({ ...details, latestRun: { status: "succeeded" }, architecture: { id: 6, specVersionId: 3, revision: "abc", status: "failed", errorMessage: "failed" } } as never);
    expect(await renderPage()).not.toContain("data-analysis-feedback");
  });
});

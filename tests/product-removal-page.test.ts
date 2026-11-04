import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductPage from "../app/products/[slug]/page";
import { notFound } from "next/navigation";
import { getProductDetails } from "@/lib/product-details";
import { requireOrganization } from "@/lib/organizations";

vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }) }));
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/organizations", () => ({ requireOrganization: vi.fn() }));
vi.mock("@/lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/analyze-button", () => ({ AnalyzeButton: () => null }));
vi.mock("@/components/analysis-feedback-button", () => ({ AnalysisFeedbackButton: ({ slug }: { slug: string }) => createElement("span", { "data-analysis-feedback": slug }, "提交反馈") }));
vi.mock("@/components/product-navigation", () => ({ ProductTabs: () => null, ProductView: () => null, RepositoryLink: () => null, RunStatus: () => null }));
vi.mock("@/components/remove-product-button", () => ({ RemoveProductButton: ({ slug }: { slug: string }) => createElement("button", { "data-remove-product": slug }, "移除产品") }));

describe("product page removal action", () => {
  beforeEach(() => {
    vi.mocked(requireOrganization).mockResolvedValue({ id: 7, slug: "workspace", name: "Workspace", role: "owner" });
    vi.mocked(getProductDetails).mockResolvedValue({
      product: { id: 2, slug: "namedict", name: "NameDict", description: "词典", descriptionSource: "manual", descriptionEvidence: null },
      repository: { owner: "gzhanlei", name: "namedict", defaultBranch: "main" },
      features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], latestRun: undefined, architecture: undefined,
    } as never);
  });

  async function renderPage() {
    return renderToStaticMarkup(await ProductPage({ params: Promise.resolve({ slug: "namedict" }), searchParams: Promise.resolve({}) }));
  }

  it("shows removal to owners and editors", async () => {
    expect(await renderPage()).toContain('data-remove-product="namedict"');
    vi.mocked(requireOrganization).mockResolvedValue({ id: 7, slug: "workspace", name: "Workspace", role: "editor" });
    expect(await renderPage()).toContain('data-remove-product="namedict"');
  });

  it("does not show removal to viewers", async () => {
    vi.mocked(requireOrganization).mockResolvedValue({ id: 7, slug: "workspace", name: "Workspace", role: "viewer" });
    expect(await renderPage()).not.toContain("data-remove-product");
  });

  it("calls notFound for a missing or cross-workspace product", async () => {
    vi.mocked(getProductDetails).mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("shows diagnostics for either a failed analysis or failed architecture", async () => {
    const details = await getProductDetails("namedict", 7);
    if (!details) throw new Error("fixture missing");
    vi.mocked(getProductDetails).mockResolvedValue({ ...details, latestRun: { status: "failed" } } as never);
    expect(await renderPage()).toContain("data-analysis-feedback");
    vi.mocked(getProductDetails).mockResolvedValue({ ...details, latestRun: { status: "succeeded" }, architecture: { id: 6, specVersionId: 3, revision: "abc", status: "failed", errorMessage: "failed" } } as never);
    expect(await renderPage()).toContain("data-analysis-feedback");
    vi.mocked(getProductDetails).mockResolvedValue({ ...details, latestRun: { status: "succeeded" }, architecture: { id: 6, specVersionId: 3, revision: "abc", status: "accepted", errorMessage: null } } as never);
    expect(await renderPage()).not.toContain("data-analysis-feedback");
  });
});

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductPage from "../app/products/[slug]/[product]/page";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess, type ProductAccess } from "@/lib/product-access";
import { loadProductAnalysisMode } from "@/lib/analysis-executor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));
vi.mock("@/lib/ui-locale-server", () => ({ resolveUiLocale: async () => "zh-CN" }));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("@/lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("@/lib/public-demo", () => ({ resolvePublicDemoProduct: vi.fn(async () => null), readPublicDemoCache: vi.fn(async () => null) }));
// 设置视图里会读库的三个函数换成替身：这里只验证页面把它们接对了。
vi.mock("@/lib/analysis-executor", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/analysis-executor")>()), loadProductAnalysisMode: vi.fn() }));
vi.mock("@/lib/analysis-trigger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/analysis-trigger")>()), listProductRepositoryTriggers: vi.fn(async () => []) }));
vi.mock("@/lib/product-members", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/product-members")>()), listProductMembers: vi.fn(async () => ({ organizationMembers: [], productMembers: [], invitations: [] })) }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/components/analyze-button", () => ({ AnalyzeButton: () => null }));
vi.mock("@/components/analysis-feedback-button", () => ({ AnalysisFeedbackButton: () => null }));
vi.mock("@/components/product-navigation", () => ({ ProductTabs: () => null, ProductView: () => null, RepositoryLink: () => null, RunStatus: () => null }));
vi.mock("@/components/remove-product-button", () => ({ RemoveProductButton: () => null }));

const access: ProductAccess = {
  product: { id: 2, slug: "namedict", name: "NameDict", description: "词典", organizationId: 7 },
  organization: { id: 7, slug: "workspace", name: "Workspace", role: "owner" },
  role: "owner",
  via: "organization",
};

/** 「分析方式」里选中的那一个单选项。 */
function selected(html: string): string | null {
  return html.match(/<input[^>]*name="product-analysis-executor"[^>]*>/g)?.find((tag) => tag.includes('checked=""'))?.match(/value="([a-z]+)"/)?.[1] ?? null;
}

async function renderPage(view?: string) {
  return renderToStaticMarkup(await ProductPage({ params: Promise.resolve({ slug: "workspace", product: "namedict" }), searchParams: Promise.resolve(view ? { view } : {}) }));
}

describe("the settings view of a product", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireProductAccess).mockResolvedValue(access);
    vi.mocked(getProductDetails).mockResolvedValue({
      product: { id: 2, slug: "namedict", name: "NameDict", description: "词典", descriptionSource: "manual", descriptionEvidence: null },
      repository: { owner: "gzhanlei", name: "namedict", defaultBranch: "main" },
      features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], latestRun: undefined,
    } as never);
  });

  it("shows how the product is analysed and, without a workspace model, why server-side analysis cannot be chosen", async () => {
    vi.mocked(loadProductAnalysisMode).mockResolvedValue({ executor: "client", modelConfigured: false });
    const html = await renderPage("settings");
    expect(loadProductAnalysisMode).toHaveBeenCalledWith(2, expect.any(Function));
    expect(html).toContain("分析方式");
    expect(html).toContain("要先在设置页的「模型配置」里填好工作区自己的模型");
    expect(selected(html)).toBe("client");
  });

  it("offers server-side analysis once the workspace has a model", async () => {
    vi.mocked(loadProductAnalysisMode).mockResolvedValue({ executor: "server", modelConfigured: true });
    const html = await renderPage("settings");
    expect(html).toContain("分析方式");
    expect(html).not.toContain("要先在设置页的「模型配置」里填好工作区自己的模型");
    expect(selected(html)).toBe("server");
  });

  it("does not ask anywhere but the settings view", async () => {
    await renderPage();
    expect(loadProductAnalysisMode).not.toHaveBeenCalled();
  });
});

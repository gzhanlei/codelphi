import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const getSessionUser = vi.fn();
const loadPublicDemoProduct = vi.fn();

vi.mock("../lib/session", () => ({ getSessionUser: () => getSessionUser() }));
vi.mock("../lib/public-demo", () => ({ loadPublicDemoProduct: () => loadPublicDemoProduct() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));

describe("login page public demo entry", () => {
  it("renders the demo link and all five anonymous exports when a public demo exists", async () => {
    getSessionUser.mockResolvedValue(null);
    loadPublicDemoProduct.mockResolvedValue({ slug: "codelphi", name: "CoDelphi" });
    const LoginPage = (await import("../app/login/page")).default;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("不想登录？先看公开演示");
    expect(html).toContain('href="/products/codelphi"');
    expect(html).toContain("/api/products/codelphi/spec.json");
    expect(html).toContain("/api/products/codelphi/export/tests?format=gherkin");
    expect(html).toContain("/api/products/codelphi/export/tests?format=markdown");
    expect(html).toContain("/api/products/codelphi/progress-summary?days=30");
    expect(html).toContain("/api/products/codelphi/explainer");
  });

  it("omits the demo entry when no public demo product is configured", async () => {
    getSessionUser.mockResolvedValue(null);
    loadPublicDemoProduct.mockResolvedValue(null);
    const LoginPage = (await import("../app/login/page")).default;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain("不想登录");
    expect(html).toContain("使用 Chandler 登录");
  });
});

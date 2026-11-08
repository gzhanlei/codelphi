import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isDashboardProductPending, ProductGrid, ReleaseTimeline, timelineDate, type DashboardProduct } from "../components/dashboard-lists";

vi.mock("../components/analysis-status-refresh", async (importOriginal) => ({
  ...await importOriginal<typeof import("../components/analysis-status-refresh")>(),
  ProductListRefresh: () => null,
}));

const product: DashboardProduct = {
  id: 1,
  slug: "new-product",
  name: "New Product",
  description: "Evidence-backed product",
  featureCount: 0,
  releaseCount: 0,
  analysisStatus: "running",
};

describe("dashboard product readiness", () => {
  it("waits only for active analysis, never for architecture generation", () => {
    expect(isDashboardProductPending(product)).toBe(true);
    expect(isDashboardProductPending({ ...product, analysisStatus: "queued" })).toBe(true);
    expect(isDashboardProductPending({ ...product, analysisStatus: "succeeded" })).toBe(false);
  });

  it("does not leave failed or intentionally unstarted products polling forever", () => {
    expect(isDashboardProductPending({ ...product, analysisStatus: "failed" })).toBe(false);
    expect(isDashboardProductPending({ ...product, analysisStatus: null })).toBe(false);
  });

  it("renders a non-link pending card with explicit waiting text", () => {
    const html = renderToStaticMarkup(createElement(ProductGrid, { products: [product] }));
    expect(html).toContain("分析中，请稍候");
    expect(html).toContain("aria-disabled=\"true\"");
    expect(html).toContain("class=\"product-icon\">N</div>");
    expect(html).not.toContain("href=\"/products/new-product\"");
    expect(html).not.toContain("Evidence-backed product");
  });

  it("turns the card into a link as soon as analysis succeeds", () => {
    const ready = { ...product, analysisStatus: "succeeded" };
    const html = renderToStaticMarkup(createElement(ProductGrid, { products: [ready] }));
    expect(html).toContain("href=\"/products/new-product\"");
    expect(html).toContain("Evidence-backed product");
    expect(html).not.toContain("分析中，请稍候");
    expect(html).not.toContain("aria-disabled=\"true\"");
  });

  it("keeps failure details reachable instead of showing a permanent waiting state", () => {
    const failed = { ...product, analysisStatus: "failed" };
    const html = renderToStaticMarkup(createElement(ProductGrid, { products: [failed] }));
    expect(html).toContain("href=\"/products/new-product\"");
    expect(html).not.toContain("分析中，请稍候");
  });

  it("renders useful empty states", () => {
    expect(renderToStaticMarkup(createElement(ProductGrid, { products: [] }))).toContain("还没有接入产品");
    expect(renderToStaticMarkup(createElement(ReleaseTimeline, { releases: [] }))).toContain("完成第一次代码分析后");
  });
});

describe("timeline dates", () => {
  it("shows the year only for releases outside the current year", () => {
    const now = new Date();
    expect(timelineDate(new Date(now.getFullYear(), 0, 9))).not.toContain("2024");
    expect(timelineDate(new Date(2024, 10, 8))).toContain("2024年");
  });
});

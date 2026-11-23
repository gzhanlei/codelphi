import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductTabs, ProductView, RepositoryLink } from "../components/product-navigation";
import { buildProductOverview } from "../lib/product-overview";

describe("repository links", () => {
  it("renders the provider repository URL and default branch", () => {
    const html = renderToStaticMarkup(createElement(RepositoryLink, { repository: { provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" } }));
    expect(html).toContain('href="https://github.com/gzhanlei/codelphi"');
    expect(html).toContain("gzhanlei/codelphi");
    expect(html).toContain("main");
  });

  it("keeps legacy repositories on GitHub and handles a missing repository", () => {
    expect(renderToStaticMarkup(createElement(RepositoryLink, { repository: { owner: "gzhanlei", name: "codelphi", defaultBranch: "main" } }))).toContain("https://github.com/gzhanlei/codelphi");
    expect(renderToStaticMarkup(createElement(RepositoryLink, {}))).toBe("");
    expect(() => renderToStaticMarkup(createElement(RepositoryLink, { repository: { provider: "", owner: "gzhanlei", name: "codelphi", defaultBranch: "main" } }))).toThrow();
  });
});

describe("product tabs", () => {
  const base = { productBase: "/products/default/codelphi", featureCount: 3, releaseCount: 5 };

  it("builds tab links from the canonical org-qualified base path", () => {
    const html = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "spec" }));
    expect(html).toContain('href="/products/default/codelphi"');
    expect(html).toContain('href="/products/default/codelphi?view=changes"');
  });

  it("shows the settings tab only when allowed", () => {
    const withSettings = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "changes", showSettings: true }));
    expect(withSettings).toContain("?view=settings");
    expect(withSettings).toContain("设置");
    const withoutSettings = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "changes" }));
    expect(withoutSettings).not.toContain("设置");
  });

  it("marks the active view", () => {
    const html = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "settings", showSettings: true }));
    expect(html).toContain('href="/products/default/codelphi?view=settings"');
  });

  it("always shows the use cases tab, with a count only when journeys exist (migration 083)", () => {
    const withCount = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "journeys", journeyCount: 7 }));
    expect(withCount).toContain('href="/products/default/codelphi?view=journeys"');
    expect(withCount).toContain("使用场景<span>7</span>");
    // 入口不因数据为空被隐藏；未生成时只是不带计数
    const bare = renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "overview", journeyCount: 0 }));
    expect(bare).toContain('href="/products/default/codelphi?view=journeys"');
    expect(bare).toContain("使用场景</a>");
    expect(renderToStaticMarkup(createElement(ProductTabs, { ...base, view: "journeys", locale: "en" }))).toContain("Use cases");
  });

  it("dispatches the journeys view to the use cases view with its honest empty state", () => {
    const overview = buildProductOverview({ productBase: base.productBase, product: { id: 1, slug: "codelphi", name: "CoDelphi", description: "" }, features: [], scenarios: [], releases: [], behaviorChanges: [] });
    const html = renderToStaticMarkup(createElement(ProductView, { view: "journeys", productSlug: "codelphi", productBase: base.productBase, features: [], scenarios: [], releases: [], changes: [], behaviorChanges: [], overview }));
    expect(html).toContain("典型使用场景");
    expect(html).toContain("data-use-cases-empty");
    expect(html).toContain("尚无功能规格");
  });
});

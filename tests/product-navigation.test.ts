import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductTabs, RepositoryLink } from "../components/product-navigation";

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
});

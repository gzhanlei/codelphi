import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RepositoryLink } from "../components/product-navigation";

describe("repository links", () => {
  it("renders the provider repository URL and default branch", () => {
    const html = renderToStaticMarkup(createElement(RepositoryLink, { repository: { provider: "github", owner: "gzhanlei", name: "radar", defaultBranch: "main" } }));
    expect(html).toContain('href="https://github.com/gzhanlei/radar"');
    expect(html).toContain("gzhanlei/radar");
    expect(html).toContain("main");
  });

  it("keeps legacy repositories on GitHub and handles a missing repository", () => {
    expect(renderToStaticMarkup(createElement(RepositoryLink, { repository: { owner: "gzhanlei", name: "radar", defaultBranch: "main" } }))).toContain("https://github.com/gzhanlei/radar");
    expect(renderToStaticMarkup(createElement(RepositoryLink, {}))).toBe("");
    expect(() => renderToStaticMarkup(createElement(RepositoryLink, { repository: { provider: "", owner: "gzhanlei", name: "radar", defaultBranch: "main" } }))).toThrow();
  });
});

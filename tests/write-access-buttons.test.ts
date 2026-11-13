import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnalyzeButton } from "../components/analyze-button";
import { OverviewPublishButton } from "../components/overview-publish-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("write-action buttons honor effective write access (设计 §11)", () => {
  it("anonymous demo visitors render no analyze entry at all (登录引导集中在顶栏)", () => {
    const html = renderToStaticMarkup(createElement(AnalyzeButton, { slug: "radar", writeAccess: "demo" }));
    expect(html).toBe("");
  });

  it("logged-in readonly members get a disabled secondary button with the permission named", () => {
    const html = renderToStaticMarkup(createElement(AnalyzeButton, { slug: "radar", writeAccess: "readonly" }));
    expect(html).toContain("disabled");
    expect(html).toContain("需编辑权限");
    expect(html).toContain("只读权限");
    expect(html).not.toContain("primary-button");
  });

  it("editors keep the primary analyze button", () => {
    const html = renderToStaticMarkup(createElement(AnalyzeButton, { slug: "radar" }));
    expect(html).toContain("primary-button");
    expect(html).not.toContain("disabled");
  });

  it("publish entry degrades the same way", () => {
    const demo = renderToStaticMarkup(createElement(OverviewPublishButton, { slug: "radar", releaseId: 8, releaseTitle: "v1", features: [], writeAccess: "demo" }));
    expect(demo).toBe("");
    const readonly = renderToStaticMarkup(createElement(OverviewPublishButton, { slug: "radar", releaseId: 8, releaseTitle: "v1", features: [], writeAccess: "readonly" }));
    expect(readonly).toContain("disabled");
    expect(readonly).toContain("需编辑权限");
    const edit = renderToStaticMarkup(createElement(OverviewPublishButton, { slug: "radar", releaseId: 8, releaseTitle: "v1", features: [] }));
    expect(edit).toContain("primary-button");
    expect(edit).toContain(">发布产品<");
  });
});

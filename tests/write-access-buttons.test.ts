import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnalyzeButton } from "../components/analyze-button";
import { OverviewPublishButton } from "../components/overview-publish-dialog";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

describe("write-action buttons honor effective write access (设计 §11)", () => {
  it("anonymous demo visitors get a login link instead of a write button", () => {
    const html = renderToStaticMarkup(createElement(AnalyzeButton, { slug: "radar", writeAccess: "demo" }));
    expect(html).toContain("登录后可分析");
    expect(html).toContain('href="/login"');
    // 登录链接不可能发出写请求；不得渲染真实分析按钮
    expect(html).not.toContain("primary-button");
    expect(html).toContain("只读演示");
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
    expect(demo).toContain("登录后可发布");
    expect(demo).toContain('href="/login"');
    const readonly = renderToStaticMarkup(createElement(OverviewPublishButton, { slug: "radar", releaseId: 8, releaseTitle: "v1", features: [], writeAccess: "readonly" }));
    expect(readonly).toContain("disabled");
    expect(readonly).toContain("需编辑权限");
    const edit = renderToStaticMarkup(createElement(OverviewPublishButton, { slug: "radar", releaseId: 8, releaseTitle: "v1", features: [] }));
    expect(edit).toContain("primary-button");
    expect(edit).toContain(">发布产品<");
  });
});

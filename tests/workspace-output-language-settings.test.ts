import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { WorkspaceOutputLanguageSettings } = await import("../components/workspace-output-language-settings");

describe("workspace output language settings", () => {
  it("renders both language options with the current one checked", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceOutputLanguageSettings, { canEdit: true, current: "en" }));
    expect(html).toContain("English");
    expect(html).toContain("中文");
    expect(html).toContain('value="en"');
    expect(html).toContain("checked");
    expect(html).toContain("默认输出语言");
  });

  it("renders the English interface copy when the ui locale is en", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceOutputLanguageSettings, { canEdit: true, current: "zh-CN", locale: "en" }));
    expect(html).toContain("Default output language for new repositories");
    expect(html).not.toContain("新仓库默认输出语言");
    expect(html).toContain("Feature specs, scenarios and release notes will be generated in Simplified Chinese");
  });

  it("hides the panel from viewers", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceOutputLanguageSettings, { canEdit: false, current: "zh-CN" }))).toBe("");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const setOutputLanguage = vi.hoisted(() => vi.fn(async () => "updated" as const));
vi.mock("../lib/product-client", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/product-client")>(), setOutputLanguage }));

const { ProductOutputLanguageSettings } = await import("../components/product-output-language-settings");

describe("product output language settings", () => {
  it("renders both options with the current language selected and warns about the full rebuild", () => {
    const html = renderToStaticMarkup(createElement(ProductOutputLanguageSettings, { slug: "radar", current: "zh-CN", canEdit: true }));
    expect(html).toContain("输出语言");
    expect(html).toContain('value="en"');
    expect(html).toContain("English");
    expect(html).toContain("全量重建");
  });

  it("hides the panel from viewers", () => {
    expect(renderToStaticMarkup(createElement(ProductOutputLanguageSettings, { slug: "radar", current: "zh-CN", canEdit: false }))).toBe("");
  });
});

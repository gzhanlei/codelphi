import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const setAnalysisExecutor = vi.hoisted(() => vi.fn(async () => "updated" as const));
vi.mock("../lib/product-client", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/product-client")>(), setAnalysisExecutor }));
const { ProductAnalysisExecutorSettings } = await import("../components/product-analysis-executor-settings");

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ProductAnalysisExecutorSettings, props as never));
/** 那个单选项的整个标签（React 不按书写顺序输出属性，所以先取标签再找属性）。 */
const tag = (page: string, value: string) => page.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
const checked = (page: string, value: string) => / checked=""/.test(tag(page, value));
const disabled = (page: string, value: string) => / disabled=""/.test(tag(page, value));

describe("the analysis-method panel in a product's settings", () => {
  it("offers both ways with the current one selected, and explains what each means", () => {
    const page = html({ slug: "radar", current: "client", modelConfigured: true, canEdit: true, locale: "zh-CN" });
    expect(page).toContain("06");
    expect(page).toContain("分析方式");
    expect(page).toContain("客户端分析");
    expect(page).toContain("服务端分析");
    expect(checked(page, "client")).toBe(true);
    expect(disabled(page, "server")).toBe(false);
    expect(page).toContain("源码不离开你的电脑");
    expect(page).toContain("CoDelphi 不替你付模型费用");
  });

  it("does not let the user pick server-side analysis while the workspace has no model, and says where to configure one", () => {
    const page = html({ slug: "radar", current: "client", modelConfigured: false, canEdit: true, locale: "zh-CN" });
    expect(disabled(page, "server")).toBe(true);
    expect(page).toContain("要先在设置页的「模型配置」里填好工作区自己的模型");
    expect(page).toContain('href="/settings"');
    expect(page).toMatch(/<button[^>]*disabled=""/);
  });

  it("keeps a product that already runs on the server selected there, with the warning, when the model is missing", () => {
    const page = html({ slug: "radar", current: "server", modelConfigured: false, canEdit: true, locale: "zh-CN" });
    expect(checked(page, "server")).toBe(true);
    expect(page).toContain("要先在设置页的「模型配置」里填好工作区自己的模型");
  });

  it("hides the panel from viewers", () => {
    expect(html({ slug: "radar", current: "client", modelConfigured: true, canEdit: false, locale: "zh-CN" })).toBe("");
  });
});

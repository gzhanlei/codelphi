import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { refresh, useStateMock } = vi.hoisted(() => ({ refresh: vi.fn(), useStateMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useState: useStateMock.mockImplementation((initial: unknown) => [false, vi.fn()]) }));
const fetchMock = vi.hoisted(() => vi.fn(async () => new Response(null, { status: 303 })));
vi.stubGlobal("fetch", fetchMock);

const { LanguageSwitcher } = await import("../components/language-switcher");

describe("language switcher", () => {
  it("renders both self-named options with the current one marked", () => {
    const html = renderToStaticMarkup(createElement(LanguageSwitcher, { locale: "en" }));
    expect(html).toContain("中文");
    expect(html).toContain("English");
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("posts the chosen locale with the current window path and refreshes", async () => {
    vi.stubGlobal("window", { location: { pathname: "/settings", search: "?view=settings" } } as unknown as Window & typeof globalThis);
    const element = LanguageSwitcher({ locale: "zh-CN" }) as React.ReactElement<{ children: Array<React.ReactElement<{ "data-locale": string; onClick: () => Promise<void> }>> }>;
    const enButton = element.props.children.find((child) => child?.props?.["data-locale"] === "en")!;
    await enButton.props.onClick();
    expect(fetchMock).toHaveBeenCalledWith("/api/ui-locale", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ locale: "en", redirectTo: "/settings?view=settings" }),
    }));
    expect(refresh).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

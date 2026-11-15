import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { useStateMock } = vi.hoisted(() => ({ useStateMock: vi.fn() }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useState: useStateMock.mockImplementation((initial: unknown) => [false, vi.fn()]) }));
const { LanguageSwitcher } = await import("../components/language-switcher");

describe("language switcher", () => {
  it("renders both self-named options with the current one marked", () => {
    const html = renderToStaticMarkup(createElement(LanguageSwitcher, { locale: "en" }));
    expect(html).toContain("中文");
    expect(html).toContain("English");
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("writes the locale cookie and reloads the page (deterministic switch)", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/login", search: "", protocol: "https:", reload },
      document: {} as { cookie: string; cookieValue?: string },
    } as unknown as Window & typeof globalThis & { document: { cookie: string; cookieValue?: string } });
    const documentMock = (window as unknown as { document: { cookie: string; cookieValue?: string } }).document;
    Object.defineProperty(documentMock, "cookie", { set(value: string) { documentMock.cookieValue = value; }, get() { return documentMock.cookieValue ?? ""; }, configurable: true });
    vi.stubGlobal("document", documentMock);
    const element = LanguageSwitcher({ locale: "zh-CN" }) as React.ReactElement<{ children: Array<React.ReactElement<{ "data-locale": string; onClick: () => void }>> }>;
    const enButton = element.props.children.find((child) => child?.props?.["data-locale"] === "en")!;
    enButton.props.onClick();
    expect(documentMock.cookie).toContain("codelphi_locale=en");
    expect(documentMock.cookie).toContain("max-age=31536000");
    expect(documentMock.cookie).toContain("Secure");
    expect(reload).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

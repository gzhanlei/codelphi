import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getSessionUser = vi.fn();
const loadPublicDemoProduct = vi.fn();
const resolveTurnstileSiteKey = vi.fn(async () => "");

vi.mock("../lib/session", () => ({ getSessionUser: () => getSessionUser() }));
vi.mock("../lib/public-demo", () => ({ loadPublicDemoProduct: () => loadPublicDemoProduct() }));
vi.mock("../lib/turnstile-site-key", () => ({ resolveTurnstileSiteKey: () => resolveTurnstileSiteKey() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("../lib/ui-locale-server", () => ({ resolveUiLocale: async () => "zh-CN" }));

describe("自建登录页（Chandler 密码通道表单）", () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue(null);
    loadPublicDemoProduct.mockResolvedValue(null);
    resolveTurnstileSiteKey.mockResolvedValue("");
    vi.unstubAllEnvs();
  });

  it("渲染账号/密码表单、注册入口与 Chandler 授权页回退入口", async () => {
    const LoginPage = (await import("../app/login/page")).default;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("auth-form");
    expect(html).toContain("邮箱或用户名");
    expect(html).toContain("密码");
    expect(html).toContain("登录");
    expect(html).toContain('href="/register"');
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain("使用 Chandler 登录");
  });

  it("登录表单与公开演示入口可同屏渲染", async () => {
    loadPublicDemoProduct.mockResolvedValue({ slug: "codelphi", name: "CoDelphi" });
    const LoginPage = (await import("../app/login/page")).default;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("auth-form");
    expect(html).toContain("不想登录？先看公开演示");
    expect(html).toContain('href="/products/codelphi"');
    expect(html).toContain("/api/products/codelphi/spec.json");
    expect(html).toContain("/api/products/codelphi/export/tests?format=gherkin");
    expect(html).toContain("/api/products/codelphi/export/tests?format=markdown");
    expect(html).toContain("/api/products/codelphi/progress-summary?days=30");
    expect(html).toContain("/api/products/codelphi/explainer");
  });

  it("未配置公开演示时省略演示入口，保留 Chandler 授权页回退", async () => {
    loadPublicDemoProduct.mockResolvedValue(null);
    const LoginPage = (await import("../app/login/page")).default;
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain("不想登录");
    expect(html).toContain("使用 Chandler 登录");
  });

  it("配置 TURNSTILE_SITE_KEY 时渲染 Turnstile 槽位；未配置时不渲染", async () => {
    const LoginPage = (await import("../app/login/page")).default;
    resolveTurnstileSiteKey.mockResolvedValue("");
    const withoutKey = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(withoutKey).not.toContain("turnstile-slot");
    resolveTurnstileSiteKey.mockResolvedValue("0x4AAAAAAGMuYzGBbJ6DwQus");
    const withKey = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(withKey).toContain("turnstile-slot");
    expect(withKey).toContain("人机验证");
  });

  it("已登录用户访问登录页跳回首页", async () => {
    getSessionUser.mockResolvedValue({ sub: "u1" });
    const LoginPage = (await import("../app/login/page")).default;
    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect");
  });
});

describe("自建注册页", () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue(null);
    vi.unstubAllEnvs();
  });

  it("渲染邮箱验证码/密码/昵称表单与返回登录入口", async () => {
    const RegisterPage = (await import("../app/register/page")).default;
    const html = renderToStaticMarkup(await RegisterPage());
    expect(html).toContain("邮箱");
    expect(html).toContain("邮箱验证码");
    expect(html).toContain("发送验证码");
    expect(html).toContain("昵称");
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("8-255 位");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("已阅读并同意 Chandler");
    expect(html).toContain("https://chandler.work/terms");
    expect(html).toContain("https://chandler.work/privacy");
    expect(html).not.toContain("turnstile-slot");
  });

  it("配置 TURNSTILE_SITE_KEY 时注册页也渲染 Turnstile 槽位", async () => {
    resolveTurnstileSiteKey.mockResolvedValue("0x4AAAAAAGMuYzGBbJ6DwQus");
    const RegisterPage = (await import("../app/register/page")).default;
    const html = renderToStaticMarkup(await RegisterPage());
    expect(html).toContain("turnstile-slot");
  });
});

describe("TurnstileWidget 客户端组件", () => {
  it("未配置 sitekey 时渲染为空；配置后渲染验证槽位与 label", async () => {
    const { TurnstileWidget } = await import("../components/turnstile-widget");
    expect(renderToStaticMarkup(createElement(TurnstileWidget, { sitekey: "", action: "login", onToken: () => {} }))).toBe("");
    const html = renderToStaticMarkup(
      createElement(TurnstileWidget, { sitekey: "0x4AAAAAAGMuYzGBbJ6DwQus", action: "register", onToken: () => {}, label: "人机验证" }),
    );
    expect(html).toContain("turnstile-slot");
    expect(html).toContain("人机验证");
  });
});

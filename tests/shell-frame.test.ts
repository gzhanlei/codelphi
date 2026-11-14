import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/app-shell";
import { DemoShell } from "../components/demo-shell";
import type { SessionUser } from "../lib/types";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("../lib/ui-locale-server", () => ({ resolveUiLocale: async () => "zh-CN" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const user: SessionUser = { sub: "u1", email: "u@example.com", name: "小明" };

const renderAppShell = () => AppShell({ user, organizationName: "研发部", children: createElement("p", null, "正文") }).then((element) => renderToStaticMarkup(element));
const renderDemoShell = () => DemoShell({ children: createElement("p", null, "演示正文") }).then((element) => renderToStaticMarkup(element));

describe("AppShell", () => {
  it("renders the shell frame with sidebar navigation", async () => {
    const html = await renderAppShell();
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="main-nav"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/organizations"');
    expect(html).toContain('href="/admin/feedback"');
    expect(html).toContain('href="/integrations"');
    expect(html).toContain('href="https://app.chandler.work"');
  });

  it("renders the topbar with organization name, user display and logout form", async () => {
    const html = await renderAppShell();
    expect(html).toContain('class="environment"');
    expect(html).toContain("研发部");
    expect(html).toContain('class="user-menu"');
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("小明");
  });

  it("renders children inside main content", async () => {
    const html = await renderAppShell();
    expect(html).toContain('class="main-content"');
    expect(html).toContain("<p>正文</p>");
  });
});

describe("DemoShell", () => {
  it("renders the same shell frame in demo variant", async () => {
    const html = await renderDemoShell();
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="main-content"');
    expect(html).toContain("DEMO MODE");
    expect(html).toContain("演示模式");
    expect(html).toContain('href="/login"');
  });

  it("renders children inside main content", async () => {
    const html = await renderDemoShell();
    expect(html).toContain("<p>演示正文</p>");
  });
});

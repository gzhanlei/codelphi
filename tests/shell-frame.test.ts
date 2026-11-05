import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "../components/app-shell";
import { DemoShell } from "../components/demo-shell";
import type { SessionUser } from "../lib/types";

const user: SessionUser = { sub: "u1", email: "u@example.com", name: "小明" };

describe("AppShell", () => {
  const html = renderToStaticMarkup(createElement(AppShell, { user, organizationName: "研发部", children: createElement("p", null, "正文") }));

  it("renders the shell frame with sidebar navigation", () => {
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="main-nav"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/organizations"');
    expect(html).toContain('href="/admin/feedback"');
    expect(html).toContain('href="/integrations"');
    expect(html).toContain('href="https://app.chandler.work"');
  });

  it("renders the topbar with organization name, user display and logout form", () => {
    expect(html).toContain('class="environment"');
    expect(html).toContain("研发部");
    expect(html).toContain('class="user-menu"');
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain("小明");
  });

  it("renders children inside main content", () => {
    expect(html).toContain('class="main-content"');
    expect(html).toContain("<p>正文</p>");
  });
});

describe("DemoShell", () => {
  const html = renderToStaticMarkup(createElement(DemoShell, { children: createElement("p", null, "演示正文") }));

  it("renders the same shell frame in demo variant", () => {
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="brand"');
    expect(html).toContain('class="main-content"');
    expect(html).toContain("DEMO MODE");
    expect(html).toContain("演示模式");
    expect(html).toContain('href="/login"');
  });

  it("renders children inside main content", () => {
    expect(html).toContain("<p>演示正文</p>");
  });
});

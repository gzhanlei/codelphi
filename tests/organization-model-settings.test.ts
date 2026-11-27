import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/organization-model-client", () => ({ saveOrganizationModel: vi.fn(), deleteOrganizationModel: vi.fn(), loadOrganizationModel: vi.fn() }));
const { OrganizationModelSettings } = await import("../components/organization-model-settings");

const saved = { baseUrl: "https://api.kimi.com/coding/v1", model: "k3-256k", verifiedAt: new Date("2026-11-27T10:00:00.000Z"), updatedAt: null };
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(OrganizationModelSettings, props as never));

describe("the model configuration panel on the settings page", () => {
  it("shows what is saved without the key, tells where requests will go, and asks for the three fields", () => {
    const page = html({ initial: saved, canManage: true, locale: "zh-CN" });
    expect(page).toContain("07");
    expect(page).toContain("模型配置");
    expect(page).toContain("CoDelphi 不替你付模型费用");
    expect(page).toContain("k3-256k");
    expect(page).toContain("https://api.kimi.com/coding/v1");
    expect(page).toContain("不再显示");
    expect(page).toContain("模型请求将发往你填的服务地址");
    expect(page.match(/<input/g)).toHaveLength(3);
    expect(page).toMatch(/type="password"/);
    expect(page).toContain("验证并保存");
    expect(page).toContain("删除配置");
    // 表单里没有预填任何 key。
    expect(page).not.toMatch(/sk-kimi-secret/);
  });

  it("says so when nothing is configured", () => {
    expect(html({ initial: null, canManage: true, locale: "zh-CN" })).toContain("还没有配置");
    expect(html({ initial: null, canManage: true, locale: "zh-CN" })).not.toContain("删除配置");
  });

  it("gives viewers the facts but no form and no delete", () => {
    const page = html({ initial: saved, canManage: false, locale: "zh-CN" });
    expect(page).toContain("k3-256k");
    expect(page).not.toMatch(/<input/);
    expect(page).not.toContain("验证并保存");
    expect(page).not.toContain("删除配置");
  });

  it("speaks English when the page does", () => {
    const page = html({ initial: null, canManage: true, locale: "en" });
    expect(page).toContain("Model configuration");
    expect(page).toContain("CoDelphi does not pay model costs for you");
    expect(page).toContain("Verify and save");
  });
});

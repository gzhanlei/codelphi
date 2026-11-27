import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpKeysSettings } from "../components/mcp-keys-settings";

const keys = [
  { id: 1, name: "ChatGPT", keyHint: "abcd1234", scope: "mcp_read" as const, createdBy: "user-1", createdAt: new Date("2026-11-01T00:00:00Z"), revokedAt: null },
  { id: 2, name: "本机发布", keyHint: "ef567890", scope: "snapshot_write" as const, createdBy: "user-1", createdAt: new Date("2026-11-02T00:00:00Z"), revokedAt: null },
];

describe("the MCP keys panel", () => {
  it("names the two kinds of key by what they are used for, and says the client uploads with one of them", () => {
    const html = renderToStaticMarkup(createElement(McpKeysSettings, { initialKeys: keys, canManage: true, locale: "zh-CN" }));
    expect(html).toMatch(/<option[^>]*value="mcp_read"[^>]*>MCP 只读查询<\/option>/);
    // 上传 key 现在是客户端分析（发布、导入、取上下文）用的，不再叫「本地快照导入」。
    expect(html).toMatch(/<option[^>]*value="snapshot_write"[^>]*>客户端分析上传<\/option>/);
    expect(html).not.toContain("本地快照导入");
    expect(html).toContain("供 CoDelphi 客户端上传本机分析的结果");
    expect(html.match(/客户端分析上传/g)).toHaveLength(2);
    // 连接配置和撤销不受文案影响。
    expect(html).toContain("mcpServers");
    expect(html).toContain("撤销");
  });

  it("does not show the key-issuing form to viewers", () => {
    const html = renderToStaticMarkup(createElement(McpKeysSettings, { initialKeys: keys, canManage: false, locale: "en" }));
    expect(html).not.toContain("<select");
    expect(html).toContain("upload what it analysed on your machine");
  });
});

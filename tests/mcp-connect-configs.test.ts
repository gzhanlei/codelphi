import { describe, expect, it } from "vitest";
import { MCP_KEY_PLACEHOLDER, mcpServerConfig, mcpServersJson } from "../lib/mcp/connect-configs";

describe("mcp connect configs", () => {
  it("builds the generic mcpServers shape with the key baked in", () => {
    const json = mcpServersJson("https://codelphi.com/api/mcp", "sk_cd_abcdef");
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const server = parsed.mcpServers.codelphi;
    expect(server.type).toBe("http");
    expect(server.url).toBe("https://codelphi.com/api/mcp");
    expect(server.headers.Authorization).toBe("Bearer sk_cd_abcdef");
  });

  it("falls back to a visible placeholder when no fresh key exists", () => {
    const server = mcpServerConfig("https://codelphi.com/api/mcp", null).mcpServers.codelphi;
    expect(server.headers.Authorization).toBe(`Bearer ${MCP_KEY_PLACEHOLDER}`);
    const blank = mcpServerConfig("https://codelphi.com/api/mcp", "   ").mcpServers.codelphi;
    expect(blank.headers.Authorization).toBe(`Bearer ${MCP_KEY_PLACEHOLDER}`);
  });

  it("keeps output stable (2-space indent, no trailing whitespace surprises)", () => {
    const json = mcpServersJson("http://localhost:3000/api/mcp", "sk_cd_x");
    expect(json).toContain('"mcpServers": {');
    expect(json).not.toMatch(/ $/m);
  });
});

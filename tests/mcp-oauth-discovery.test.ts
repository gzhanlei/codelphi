import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: vi.fn() }) }));
vi.mock("../lib/mcp/api-keys", () => ({ verifyApiKey: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/mcp/oauth", () => ({ verifyAccessToken: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/mcp/server", () => ({ handleMcpRpc: vi.fn() }));

import { GET as protectedResourceRoot } from "../app/.well-known/oauth-protected-resource/route";
import { GET as protectedResourceApiMcp } from "../app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as authorizationServer } from "../app/.well-known/oauth-authorization-server/route";
import { POST as mcpPost } from "../app/api/mcp/route";
import { authorizationServerMetadata, protectedResourceMetadata } from "../lib/mcp/oauth-discovery";

beforeEach(() => {
  process.env.APP_URL = "https://codelphi.example";
});

describe("oauth discovery metadata (RFC 8414 / RFC 9728)", () => {
  it("builds protected resource metadata from APP_URL", () => {
    expect(protectedResourceMetadata()).toEqual({
      resource: "https://codelphi.example/api/mcp",
      authorization_servers: ["https://codelphi.example"],
      scopes_supported: ["mcp:read"],
      resource_documentation: "https://codelphi.example/mcp",
    });
  });

  it("builds authorization server metadata pointing at the existing oauth endpoints", () => {
    const metadata = authorizationServerMetadata();
    expect(metadata.issuer).toBe("https://codelphi.example");
    expect(metadata.authorization_endpoint).toBe("https://codelphi.example/api/mcp/oauth/authorize");
    expect(metadata.token_endpoint).toBe("https://codelphi.example/api/mcp/oauth/token");
    expect(metadata.registration_endpoint).toBe("https://codelphi.example/api/mcp/oauth/register");
    expect(metadata.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.code_challenge_methods).toEqual(["S256"]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
  });

  it("serves both protected-resource derivation paths with identical payloads and CORS", async () => {
    const root = await protectedResourceRoot();
    const pathInserted = await protectedResourceApiMcp();
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual(await pathInserted.json());
    for (const response of [root, pathInserted]) {
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("serves the authorization server metadata route", async () => {
    const response = await authorizationServer();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(authorizationServerMetadata());
  });

  it("401 from the MCP endpoint points connectors at the discovery metadata", async () => {
    const response = await mcpPost(new NextRequest("https://codelphi.example/api/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(401);
    const wwwAuthenticate = response.headers.get("www-authenticate") ?? "";
    expect(wwwAuthenticate).toContain("Bearer");
    expect(wwwAuthenticate).toContain(`resource_metadata="https://codelphi.example/.well-known/oauth-protected-resource/api/mcp"`);
  });
});

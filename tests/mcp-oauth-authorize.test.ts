import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn().mockResolvedValue({ sub: "user-1" }) }));
vi.mock("../lib/organizations", () => ({ currentOrganization: vi.fn().mockResolvedValue({ id: 5 }) }));

import { POST } from "../app/api/mcp/oauth/authorize/route";

const redirectUri = "http://127.0.0.1:53475/callback";

function authorizationRequest(decision: "approve" | "deny") {
  return new NextRequest("https://codelphi.example/api/mcp/oauth/authorize", {
    method: "POST",
    body: new URLSearchParams({
      decision,
      client_id: "mcp_client",
      redirect_uri: redirectUri,
      code_challenge: "challenge",
      state: "state-1",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM mcp_oauth_clients")) {
      return [[{ clientId: "mcp_client", clientName: "Kimi Code", redirectUris: JSON.stringify([redirectUri]) }]];
    }
    if (String(sql).includes("FROM users")) return [[{ id: 11 }]];
    return [{ insertId: 3 }];
  });
});

describe("MCP OAuth authorization redirects", () => {
  it("turns an approved form POST into a GET callback redirect", async () => {
    const response = await POST(authorizationRequest("approve"));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("code")).toMatch(/^[0-9a-f]{48}$/);
    expect(location.searchParams.get("state")).toBe("state-1");
  });

  it("turns a denied form POST into a GET callback redirect", async () => {
    const response = await POST(authorizationRequest("deny"));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-1");
  });
});

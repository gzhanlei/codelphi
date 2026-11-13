import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, registerClient } = vi.hoisted(() => ({ dbExecute: vi.fn(), registerClient: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/mcp/oauth", () => ({ registerClient }));

import { POST } from "../app/api/mcp/oauth/register/route";

describe("mcp oauth dynamic client registration route (RFC 7591)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const request = (body: unknown) =>
    new NextRequest("https://codelphi.example/api/mcp/oauth/register", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  it("registers a client and returns client_id once (201)", async () => {
    registerClient.mockResolvedValue({ clientId: "mcp_00112233445566778899aabb" });
    const response = await POST(request({ client_name: "ChatGPT Connector", redirect_uris: ["https://chatgpt.com/connector_redirect"] }));
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.client_id).toBe("mcp_00112233445566778899aabb");
    expect(data.client_name).toBe("ChatGPT Connector");
    expect(data.redirect_uris).toEqual(["https://chatgpt.com/connector_redirect"]);
    expect(registerClient).toHaveBeenCalledWith(expect.anything(), { clientName: "ChatGPT Connector", redirectUris: ["https://chatgpt.com/connector_redirect"] });
  });

  it("rejects a blank name (invalid_client_metadata)", async () => {
    const response = await POST(request({ client_name: "  ", redirect_uris: ["https://chatgpt.com/cb"] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_client_metadata");
    expect(registerClient).not.toHaveBeenCalled();
  });

  it("rejects missing, non-http and malformed redirect uris (invalid_redirect_uri)", async () => {
    expect((await POST(request({ client_name: "x" }))).status).toBe(400);
    expect((await POST(request({ client_name: "x", redirect_uris: ["javascript:alert(1)"] }))).status).toBe(400);
    expect((await POST(request({ client_name: "x", redirect_uris: ["not-a-url"] }))).status).toBe(400);
    expect((await POST(request({ client_name: "x", redirect_uris: "https://chatgpt.com/cb" }))).status).toBe(400);
    expect((await POST(request({ client_name: "x", redirect_uris: [] }))).status).toBe(400);
    expect(registerClient).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body", async () => {
    const response = await POST(new NextRequest("https://codelphi.example/api/mcp/oauth/register", { method: "POST", body: "not-json", headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(400);
  });
});

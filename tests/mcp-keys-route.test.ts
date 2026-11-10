import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, createApiKey, revokeApiKey, listApiKeys } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  listApiKeys: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/session", () => ({ requireSessionUser: vi.fn(), getSessionUser: vi.fn() }));
vi.mock("../lib/organizations", () => ({ requireOrganization: vi.fn() }));
vi.mock("../lib/mcp/api-keys", () => ({ createApiKey: createApiKey, revokeApiKey: revokeApiKey, listApiKeys: listApiKeys, MCP_KEY_PREFIX: "sk_cd_" }));

import { GET, POST } from "../app/api/mcp-keys/route";
import { POST as revokePOST } from "../app/api/mcp-keys/[id]/route";
import { requireSessionUser } from "../lib/session";
import { requireOrganization } from "../lib/organizations";

const organization = { id: 7, slug: "team", name: "Team", role: "owner" as const };

describe("mcp keys management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireOrganization).mockResolvedValue(organization as never);
    listApiKeys.mockResolvedValue([{ id: 1, name: "ChatGPT", keyHint: "abcd1234", createdBy: "user-1", createdAt: new Date(), revokedAt: null }]);
  });

  it("403 for non-organization members on list and create", async () => {
    vi.mocked(requireOrganization).mockRejectedValue(new Error("forbidden"));
    expect((await GET()).status).toBe(403);
    const created = await POST(new NextRequest("https://codelphi.example/api/mcp-keys", { method: "POST", body: JSON.stringify({ name: "k" }), headers: { "Content-Type": "application/json" } }));
    expect(created.status).toBe(403);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("POST returns the plaintext once and persists via createApiKey", async () => {
    createApiKey.mockResolvedValue({ id: 5, plaintext: "sk_cd_00112233445566778899aabbccddeeff" });
    const response = await POST(new NextRequest("https://codelphi.example/api/mcp-keys", { method: "POST", body: JSON.stringify({ name: "ChatGPT" }), headers: { "Content-Type": "application/json" } }));
    const data = await response.json();
    expect(data.plaintext).toContain("sk_cd_");
    expect(createApiKey).toHaveBeenCalledWith(expect.anything(), { organizationId: 7, name: "ChatGPT", createdBy: "user-1" });
  });

  it("POST rejects a blank name", async () => {
    const response = await POST(new NextRequest("https://codelphi.example/api/mcp-keys", { method: "POST", body: JSON.stringify({ name: "  " }), headers: { "Content-Type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("revoke returns 404 for foreign or already-revoked keys", async () => {
    revokeApiKey.mockResolvedValue(false);
    const response = await revokePOST(new NextRequest("https://codelphi.example/api/mcp-keys/5", { method: "POST" }), { params: Promise.resolve({ id: "5" }) });
    expect(response.status).toBe(404);
    revokeApiKey.mockResolvedValue(true);
    const ok = await revokePOST(new NextRequest("https://codelphi.example/api/mcp-keys/5", { method: "POST" }), { params: Promise.resolve({ id: "5" }) });
    const data = await ok.json();
    expect(data.status).toBe("revoked");
    expect(revokeApiKey).toHaveBeenCalledWith(expect.anything(), 7, 5);
  });
});

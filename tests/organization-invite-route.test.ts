import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/organizations/invite/route";
import { inviteOrganizationMember } from "@/lib/organization-invitations";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";

vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn() }));
vi.mock("@/lib/organizations", () => ({ currentOrganization: vi.fn() }));
vi.mock("@/lib/organization-invitations", () => ({ inviteOrganizationMember: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ execute: vi.fn() })) }));

function inviteRequest(origin: string) {
  const form = new FormData();
  form.set("email", "partner@example.com");
  form.set("role", "editor");
  return new NextRequest(new URL("/organizations/invite", origin), { method: "POST", body: form });
}

describe("organization invite route redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "https://codelphi.com");
    vi.mocked(requireSessionUser).mockResolvedValue({ sub: "owner-sub", email: "owner@example.com" });
    vi.mocked(currentOrganization).mockResolvedValue({ id: 1, slug: "default", name: "Default", role: "owner" });
    vi.mocked(inviteOrganizationMember).mockResolvedValue({ status: "member_added", email: "partner@example.com", role: "editor", emailSent: false });
  });

  it("redirects to the APP_URL origin even when the request host is the proxy target", async () => {
    const response = await POST(inviteRequest("https://localhost:3008"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://codelphi.com/organizations?invited=member_added");
  });

  it("keeps the invitation link and email flag as query parameters", async () => {
    vi.mocked(inviteOrganizationMember).mockResolvedValue({ status: "invitation_pending", email: "new@example.com", role: "viewer", inviteUrl: "https://codelphi.com/invitations/accept?token=abc", emailSent: true });
    const response = await POST(inviteRequest("https://localhost:3008"));
    expect(response.headers.get("location")).toBe("https://codelphi.com/organizations?invited=invitation_pending&inviteUrl=https%3A%2F%2Fcodelphi.com%2Finvitations%2Faccept%3Ftoken%3Dabc&emailSent=true");
  });
});

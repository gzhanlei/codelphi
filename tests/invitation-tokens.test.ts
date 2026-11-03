import { describe, expect, it, vi } from "vitest";
import { acceptOrganizationInvitation, getInvitationByToken, hashInvitationToken, invitationUrl, issueInvitationToken } from "../lib/invitation-tokens";
import { sendInvitationEmail } from "../lib/invitation-email";

function tokenDb() {
  const calls: Array<{ sql: string; parameters: Array<string | number | null> }> = [];
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    calls.push({ sql, parameters });
    if (sql.includes("FROM organization_invitations i JOIN organizations o")) {
      return [[{ id: 12, organization_id: 1, name: "Default Workspace", email: "new@example.com", role: "viewer", status: "pending", expires_at: new Date(Date.now() + 60_000) }]];
    }
    if (sql.includes("SELECT id FROM users WHERE chandler_sub")) return [[{ id: 9 }]];
    return [{ affectedRows: 1 }];
  });
  return { execute, calls };
}

describe("invitation tokens", () => {
  it("issues hashed expiring tokens without exposing the hash in the URL", async () => {
    const db = tokenDb();
    const token = await issueInvitationToken(1, "new@example.com", db.execute);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(invitationUrl(token)).toContain(`/invitations/accept?token=${encodeURIComponent(token)}`);
    expect(invitationUrl(token)).not.toContain(hashInvitationToken(token));
    expect(db.calls[0].parameters[0]).toBe(hashInvitationToken(token));
  });

  it("accepts a valid invitation once with matching email", async () => {
    const db = tokenDb();
    const token = "a".repeat(43);
    expect(await getInvitationByToken(token, db.execute)).toMatchObject({ organizationId: 1, organizationName: "Default Workspace", email: "new@example.com", role: "viewer" });
    await acceptOrganizationInvitation({ sub: "known-sub", email: "new@example.com" }, token, db.execute);
    expect(db.calls.some((call) => call.sql.includes("INSERT INTO organization_members"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("UPDATE organization_invitations SET status = 'accepted'"))).toBe(true);
  });

  it("rejects mismatched email addresses", async () => {
    const db = tokenDb();
    await expect(acceptOrganizationInvitation({ sub: "other", email: "other@example.com" }, "a".repeat(43), db.execute)).rejects.toThrow("invitation_email_mismatch");
  });

  it("sends registration email through Chandler and treats taken emails as already registered", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    expect(await sendInvitationEmail({ to: "new@example.com", organizationName: "Default Workspace", role: "viewer", inviteUrl: "https://example.test/invite" }, fetcher)).toBe(true);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/v1/auth/register/send-code");
    expect(JSON.parse(String(init?.body)).email).toBe("new@example.com");
    expect(await sendInvitationEmail({ to: "known@example.com", organizationName: "Default Workspace", role: "viewer", inviteUrl: "https://example.test/invite" }, vi.fn(async () => new Response("taken", { status: 409 })))).toBe(false);
    await expect(sendInvitationEmail({ to: "new@example.com", organizationName: "Default Workspace", role: "viewer", inviteUrl: "https://example.test/invite" }, vi.fn(async () => new Response("failed", { status: 500 })))).rejects.toThrow("Chandler registration email failed: 500");
  });
});

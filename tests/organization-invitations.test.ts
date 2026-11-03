import { describe, expect, it, vi } from "vitest";
import { claimOrganizationInvitations, inviteOrganizationMember } from "../lib/organization-invitations";

function createInvitationDb() {
  const users = new Map<string, { id: number; sub?: string; email: string }>([["known@example.com", { id: 9, sub: "known-sub", email: "known@example.com" }]]);
  const invitations: Array<{ organizationId: number; email: string; role: string; status: string }> = [];
  const memberships: Array<{ organizationId: number; userId: number; role: string }> = [];
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("SELECT id FROM users WHERE email")) {
      const [email] = parameters as [string];
      return [users.has(email) ? [{ id: users.get(email)!.id }] : []];
    }
    if (sql.includes("INSERT INTO organization_members")) {
      const [organizationId, userId, role] = parameters as [number, number, string];
      memberships.push({ organizationId, userId, role });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("INSERT INTO organization_invitations")) {
      const [organizationId, email, role] = parameters as [number, string, string];
      invitations.push({ organizationId, email, role, status: "pending" });
      return [{ insertId: invitations.length }];
    }
    if (sql.includes("SELECT organization_id, role FROM organization_invitations")) {
      const [email] = parameters as [string];
      return [invitations.filter((invitation) => invitation.email === email && invitation.status === "pending").map((invitation) => ({ organization_id: invitation.organizationId, role: invitation.role }))];
    }
    if (sql.includes("SELECT id FROM users WHERE chandler_sub")) {
      const [sub] = parameters as [string];
      const user = [...users.values()].find((item) => item.sub === sub);
      return [user ? [{ id: user.id }] : []];
    }
    if (sql.includes("UPDATE organization_invitations")) {
      const [organizationId, email] = parameters as [number, string];
      const invitation = invitations.find((item) => item.organizationId === organizationId && item.email === email);
      if (invitation) invitation.status = "accepted";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members")) {
      return [[{ id: 1, slug: "default", name: "Default Workspace", role: "owner" }]];
    }
    return [{}];
  });
  return { execute, users, invitations, memberships };
}

describe("organization invitations", () => {
  it("adds an existing user directly", async () => {
    const db = createInvitationDb();
    const result = await inviteOrganizationMember({ sub: "owner-sub" }, { email: "known@example.com", role: "editor" }, db.execute, { id: 1, slug: "default", name: "Default Workspace", role: "owner" });
    expect(result).toEqual({ status: "member_added", email: "known@example.com", role: "editor", emailSent: false });
    expect(db.memberships).toContainEqual({ organizationId: 1, userId: 9, role: "editor" });
  });

  it("stores a pending invitation and claims it on first login", async () => {
    const db = createInvitationDb();
    expect(await inviteOrganizationMember({ sub: "owner-sub" }, { email: "new@example.com", role: "viewer" }, db.execute, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, async () => false)).toMatchObject({ status: "invitation_pending", email: "new@example.com", role: "viewer", emailSent: false });
    expect(db.invitations[0]).toMatchObject({ organizationId: 1, email: "new@example.com", role: "viewer", status: "pending" });
    const insertCall = db.execute.mock.calls.find((call) => String(call[0]).includes("INSERT INTO organization_invitations"));
    expect(insertCall?.[0]).toContain("SELECT ?, ?, ?, u.id FROM users u WHERE u.chandler_sub = ?");
    expect(insertCall?.[0]).not.toContain("FROM organizations o JOIN users u");
    expect(insertCall?.[1]).toEqual([1, "new@example.com", "viewer", "owner-sub"]);

    const user = { sub: "known-sub", email: "new@example.com" };
    db.users.set("new@example.com", { id: 9, sub: "known-sub", email: "new@example.com" });
    await claimOrganizationInvitations(user, db.execute);
    expect(db.memberships).toContainEqual({ organizationId: 1, userId: 9, role: "viewer" });
    expect(db.invitations[0].status).toBe("accepted");
  });

  it("rejects non-owners before writing invitations", async () => {
    const db = createInvitationDb();
    await expect(inviteOrganizationMember({ sub: "owner-sub" }, { email: "new@example.com", role: "viewer" }, db.execute, { id: 1, slug: "default", name: "Default Workspace", role: "viewer" }, async () => false)).rejects.toThrow("forbidden");
    expect(db.invitations).toHaveLength(0);
  });

  it("rejects invalid emails and non-editor roles", async () => {
    const db = createInvitationDb();
    await expect(inviteOrganizationMember({ sub: "owner-sub" }, { email: "bad", role: "editor" }, db.execute, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, async () => false)).rejects.toThrow();
    await expect(inviteOrganizationMember({ sub: "owner-sub" }, { email: "new@example.com", role: "owner" }, db.execute, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, async () => false)).rejects.toThrow();
  });
});

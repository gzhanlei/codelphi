import { describe, expect, it, vi } from "vitest";
import { hashInvitationToken } from "@/lib/invitation-tokens";
import { acceptProductInvitation, claimProductInvitations, inviteProductMember } from "../lib/product-members";

const OWNER_ORG = { id: 1, slug: "default", name: "Default Workspace", role: "owner" as const };
const PRODUCT = { id: 7, slug: "radar", name: "Radar" };

function createProductInvitationDb() {
  const users = new Map<string, { id: number; sub?: string; email: string }>([["known@example.com", { id: 9, sub: "known-sub", email: "known@example.com" }]]);
  const invitations: Array<{ productId: number; email: string; role: string; status: string; tokenHash?: string }> = [];
  const memberships: Array<{ productId: number; userId: number; role: string }> = [];
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("SELECT id FROM users WHERE email")) {
      const [email] = parameters as [string];
      return [users.has(email) ? [{ id: users.get(email)!.id }] : []];
    }
    if (sql.includes("INSERT INTO product_members")) {
      const [productId, userId, role] = parameters as [number, number, string];
      memberships.push({ productId, userId, role });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("INSERT INTO product_invitations")) {
      const [productId, email, role] = parameters as [number, string, string];
      invitations.push({ productId, email, role, status: "pending" });
      return [{ insertId: invitations.length }];
    }
    if (sql.includes("UPDATE product_invitations") && sql.includes("SET token_hash = ?")) {
      const [tokenHash, productId, email] = parameters as [string, number, string];
      const invitation = invitations.find((item) => item.productId === productId && item.email === email);
      if (invitation) invitation.tokenHash = tokenHash;
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT product_id, role FROM product_invitations")) {
      const [email] = parameters as [string];
      return [invitations.filter((invitation) => invitation.email === email && invitation.status === "pending").map((invitation) => ({ product_id: invitation.productId, role: invitation.role }))];
    }
    if (sql.includes("SELECT id FROM users WHERE chandler_sub")) {
      const [sub] = parameters as [string];
      const user = [...users.values()].find((item) => item.sub === sub);
      return [user ? [{ id: user.id }] : []];
    }
    if (sql.includes("UPDATE product_invitations") && sql.includes("SET status = 'accepted'") && sql.includes("WHERE product_id")) {
      const [productId, email] = parameters as [number, string];
      const invitation = invitations.find((item) => item.productId === productId && item.email === email);
      if (invitation) invitation.status = "accepted";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE product_invitations") && sql.includes("SET status = 'accepted'")) {
      const [tokenHash] = parameters as [string];
      const invitation = invitations.find((item) => item.tokenHash === tokenHash && item.status === "pending");
      if (invitation) invitation.status = "accepted";
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("FROM product_invitations i JOIN products p")) {
      const [tokenHash] = parameters as [string];
      const invitation = invitations.find((item) => item.tokenHash === tokenHash && item.status === "pending");
      return [invitation ? [{ product_id: invitation.productId, slug: PRODUCT.slug, name: PRODUCT.name, email: invitation.email, role: invitation.role, status: invitation.status, expires_at: null }] : []];
    }
    return [{}];
  });
  return { execute, users, invitations, memberships };
}

describe("product invitations", () => {
  it("adds an existing user directly to the product", async () => {
    const db = createProductInvitationDb();
    const result = await inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "known@example.com", role: "editor" }, db.execute);
    expect(result).toEqual({ status: "member_added", email: "known@example.com", role: "editor", emailSent: false });
    expect(db.memberships).toContainEqual({ productId: 7, userId: 9, role: "editor" });
  });

  it("stores a pending invitation, issues a token, and claims it on first login", async () => {
    const db = createProductInvitationDb();
    const result = await inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "new@example.com", role: "viewer" }, db.execute, async () => false);
    expect(result).toMatchObject({ status: "invitation_pending", email: "new@example.com", role: "viewer", emailSent: false });
    expect(db.invitations[0]).toMatchObject({ productId: 7, email: "new@example.com", role: "viewer", status: "pending" });
    expect(db.invitations[0].tokenHash).toBe(hashInvitationToken(result.inviteUrl!.split("token=")[1]));

    const user = { sub: "known-sub", email: "new@example.com" };
    db.users.set("new@example.com", { id: 9, sub: "known-sub", email: "new@example.com" });
    await claimProductInvitations(user, db.execute);
    expect(db.memberships).toContainEqual({ productId: 7, userId: 9, role: "viewer" });
    expect(db.invitations[0].status).toBe("accepted");
  });

  it("rejects non-owners before writing invitations", async () => {
    const db = createProductInvitationDb();
    await expect(inviteProductMember({ sub: "owner-sub" }, { ...OWNER_ORG, role: "editor" }, PRODUCT, { email: "new@example.com", role: "viewer" }, db.execute, async () => false)).rejects.toThrow("forbidden");
    expect(db.invitations).toHaveLength(0);
  });

  it("rejects invalid emails and non-editor roles", async () => {
    const db = createProductInvitationDb();
    await expect(inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "bad", role: "editor" }, db.execute, async () => false)).rejects.toThrow();
    await expect(inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "new@example.com", role: "owner" }, db.execute, async () => false)).rejects.toThrow();
  });

  it("accepts a token invitation for the matching email and lands the member", async () => {
    const db = createProductInvitationDb();
    const result = await inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "new@example.com", role: "editor" }, db.execute, async () => false);
    const token = result.inviteUrl!.split("token=")[1];
    const user = { sub: "known-sub", email: "new@example.com" };
    db.users.set("new@example.com", { id: 9, sub: "known-sub", email: "new@example.com" });
    const accepted = await acceptProductInvitation(user, token, db.execute);
    expect(accepted).toMatchObject({ productId: 7, productSlug: "radar", productName: "Radar", role: "editor" });
    expect(db.memberships).toContainEqual({ productId: 7, userId: 9, role: "editor" });
    expect(db.invitations[0].status).toBe("accepted");
  });

  it("refuses a token invitation opened by a different email", async () => {
    const db = createProductInvitationDb();
    const result = await inviteProductMember({ sub: "owner-sub" }, OWNER_ORG, PRODUCT, { email: "new@example.com", role: "viewer" }, db.execute, async () => false);
    const token = result.inviteUrl!.split("token=")[1];
    db.users.set("new@example.com", { id: 9, sub: "known-sub", email: "new@example.com" });
    await expect(acceptProductInvitation({ sub: "known-sub", email: "other@example.com" }, token, db.execute)).rejects.toThrow("invitation_email_mismatch");
    expect(db.memberships).toHaveLength(0);
  });
});

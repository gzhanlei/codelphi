import { z } from "zod";
import { defaultExecute, type Execute } from "./db";
import { randomToken } from "./oauth";
import { hashInvitationToken, invitationUrl, tokenSchema } from "./invitation-tokens";
import { sendInvitationEmail } from "./invitation-email";
import type { SessionUser } from "./types";
import type { InviteResult } from "./organization-invitations";
import type { Organization } from "./organizations";


export type ProductRole = "editor" | "viewer";

const inviteSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: z.enum(["editor", "viewer"]),
});

export interface ProductSummary {
  id: number;
  slug: string;
  name: string;
}

async function userIdByEmail(email: string, execute: Execute) {
  const [rows] = await execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]) as [Array<{ id: number }>, unknown];
  return rows[0]?.id;
}

export async function inviteProductMember(profile: SessionUser, organization: Organization, product: ProductSummary, input: unknown, execute: Execute, mailer: typeof sendInvitationEmail = sendInvitationEmail): Promise<InviteResult> {
  if (organization.role !== "owner") throw new Error("forbidden");
  const { email, role } = inviteSchema.parse(input);
  const userId = await userIdByEmail(email, execute);
  if (userId) {
    await execute(
      `INSERT INTO product_members (product_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
      [product.id, userId, role],
    );
    return { status: "member_added", email, role, emailSent: false };
  }
  await execute(
    `INSERT INTO product_invitations (product_id, email, role, invited_by)
     SELECT ?, ?, ?, u.id FROM users u WHERE u.chandler_sub = ?
     ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'pending', updated_at = CURRENT_TIMESTAMP(3)`,
    [product.id, email, role, profile.sub],
  );
  const token = await issueProductInvitationToken(product.id, email, execute);
  const inviteUrl = invitationUrl(token);
  const emailSent = await mailer({ to: email, organizationName: product.name, role, inviteUrl });
  return { status: "invitation_pending", email, role, inviteUrl, emailSent };
}

async function issueProductInvitationToken(productId: number, email: string, execute: Execute) {
  const token = randomToken(32);
  await execute(
    `UPDATE product_invitations
     SET token_hash = ?, expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY), status = 'pending', accepted_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE product_id = ? AND email = ?`,
    [hashInvitationToken(token), productId, email],
  );
  return token;
}

export async function claimProductInvitations(profile: SessionUser, execute: Execute = defaultExecute) {
  if (!profile.email) return;
  const [invitations] = await execute(
    "SELECT product_id, role FROM product_invitations WHERE email = ? AND status = 'pending' AND token_hash IS NULL",
    [profile.email],
  ) as [Array<{ product_id: number; role: ProductRole }>, unknown];
  for (const invitation of invitations) {
    const [users] = await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [profile.sub]) as [Array<{ id: number }>, unknown];
    const user = users[0];
    if (!user) throw new Error("Invitation user is not provisioned");
    await execute(
      `INSERT INTO product_members (product_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
      [invitation.product_id, user.id, invitation.role],
    );
    await execute(
      "UPDATE product_invitations SET status = 'accepted', updated_at = CURRENT_TIMESTAMP(3) WHERE product_id = ? AND email = ?",
      [invitation.product_id, profile.email],
    );
  }
}

export interface ProductMemberEntry {
  userId: number;
  displayName: string;
  email: string;
  role: string;
}

export interface ProductInvitationEntry {
  id: number;
  email: string;
  role: ProductRole;
  expiresAt: Date | null;
}

export interface ProductMemberRoster {
  organizationMembers: ProductMemberEntry[];
  productMembers: ProductMemberEntry[];
  invitations: ProductInvitationEntry[];
}

/** 产品设置页成员面板：工作区成员（只读）+ 产品级成员 + 待接受邀请。 */
export async function listProductMembers(productId: number, organizationId: number, execute: Execute = defaultExecute): Promise<ProductMemberRoster> {
  const [orgRows] = await execute(
    `SELECT u.id AS userId, u.display_name AS displayName, COALESCE(u.email, '') AS email, om.role
     FROM organization_members om JOIN users u ON u.id = om.user_id
     WHERE om.organization_id = ? ORDER BY FIELD(om.role, 'owner', 'editor', 'viewer'), u.id`,
    [organizationId],
  ) as [Array<{ userId: number; displayName: string | null; email: string; role: string }>, unknown];
  const [productRows] = await execute(
    `SELECT u.id AS userId, u.display_name AS displayName, COALESCE(u.email, '') AS email, pm.role
     FROM product_members pm JOIN users u ON u.id = pm.user_id
     WHERE pm.product_id = ? ORDER BY pm.role, u.id`,
    [productId],
  ) as [Array<{ userId: number; displayName: string | null; email: string; role: string }>, unknown];
  const [invitationRows] = await execute(
    "SELECT id, email, role, expires_at FROM product_invitations WHERE product_id = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP(3) ORDER BY id",
    [productId],
  ) as [Array<{ id: number; email: string; role: ProductRole; expires_at: Date | null }>, unknown];
  const toEntry = (row: { userId: number; displayName: string | null; email: string; role: string }): ProductMemberEntry => ({
    userId: Number(row.userId),
    displayName: row.displayName ?? "",
    email: row.email,
    role: row.role,
  });
  return {
    organizationMembers: orgRows.map(toEntry),
    productMembers: productRows.map(toEntry),
    invitations: invitationRows.map((row) => ({ id: Number(row.id), email: row.email, role: row.role, expiresAt: row.expires_at })),
  };
}

/** 移除产品级成员；工作区成员的访问来自组织，不可在产品维度移除。 */
export async function removeProductMember(productId: number, organizationId: number, userId: number, execute: Execute = defaultExecute): Promise<"removed" | "organization_member" | "not_member"> {
  const [orgRows] = await execute(
    "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1",
    [organizationId, userId],
  ) as [Array<unknown>, unknown];
  if (orgRows.length > 0) return "organization_member";
  const [result] = await execute("DELETE FROM product_members WHERE product_id = ? AND user_id = ?", [productId, userId]) as [{ affectedRows?: number }, unknown];
  return (result?.affectedRows ?? 0) > 0 ? "removed" : "not_member";
}

/** 取消待接受的产品邀请。 */
export async function cancelProductInvitation(productId: number, invitationId: number, execute: Execute = defaultExecute): Promise<boolean> {
  const [result] = await execute("DELETE FROM product_invitations WHERE id = ? AND product_id = ? AND status = 'pending'", [invitationId, productId]) as [{ affectedRows?: number }, unknown];
  return (result?.affectedRows ?? 0) > 0;
}

export interface ProductInvitation {
  productId: number;
  productSlug: string;
  organizationSlug: string;
  productName: string;
  email: string;
  role: ProductRole;
  status: string;
  expiresAt: Date | null;
}

export async function getProductInvitationByToken(token: string, execute: Execute = defaultExecute): Promise<ProductInvitation | null> {
  const value = tokenSchema.parse(token);
  const [rows] = await execute(
    `SELECT i.product_id, i.email, i.role, i.status, i.expires_at, p.slug, p.name, o.slug AS organization_slug
     FROM product_invitations i JOIN products p ON p.id = i.product_id
     JOIN organizations o ON o.id = p.organization_id
     WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP(3)
     LIMIT 1`,
    [hashInvitationToken(value)],
  ) as [Array<{ product_id: number; slug: string; name: string; organization_slug: string; email: string; role: ProductRole; status: string; expires_at: Date | null }>, unknown];
  const row = rows[0];
  return row ? { productId: row.product_id, productSlug: row.slug, organizationSlug: row.organization_slug, productName: row.name, email: row.email, role: row.role, status: row.status, expiresAt: row.expires_at } : null;
}

export async function acceptProductInvitation(profile: SessionUser, token: string, execute: Execute = defaultExecute) {
  const invitation = await getProductInvitationByToken(token, execute);
  if (!invitation) throw new Error("invitation_invalid");
  if (!profile.email || profile.email.toLowerCase() !== invitation.email) throw new Error("invitation_email_mismatch");
  const [users] = await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [profile.sub]) as [Array<{ id: number }>, unknown];
  const user = users[0];
  if (!user) throw new Error("invitation_user_missing");
  await execute(
    `INSERT INTO product_members (product_id, user_id, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
    [invitation.productId, user.id, invitation.role],
  );
  await execute(
    "UPDATE product_invitations SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE token_hash = ? AND status = 'pending'",
    [hashInvitationToken(token)],
  );
  return invitation;
}

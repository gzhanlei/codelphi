import { z } from "zod";
import { getDb } from "./db";
import { randomToken } from "./oauth";
import { hashInvitationToken, invitationExpiryDate, invitationUrl, tokenSchema } from "./invitation-tokens";
import { sendInvitationEmail } from "./invitation-email";
import type { SessionUser } from "./types";
import type { InviteResult } from "./organization-invitations";
import type { Organization } from "./organizations";

type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;

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
     SET token_hash = ?, expires_at = ?, status = 'pending', accepted_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE product_id = ? AND email = ?`,
    [hashInvitationToken(token), invitationExpiryDate(Date.now()), productId, email],
  );
  return token;
}

export async function claimProductInvitations(profile: SessionUser, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters)) {
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

export interface ProductInvitation {
  productId: number;
  productSlug: string;
  productName: string;
  email: string;
  role: ProductRole;
  status: string;
  expiresAt: Date | null;
}

export async function getProductInvitationByToken(token: string, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters)): Promise<ProductInvitation | null> {
  const value = tokenSchema.parse(token);
  const [rows] = await execute(
    `SELECT i.product_id, i.email, i.role, i.status, i.expires_at, p.slug, p.name
     FROM product_invitations i JOIN products p ON p.id = i.product_id
     WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP(3)
     LIMIT 1`,
    [hashInvitationToken(value)],
  ) as [Array<{ product_id: number; slug: string; name: string; email: string; role: ProductRole; status: string; expires_at: Date | null }>, unknown];
  const row = rows[0];
  return row ? { productId: row.product_id, productSlug: row.slug, productName: row.name, email: row.email, role: row.role, status: row.status, expiresAt: row.expires_at } : null;
}

export async function acceptProductInvitation(profile: SessionUser, token: string, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters)) {
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

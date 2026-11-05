import { createHash } from "node:crypto";
import { z } from "zod";
import { randomToken } from "./oauth";
import { defaultExecute, type Execute } from "./db";
import { appUrl } from "./env";
import type { SessionUser } from "./types";
import type { OrganizationRole } from "./organizations";

type InviteRole = Exclude<OrganizationRole, "owner">;

export const tokenSchema = z.string().min(40).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationExpiryDate(nowMs: number) {
  return new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function invitationUrl(token: string) {
  return `${appUrl()}/invitations/accept?token=${encodeURIComponent(token)}`;
}

export async function issueInvitationToken(organizationId: number, email: string, execute: Execute = defaultExecute) {
  const token = randomToken(32);
  await execute(
    `UPDATE organization_invitations
     SET token_hash = ?, expires_at = ?, status = 'pending', accepted_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
     WHERE organization_id = ? AND email = ?`,
    [hashInvitationToken(token), invitationExpiryDate(Date.now()), organizationId, email],
  );
  return token;
}

interface InvitationRecord {
  id: number;
  organizationId: number;
  organizationName: string;
  email: string;
  role: InviteRole;
  status: string;
  expiresAt: Date | null;
}

function mapInvitation(row: { id: number; organization_id: number; name: string; email: string; role: InviteRole; status: string; expires_at: Date | null }): InvitationRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export async function getInvitationByToken(token: string, execute: Execute = defaultExecute) {
  const value = tokenSchema.parse(token);
  const [rows] = await execute(
    `SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, o.name
     FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
     WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > CURRENT_TIMESTAMP(3)
     LIMIT 1`,
    [hashInvitationToken(value)],
  ) as [Array<{ id: number; organization_id: number; name: string; email: string; role: InviteRole; status: string; expires_at: Date | null }>, unknown];
  const row = rows[0];
  return row ? mapInvitation(row) : null;
}

export async function acceptOrganizationInvitation(profile: SessionUser, token: string, execute: Execute = defaultExecute) {
  const invitation = await getInvitationByToken(token, execute);
  if (!invitation) throw new Error("invitation_invalid");
  if (!profile.email || profile.email.toLowerCase() !== invitation.email) throw new Error("invitation_email_mismatch");
  const [users] = await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [profile.sub]) as [Array<{ id: number }>, unknown];
  const user = users[0];
  if (!user) throw new Error("invitation_user_missing");
  await execute(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
    [invitation.organizationId, user.id, invitation.role],
  );
  await execute(
    "UPDATE organization_invitations SET status = 'accepted', accepted_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'pending'",
    [invitation.id],
  );
  return invitation;
}

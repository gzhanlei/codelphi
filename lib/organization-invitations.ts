import { z } from "zod";
import { currentOrganization, type Organization, type OrganizationRole } from "./organizations";
import { getDb } from "./db";
import { invitationUrl, issueInvitationToken } from "./invitation-tokens";
import { sendInvitationEmail } from "./invitation-email";
import type { SessionUser } from "./types";

type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;
type InviteRole = Exclude<OrganizationRole, "owner">;

const inviteSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: z.enum(["editor", "viewer"]),
});

export interface InviteResult {
  status: "member_added" | "invitation_pending";
  email: string;
  role: InviteRole;
  inviteUrl?: string;
  emailSent: boolean;
}

async function userIdByEmail(email: string, execute: Execute) {
  const [rows] = await execute("SELECT id FROM users WHERE email = ? LIMIT 1", [email]) as [Array<{ id: number }>, unknown];
  return rows[0]?.id;
}

export async function inviteOrganizationMember(profile: SessionUser, input: unknown, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters), organization?: Organization, mailer: typeof sendInvitationEmail = sendInvitationEmail): Promise<InviteResult> {
  const workspace = organization ?? await currentOrganization(profile);
  if (workspace.role !== "owner") throw new Error("forbidden");
  const { email, role } = inviteSchema.parse(input);
  const userId = await userIdByEmail(email, execute);
  if (userId) {
    await execute(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
      [workspace.id, userId, role],
    );
    return { status: "member_added", email, role, emailSent: false };
  }
  await execute(
    `INSERT INTO organization_invitations (organization_id, email, role, invited_by)
     SELECT o.id, ?, ?, u.id FROM organizations o JOIN users u ON u.chandler_sub = ?
     ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'pending', updated_at = CURRENT_TIMESTAMP(3)`,
    [email, role, profile.sub],
  );
  const token = await issueInvitationToken(workspace.id, email, execute);
  const inviteUrl = invitationUrl(token);
  const emailSent = await mailer({ to: email, organizationName: workspace.name, role, inviteUrl });
  return { status: "invitation_pending", email, role, inviteUrl, emailSent };
}

export async function claimOrganizationInvitations(profile: SessionUser, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters)) {
  if (!profile.email) return;
  const [invitations] = await execute(
    "SELECT organization_id, role FROM organization_invitations WHERE email = ? AND status = 'pending' AND token_hash IS NULL",
    [profile.email],
  ) as [Array<{ organization_id: number; role: InviteRole }>, unknown];
  for (const invitation of invitations) {
    const [users] = await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [profile.sub]) as [Array<{ id: number }>, unknown];
    const user = users[0];
    if (!user) throw new Error("Invitation user is not provisioned");
    await execute(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = CURRENT_TIMESTAMP(3)`,
      [invitation.organization_id, user.id, invitation.role],
    );
    await execute(
      "UPDATE organization_invitations SET status = 'accepted', updated_at = CURRENT_TIMESTAMP(3) WHERE organization_id = ? AND email = ?",
      [invitation.organization_id, profile.email],
    );
  }
}

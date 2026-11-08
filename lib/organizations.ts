import { cookies } from "next/headers";
import { defaultExecute, type Execute } from "./db";
import { upsertCodelphiUser, findUserIdBySub } from "./users";
import { requiredEnv } from "./env";
import { claimOrganizationInvitations } from "./organization-invitations";
import { claimProductInvitations } from "./product-members";
import { grantTrialQuota } from "./billing/core";
import type { SessionUser } from "./types";

export type OrganizationRole = "owner" | "editor" | "viewer";
export interface Organization {
  id: number;
  slug: string;
  name: string;
  role: OrganizationRole;
}

export const ORGANIZATION_COOKIE = "codelphi_organization";
type Query = <T>(statement: string, parameters: Array<string | number | null>) => Promise<T[]>;

function dbQuery<T>(execute: Execute): Query {
  return async <T>(statement: string, parameters: Array<string | number | null>) => {
    const result = await execute(statement, parameters) as unknown;
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
    if (Array.isArray(result)) return result as T[];
    return [];
  };
}

function defaultOrganization(profile: SessionUser): Organization {
  return { id: 0, slug: `u-${profile.sub}`, name: `${profile.name ?? profile.email ?? "CoDelphi 用户"} 的工作区`, role: "owner" };
}

export async function ensureUserWorkspace(profile: SessionUser, execute: Execute = defaultExecute) {
  const query = dbQuery(execute);
  await upsertCodelphiUser(profile, execute);
  await claimOrganizationInvitations(profile, execute);
  await claimProductInvitations(profile, execute);
  const defaultOrg = defaultOrganization(profile);
  const existing = await query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id WHERE u.chandler_sub = ? AND o.slug = ?`,
    [profile.sub, defaultOrg.slug],
  );
  if (existing[0]) {
    // Trial 授权幂等重试：发放失败（如瞬时故障）的用户在下次登录自动补齐（契约 M1-T4）
    await grantTrialToWorkspace(profile, existing[0].id, execute);
    return existing[0];
  }
  await execute(
    "INSERT INTO organizations (slug, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = CURRENT_TIMESTAMP(3)",
    [defaultOrg.slug, defaultOrg.name],
  );
  await execute(
    `INSERT INTO organization_members (organization_id, user_id, role)
     SELECT o.id, u.id, 'owner' FROM organizations o JOIN users u WHERE o.slug = ? AND u.chandler_sub = ?
     ON DUPLICATE KEY UPDATE role = 'owner', updated_at = CURRENT_TIMESTAMP(3)`,
    [defaultOrg.slug, profile.sub],
  );
  const rows = await query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id WHERE u.chandler_sub = ? AND o.slug = ?`,
    [profile.sub, defaultOrg.slug],
  );
  if (!rows[0]) throw new Error("Workspace bootstrap failed");
  await grantTrialToWorkspace(profile, rows[0].id, execute);
  return rows[0];
}

/**
 * 个人工作区 Trial 授权（契约 M1-T4，P1-3 归属冻结）：归属主体 = 工作区创建者；
 * 仅 `u-<sub>` 个人工作区触发（加入他人组织不触发/不转移）；幂等（trial_grants.user_id 主键 +
 * 钱包 source_key 双保险），失败 best-effort——下次登录重试，不阻断工作区创建。
 */
async function grantTrialToWorkspace(profile: SessionUser, organizationId: number, execute: Execute) {
  try {
    const userId = await findUserIdBySub(profile.sub, execute);
    if (userId === null) return;
    const result = await grantTrialQuota({ userId, accountId: organizationId, source: "workspace_creation" });
    if (result.granted) console.log(`[billing] trial quota granted (user ${userId} → account ${organizationId})`);
  } catch (error) {
    console.warn("[billing] trial grant failed; will retry on next login", error);
  }
}

export async function listUserOrganizations(profile: SessionUser, execute: Execute = defaultExecute) {
  const query = dbQuery(execute);
  return query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.user_id
     WHERE u.chandler_sub = ? ORDER BY o.name`,
    [profile.sub],
  );
}

export async function getOrganizationMembership(profile: SessionUser, slug: string, execute: Execute = defaultExecute) {
  const query = dbQuery(execute);
  const rows = await query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id WHERE u.chandler_sub = ? AND o.slug = ?`,
    [profile.sub, slug],
  );
  return rows[0];
}

export async function currentOrganization(profile: SessionUser, cookieSlug: string | null | undefined = undefined, execute: Execute = defaultExecute): Promise<Organization> {
  if (cookieSlug !== null) {
    const slug = cookieSlug ?? (await cookies()).get(ORGANIZATION_COOKIE)?.value;
    const membership = await getOrganizationMembership(profile, slug ?? "", execute);
    if (membership) return membership;
  }
  return ensureUserWorkspace(profile, execute);
}

export async function setCurrentOrganization(profile: SessionUser, slug: string) {
  const organization = await getOrganizationMembership(profile, slug);
  if (!organization) throw new Error("forbidden");
  const jar = await cookies();
  jar.set(ORGANIZATION_COOKIE, organization.slug, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return organization;
}

export async function requireOrganization(profile: SessionUser, minimumRole: OrganizationRole = "viewer", cookieSlug: string | null | undefined = undefined, execute: Execute = defaultExecute) {
  const organization = await currentOrganization(profile, cookieSlug, execute);
  const rank = { viewer: 0, editor: 1, owner: 2 };
  if (rank[organization.role] < rank[minimumRole]) throw new Error("forbidden");
  return organization;
}

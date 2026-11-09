import { randomBytes } from "node:crypto";
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
/** 个人工作区保留前缀：u-% 行由系统物化，slug 为随机串（不回推身份），不出现在用户自建入口。 */
const PERSONAL_SLUG_PREFIX = "u-";
type Query = <T>(statement: string, parameters: Array<string | number | null>) => Promise<T[]>;

function dbQuery<T>(execute: Execute): Query {
  return async <T>(statement: string, parameters: Array<string | number | null>) => {
    const result = await execute(statement, parameters) as unknown;
    if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
    if (Array.isArray(result)) return result as T[];
    return [];
  };
}

function personalWorkspaceName(profile: SessionUser): string {
  return `${profile.name ?? profile.email ?? "CoDelphi 用户"} 的工作区`;
}

/** 个人工作区 slug：org slug 会出现在产品 canonical URL 里，用随机串避免暴露 chandler sub。 */
function randomPersonalSlug(): string {
  return `${PERSONAL_SLUG_PREFIX}${randomBytes(5).toString("hex")}`;
}

export async function ensureUserWorkspace(profile: SessionUser, execute: Execute = defaultExecute) {
  const query = dbQuery(execute);
  await upsertCodelphiUser(profile, execute);
  await claimOrganizationInvitations(profile, execute);
  await claimProductInvitations(profile, execute);
  const existing = await query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id WHERE u.chandler_sub = ? AND o.slug LIKE ? AND m.role = 'owner'
     ORDER BY o.id LIMIT 1`,
    [profile.sub, `${PERSONAL_SLUG_PREFIX}%`],
  );
  if (existing[0]) {
    // Trial 授权幂等重试：发放失败（如瞬时故障）的用户在下次登录自动补齐（契约 M1-T4）
    await grantTrialToWorkspace(profile, existing[0].id, execute);
    return existing[0];
  }
  const name = personalWorkspaceName(profile);
  const slug = randomPersonalSlug();
  await execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", [slug, name]);
  const [orgRow] = await query<{ id: number }>(
    "SELECT id FROM organizations WHERE slug = ?",
    [slug],
  );
  const userId = await findUserIdBySub(profile.sub, execute);
  if (!orgRow?.id || userId === null) throw new Error("Workspace bootstrap failed");
  await execute(
    `INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')
     ON DUPLICATE KEY UPDATE role = 'owner', updated_at = CURRENT_TIMESTAMP(3)`,
    [orgRow.id, userId],
  );
  const rows = await query<Organization>(
    `SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members m ON m.organization_id = o.id
     JOIN users u ON u.id = m.user_id WHERE u.chandler_sub = ? AND o.slug LIKE ? AND m.role = 'owner'
     ORDER BY o.id DESC LIMIT 1`,
    [profile.sub, `${PERSONAL_SLUG_PREFIX}%`],
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

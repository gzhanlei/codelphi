import { defaultExecute, type Execute } from "./db";
import { currentOrganization, type Organization, type OrganizationRole } from "./organizations";
import type { ProductRole } from "./product-members";
import type { SessionUser } from "./types";

const roleRank: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

export interface ProductAccess {
  product: { id: number; slug: string; name: string; description: string; organizationId: number };
  /** 产品真实所属工作区；role 字段为调用者在该产品上的有效角色。 */
  organization: Organization;
  role: OrganizationRole;
  via: "organization" | "product";
}

/**
 * 产品访问鉴权：工作区成员按组织角色，非工作区成员按 product_members 授权行。
 * 返回产品的真实 organizationId，下游 org-scoped 查询无需改动；
 * 无访问权限（产品不存在、跨工作区、角色不足）一律返回 null，由调用方按 404 处理。
 */
export async function requireProductAccess(profile: SessionUser, slug: string, minimumRole: OrganizationRole = "viewer", execute: Execute = defaultExecute, cookieSlug?: string): Promise<ProductAccess | null> {
  const organization = await currentOrganization(profile, cookieSlug, execute);
  if (roleRank[organization.role] >= roleRank[minimumRole]) {
    const [rows] = await execute(
      "SELECT id, slug, name, description, organization_id FROM products WHERE slug = ? AND organization_id = ? LIMIT 1",
      [slug, organization.id],
    ) as [Array<{ id: number; slug: string; name: string; description: string; organization_id: number }>, unknown];
    const row = rows[0];
    if (row) {
      return { product: { id: row.id, slug: row.slug, name: row.name, description: row.description, organizationId: row.organization_id }, organization: { ...organization, id: row.organization_id }, role: organization.role, via: "organization" };
    }
  }

  const [memberRows] = await execute(
    `SELECT p.id, p.slug, p.name, p.description, p.organization_id, pm.role, o.slug AS org_slug, o.name AS org_name
     FROM product_members pm
     JOIN products p ON p.id = pm.product_id
     JOIN organizations o ON o.id = p.organization_id
     JOIN users u ON u.id = pm.user_id
     WHERE u.chandler_sub = ? AND p.slug = ?
     LIMIT 1`,
    [profile.sub, slug],
  ) as [Array<{ id: number; slug: string; name: string; description: string; organization_id: number; role: ProductRole; org_slug: string; org_name: string }>, unknown];
  const member = memberRows[0];
  if (member && roleRank[member.role] >= roleRank[minimumRole]) {
    return {
      product: { id: member.id, slug: member.slug, name: member.name, description: member.description, organizationId: member.organization_id },
      organization: { id: member.organization_id, slug: member.org_slug, name: member.org_name, role: member.role },
      role: member.role,
      via: "product",
    };
  }

  return null;
}

/** 由反查 slug 得到的产品再鉴权；slug 不存在视为资源不存在，返回 null。 */
async function requireProductAccessBySlug(profile: SessionUser, slug: string | undefined, minimumRole: OrganizationRole, execute: Execute, cookieSlug?: string): Promise<ProductAccess | null> {
  if (!slug) return null;
  return requireProductAccess(profile, slug, minimumRole, execute, cookieSlug);
}

/** 由 feature id 反查所属产品后鉴权；feature 不存在或无访问权限返回 null。 */
export async function requireFeatureProductAccess(profile: SessionUser, featureId: number, minimumRole: OrganizationRole = "editor", execute: Execute = defaultExecute, cookieSlug?: string): Promise<ProductAccess | null> {
  const [rows] = await execute(
    "SELECT p.slug FROM features f JOIN products p ON p.id = f.product_id WHERE f.id = ? LIMIT 1",
    [featureId],
  ) as [Array<{ slug: string }>, unknown];
  return requireProductAccessBySlug(profile, rows[0]?.slug, minimumRole, execute, cookieSlug);
}

/** 由 scenario id 反查所属产品后鉴权；scenario 不存在或无访问权限返回 null。 */
export async function requireScenarioProductAccess(profile: SessionUser, scenarioId: number, minimumRole: OrganizationRole = "editor", execute: Execute = defaultExecute, cookieSlug?: string): Promise<ProductAccess | null> {
  const [rows] = await execute(
    `SELECT p.slug FROM scenarios s JOIN features f ON f.id = s.feature_id JOIN products p ON p.id = f.product_id WHERE s.id = ? LIMIT 1`,
    [scenarioId],
  ) as [Array<{ slug: string }>, unknown];
  return requireProductAccessBySlug(profile, rows[0]?.slug, minimumRole, execute, cookieSlug);
}

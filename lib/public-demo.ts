import { getDb } from "./db";
import { publicDemoSlugs } from "./env";

/** 产品自身标记的公开演示（产品设置页开关）。 */
export async function isPublicDemoProduct(slug: string): Promise<boolean> {
  const [rows] = await getDb().execute("SELECT 1 FROM products WHERE slug = ? AND is_public_demo = 1 LIMIT 1", [slug]);
  return (rows as Array<unknown>).length > 0;
}

/** 匿名访问门禁：数据库开关优先，PUBLIC_DEMO_SLUGS 环境变量作为过渡兜底。 */
export async function isPublicDemo(slug: string): Promise<boolean> {
  return publicDemoSlugs().has(slug) || (await isPublicDemoProduct(slug));
}

export interface DemoReadProduct {
  id: number;
  slug: string;
  name: string;
  organizationId: number;
  /** 所属工作区 slug，用于拼 canonical 页面地址 /products/{orgSlug}/{slug}。 */
  organizationSlug: string;
}

/** 登录页公开演示入口：优先取数据库标记的 demo 产品，env 白名单兜底；都没有则返回 null（页面不渲染入口）。 */
export async function loadPublicDemoProduct(): Promise<{ slug: string; name: string; organizationSlug: string } | null> {
  const [rows] = await getDb().execute(
    "SELECT p.slug, p.name, o.slug AS organization_slug FROM products p JOIN organizations o ON o.id = p.organization_id WHERE p.is_public_demo = 1 ORDER BY p.id LIMIT 1",
  );
  const row = (rows as Array<{ slug: string; name: string; organization_slug: string }>)[0];
  if (row) return { slug: row.slug, name: row.name, organizationSlug: row.organization_slug };
  const [first] = [...publicDemoSlugs()];
  return first ? { slug: first, name: first, organizationSlug: "" } : null;
}

/** 匿名只读解析（canonical 页面：org 段已知）：按 (orgSlug, slug) 精确解析，仅公开 demo 产品放行；
 *  env 白名单兜底。产品不存在、非 demo 或与 org 段不符返回 null。 */
export async function resolvePublicDemoProduct(orgSlug: string, slug: string): Promise<DemoReadProduct | null> {
  const [rows] = await getDb().execute(
    `SELECT p.id, p.slug, p.name, p.organization_id, p.is_public_demo, o.slug AS organization_slug
     FROM products p JOIN organizations o ON o.id = p.organization_id
     WHERE p.slug = ? AND o.slug = ? LIMIT 1`,
    [slug, orgSlug],
  );
  const row = (rows as Array<{ id: number; slug: string; name: string; organization_id: number; is_public_demo: number; organization_slug: string }>)[0];
  if (!row) return null;
  if (!row.is_public_demo && !publicDemoSlugs().has(slug)) return null;
  return { id: row.id, slug: row.slug, name: row.name, organizationId: row.organization_id, organizationSlug: row.organization_slug };
}

/** 旧一段地址的 demo 解析（无 org 段场景：API 匿名兜底、legacy 重定向层）：
 *  跨工作区按 slug 可能命中多行，取第一个公开 demo 行；env 白名单兜底与 isPublicDemo 对齐。
 *  产品行不存在或非 demo（且不在 env 白名单）返回 null。 */
export async function resolveLegacyPublicDemoProduct(slug: string): Promise<DemoReadProduct | null> {
  const [rows] = await getDb().execute(
    `SELECT p.id, p.slug, p.name, p.organization_id, p.is_public_demo, o.slug AS organization_slug
     FROM products p JOIN organizations o ON o.id = p.organization_id
     WHERE p.slug = ? ORDER BY p.id LIMIT 1`,
    [slug],
  );
  const row = (rows as Array<{ id: number; slug: string; name: string; organization_id: number; is_public_demo: number; organization_slug: string }>)[0];
  if (!row) return null;
  if (!row.is_public_demo && !publicDemoSlugs().has(slug)) return null;
  return { id: row.id, slug: row.slug, name: row.name, organizationId: row.organization_id, organizationSlug: row.organization_slug };
}

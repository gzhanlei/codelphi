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
}

/** 匿名只读解析：仅公开 demo 产品放行（DB 开关优先，env 白名单兜底）；产品不存在或非 demo 返回 null。 */
export async function resolvePublicDemoProduct(slug: string): Promise<DemoReadProduct | null> {
  const [rows] = await getDb().execute(
    "SELECT id, slug, name, organization_id, is_public_demo FROM products WHERE slug = ? LIMIT 1",
    [slug],
  );
  const row = (rows as Array<{ id: number; slug: string; name: string; organization_id: number; is_public_demo: number }>)[0];
  if (!row) return null;
  if (!row.is_public_demo && !publicDemoSlugs().has(slug)) return null;
  return { id: row.id, slug: row.slug, name: row.name, organizationId: row.organization_id };
}

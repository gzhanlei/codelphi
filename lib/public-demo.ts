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

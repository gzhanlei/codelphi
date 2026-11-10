import { getDb } from "./db";
import type { IntroPositioning } from "./intro-material";

export interface DescriptionUpdate {
  id: number;
  description: string;
}

export async function updateProductDescription(slug: string, organizationId: number, description: string): Promise<DescriptionUpdate | null> {
  const db = getDb();
  const [productRows] = await db.execute("SELECT id FROM products WHERE slug = ? AND organization_id = ?", [slug, organizationId]);
  const product = (productRows as Array<{ id: number }>)[0];
  if (!product) return null;
  // A manual overview is owned by the workspace: auto-analysis only writes when the
  // description is empty (lib/analysis.ts), so a non-empty manual text stays untouched.
  await db.execute("UPDATE products SET description = ?, description_source = 'manual', description_evidence = NULL WHERE id = ?", [description, product.id]);
  return { id: Number(product.id), description };
}

/** 定位块写入（migration 061）：分析管线不触碰此列；清空保存即置 NULL（由负责人重填）。 */
export async function updateProductPositioning(slug: string, organizationId: number, positioning: IntroPositioning): Promise<boolean> {
  const db = getDb();
  const [productRows] = await db.execute("SELECT id FROM products WHERE slug = ? AND organization_id = ?", [slug, organizationId]);
  const product = (productRows as Array<{ id: number }>)[0];
  if (!product) return false;
  const empty = !positioning.audience.trim() && !positioning.differentiation.trim() && !positioning.tone.trim();
  await db.execute("UPDATE products SET positioning_json = ?, positioning_source = 'manual' WHERE id = ?", [empty ? null : JSON.stringify(positioning), product.id]);
  return true;
}

import { getDb } from "./db";

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

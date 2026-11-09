import { getDb } from "./db";

export type ProductRenameResult =
  | { status: "updated"; id: number; name: string; slug: string }
  | { status: "not_found" }
  | { status: "slug_conflict" };

export interface ProductRenameInput {
  name?: string;
  newSlug?: string;
  isPublicDemo?: boolean;
}

function isDuplicateEntryError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY";
}

/**
 * 更新产品显示名 / slug。其他表均按 product_id 关联（migration 008），
 * slug 变更只需更新 products 本行，并把旧 slug 记入历史供旧链接重定向。
 */
export async function updateProductIdentity(slug: string, organizationId: number, input: ProductRenameInput): Promise<ProductRenameResult> {
  const db = getDb();
  const [productRows] = await db.execute("SELECT id, name, slug FROM products WHERE slug = ? AND organization_id = ?", [slug, organizationId]);
  const product = (productRows as Array<{ id: number; name: string; slug: string }>)[0];
  if (!product) return { status: "not_found" };

  const nextName = input.name?.trim();
  const nextSlug = input.newSlug?.trim().toLowerCase();
  const slugChanged = nextSlug !== undefined && nextSlug !== product.slug;

  if (slugChanged) {
    const [conflicts] = await db.execute("SELECT id FROM products WHERE slug = ? AND organization_id = ? AND id != ?", [nextSlug, organizationId, product.id]);
    if ((conflicts as Array<{ id: number }>).length > 0) return { status: "slug_conflict" };
  }

  try {
    await db.execute(
      "UPDATE products SET name = COALESCE(?, name), slug = COALESCE(?, slug), is_public_demo = COALESCE(?, is_public_demo) WHERE id = ?",
      [nextName ?? null, slugChanged ? nextSlug : null, input.isPublicDemo === undefined ? null : input.isPublicDemo ? 1 : 0, product.id],
    );
  } catch (error) {
    // 并发下唯一键 (organization_id, slug) 冲突视为改名失败。
    if (isDuplicateEntryError(error)) return { status: "slug_conflict" };
    throw error;
  }

  if (slugChanged && nextSlug) {
    // 改回历史 slug 时先清掉本产品的对应记录（只限本产品，migration 048 起唯一键为 (product_id, old_slug)）。
    await db.execute("DELETE FROM product_slug_history WHERE old_slug = ? AND product_id = ?", [nextSlug, product.id]);
    await db.execute(
      "INSERT INTO product_slug_history (product_id, old_slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), changed_at = CURRENT_TIMESTAMP(3)",
      [product.id, product.slug],
    );
  }

  return { status: "updated", id: Number(product.id), name: nextName ?? product.name, slug: slugChanged ? nextSlug! : product.slug };
}

export interface OldSlugLookup {
  /** 调用者的 chandler_sub，用于把重定向候选限定在可访问的工作区。 */
  userSub: string;
  /** 用户 cookie 当前工作区 id；命中的候选里优先返回它的。 */
  preferredOrgId?: number | null;
}

/** 旧 slug → 现产品路由入口（带 org 段的 canonical 地址），供旧链接重定向。
 *  跨工作区允许重名后，old_slug 不再全局唯一，这里只返回调用者可访问、且优先 cookie 工作区的那个。 */
export async function findProductByOldSlug(oldSlug: string, options: OldSlugLookup): Promise<{ slug: string; orgSlug: string } | null> {
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT p.slug AS slug, o.slug AS org_slug
     FROM product_slug_history h
     JOIN products p ON p.id = h.product_id
     JOIN organizations o ON o.id = p.organization_id
     LEFT JOIN organization_members m ON m.organization_id = p.organization_id
     LEFT JOIN users u ON u.id = m.user_id AND u.chandler_sub = ?
     WHERE h.old_slug = ?
       AND (u.id IS NOT NULL OR EXISTS (
         SELECT 1 FROM product_members pm JOIN users pu ON pu.id = pm.user_id
         WHERE pm.product_id = p.id AND pu.chandler_sub = ?))
     ORDER BY (p.organization_id = ?) DESC, h.changed_at DESC
     LIMIT 1`,
    [options.userSub, oldSlug, options.userSub, options.preferredOrgId ?? -1],
  );
  const row = (rows as Array<{ slug: string; org_slug: string }>)[0];
  return row ? { slug: row.slug, orgSlug: row.org_slug } : null;
}

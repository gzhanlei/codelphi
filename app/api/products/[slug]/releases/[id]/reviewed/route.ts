import { apiErrorBody } from "@/lib/api-errors";
import { getDb } from "@/lib/db";
import { publicDemoSlugs } from "@/lib/env";
import { requireProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";
import type { ChangeRow } from "@/lib/types";
import { NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json(apiErrorBody("release_not_found"), { status: 404 });

  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  if (!access && !publicDemoSlugs().has(slug)) {
    if (!user) return NextResponse.json(apiErrorBody("unauthorized"), { status: 401 });
    return NextResponse.json(apiErrorBody("product_not_found"), { status: 404 });
  }

  const db = getDb();
  const organizationId = access?.product.organizationId;
  const [products] = await db.execute(
    organizationId === undefined ? "SELECT id FROM products WHERE slug = ?" : "SELECT id FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number }>)[0];
  if (!product) return NextResponse.json(apiErrorBody("product_not_found"), { status: 404 });
  const [releases] = await db.execute("SELECT id FROM releases WHERE id = ? AND product_id = ?", [releaseId, product.id]);
  if ((releases as unknown[]).length === 0) return NextResponse.json(apiErrorBody("release_not_found"), { status: 404 });

  const [rows] = await db.execute(
    "SELECT id, release_id AS releaseId, feature_name AS featureName, description, evidence FROM release_reviewed_items WHERE release_id = ? ORDER BY id",
    [releaseId],
  );
  const items = (rows as Array<Omit<ChangeRow, "kind" | "userImpact">>).map((row) => ({ ...row, kind: "reviewed", userImpact: "" }));
  return NextResponse.json({ items });
}

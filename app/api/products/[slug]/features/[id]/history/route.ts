import { apiErrorBody } from "@/lib/api-errors";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireFeatureProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";
import { loadFeatureHistory } from "@/lib/feature-history";

/** 功能行为变迁史（CTO 复盘视图）：登录成员可读，按发布分组时间倒序。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json(apiErrorBody("unauthorized"), { status: 401 });
  const featureId = Number(id);
  if (!Number.isInteger(featureId) || featureId <= 0) return NextResponse.json(apiErrorBody("feature_not_found"), { status: 404 });
  const access = await requireFeatureProductAccess(user, featureId, "viewer");
  if (!access) return NextResponse.json(apiErrorBody("product_forbidden"), { status: 404 });
  const db = getDb();
  const featureResult = await db.execute(
    "SELECT name FROM features WHERE id = ? AND product_id = ? AND active = 1",
    [featureId, access.product.id],
  ) as unknown;
  const featureRows = (Array.isArray(featureResult) ? featureResult[0] : featureResult) as Array<{ name: string }>;
  const feature = featureRows?.[0];
  if (!feature) return NextResponse.json(apiErrorBody("feature_not_found"), { status: 404 });
  const history = await loadFeatureHistory(db.execute.bind(db), access.product.id, feature.name);
  return NextResponse.json({ history });
}

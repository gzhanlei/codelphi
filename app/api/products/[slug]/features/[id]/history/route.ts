import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireFeatureProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";
import { loadFeatureHistory } from "@/lib/feature-history";

/** 功能行为变迁史（CTO 复盘视图）：登录成员可读，按发布分组时间倒序。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const featureId = Number(id);
  if (!Number.isInteger(featureId) || featureId <= 0) return NextResponse.json({ error: "功能不存在" }, { status: 404 });
  const access = await requireFeatureProductAccess(user, featureId, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const db = getDb();
  const featureResult = await db.execute(
    "SELECT name FROM features WHERE id = ? AND product_id = ? AND active = 1",
    [featureId, access.product.id],
  ) as unknown;
  const featureRows = (Array.isArray(featureResult) ? featureResult[0] : featureResult) as Array<{ name: string }>;
  const feature = featureRows?.[0];
  if (!feature) return NextResponse.json({ error: "功能不存在" }, { status: 404 });
  const history = await loadFeatureHistory(db.execute.bind(db), access.product.id, feature.name);
  return NextResponse.json({ history });
}

import { apiErrorBody } from "@/lib/api-errors";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireFeatureProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";
import { loadFeatureConnections } from "@/lib/feature-connections";

/** 功能连接（B3 确定性层）：登录成员可读，返回该功能与其他功能的共享证据面连接。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json(apiErrorBody("unauthorized"), { status: 401 });
  const featureId = Number(id);
  if (!Number.isInteger(featureId) || featureId <= 0) return NextResponse.json(apiErrorBody("feature_not_found"), { status: 404 });
  const access = await requireFeatureProductAccess(user, featureId, "viewer");
  if (!access) return NextResponse.json(apiErrorBody("product_forbidden"), { status: 404 });
  const all = await loadFeatureConnections(getDb().execute.bind(getDb()), access.product.id);
  const entry = all.find((item) => item.featureId === featureId) ?? { featureId, featureName: "", connections: [] };
  return NextResponse.json({ connections: entry.connections });
}

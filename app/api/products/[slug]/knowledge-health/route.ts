import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { getProductDetails } from "@/lib/product-details";
import { buildKnowledgeHealth } from "@/lib/knowledge-health";

/** 知识健康（P2 第一版，事实统计）：登录成员可读；无综合分、无 Bus Factor。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const db = getDb();
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const report = buildKnowledgeHealth({
    features: details.features,
    scenarios: details.scenarios,
    regressionTasks: details.regressionTasks,
    latestReleaseId: details.releases[0]?.id,
  });
  return NextResponse.json({ report });
}

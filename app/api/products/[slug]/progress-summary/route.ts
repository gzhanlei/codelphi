import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";
import { loadRecentReleasesWithChanges, loadWindowFeatureDeltas, renderProgressSummary } from "@/lib/progress-summary";
import { enforceExportRateLimit } from "@/lib/rate-limit";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

/** 30 天变更索引导出：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  const { days } = parsed.data;

  const user = await getSessionUser();
  const limited = await enforceExportRateLimit(request, user?.sub ?? null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = user ? await requireProductAccess(user, slug) : null;
  let product: { id: number; name: string };
  if (access) {
    product = access.product;
  } else {
    const demo = await resolveLegacyPublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    product = demo;
  }

  const [releases, featureDeltas] = await Promise.all([
    loadRecentReleasesWithChanges(product.id, days),
    loadWindowFeatureDeltas(product.id, days),
  ]);
  const markdown = renderProgressSummary({ productName: product.name, days, releases, featureDeltas });
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-progress-${days}d.md"`,
    },
  });
}

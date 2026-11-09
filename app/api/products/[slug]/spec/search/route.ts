import { NextRequest, NextResponse } from "next/server";
import { searchSpec } from "@/lib/spec-search";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";

/** M3 产品内搜索：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  let productId: number;
  if (access) {
    productId = access.product.id;
  } else {
    const demo = await resolveLegacyPublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    productId = demo.id;
  }
  const query = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchSpec(productId, query));
}

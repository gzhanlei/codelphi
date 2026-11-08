import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { getProductDetails } from "@/lib/product-details";
import { buildProductOverview } from "@/lib/product-overview";
import { renderProductExplainerHtml } from "@/lib/product-explainer";
import { artifactSandboxHeaders } from "@/lib/artifact-response";
import { errorMessage } from "@/lib/error-message";

/** Explainer 导出：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  let organizationId: number;
  if (access) {
    organizationId = access.product.organizationId;
  } else {
    const demo = await resolvePublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在" : "未登录" }, { status: user ? 404 : 401 });
    organizationId = demo.organizationId;
  }
  const details = await getProductDetails(slug, organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const overview = buildProductOverview(details);
  try {
    const html = renderProductExplainerHtml(overview);
    return new NextResponse(html, { status: 200, headers: artifactSandboxHeaders() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "Explainer 导出失败") }, { status: 500 });
  }
}

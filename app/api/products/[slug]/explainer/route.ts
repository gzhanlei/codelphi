import { NextRequest, NextResponse } from "next/server";
import { enforceExportRateLimit } from "@/lib/rate-limit";
import { loadCachedExplainerHtml, saveExplainerCache } from "@/lib/explainer-cache";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { getProductDetails } from "@/lib/product-details";
import { buildProductOverview } from "@/lib/product-overview";
import { renderProductExplainerHtml } from "@/lib/product-explainer";
import { artifactSandboxHeaders } from "@/lib/artifact-response";
import { errorMessage } from "@/lib/error-message";

/** Explainer 导出：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  // 导出限流（契约 §10.4）：Explainer 需 Chromium 渲染，匿名单独收紧
  const limited = await enforceExportRateLimit(request, user?.sub ?? null, { anonymous: 2, user: 60 });
  if (limited) return limited;
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
  // 渲染缓存（契约 §10.4）：命中零 Chromium 调用，键 = product + 当前 spec 版本
  const cached = await loadCachedExplainerHtml(details.product.id);
  if (cached) return new NextResponse(cached, { status: 200, headers: artifactSandboxHeaders() });
  const overview = buildProductOverview(details);
  try {
    const html = renderProductExplainerHtml(overview);
    await saveExplainerCache(details.product.id, html);
    return new NextResponse(html, { status: 200, headers: artifactSandboxHeaders() });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "Explainer 导出失败") }, { status: 500 });
  }
}

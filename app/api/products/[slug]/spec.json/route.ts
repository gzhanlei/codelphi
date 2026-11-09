import { NextRequest, NextResponse } from "next/server";
import { getProductDetails } from "@/lib/product-details";
import { productBasePath } from "@/lib/product-links";
import { specFeatureKey } from "@/lib/spec-diff";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/** M3 机器可读导出：当前规格快照 + 证据，M10 MCP 与外部自动化同源使用；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  const limited = await enforceExportRateLimit(request, user?.sub ?? null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = user ? await requireProductAccess(user, slug) : null;
  let organizationId: number;
  let organizationSlug: string;
  if (access) {
    organizationId = access.product.organizationId;
    organizationSlug = access.organization.slug;
  } else {
    const demo = await resolveLegacyPublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    organizationId = demo.organizationId;
    organizationSlug = demo.organizationSlug;
  }
  const details = await getProductDetails(slug, organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  return NextResponse.json({
    product: { slug: details.product.slug, name: details.product.name, description: details.product.description, descriptionSource: details.product.descriptionSource },
    generatedAt: new Date().toISOString(),
    features: details.features.map((feature) => ({
      name: feature.name,
      summary: feature.summary,
      source: feature.source,
      stablePath: `${productBasePath(organizationSlug, details.product.slug)}/spec/feature/${encodeURIComponent(specFeatureKey(feature.name))}`,
      scenarios: details.scenarios
        .filter((scenario) => scenario.featureId === feature.id)
        .map((scenario) => ({
          reference: scenario.reference,
          context: scenario.context,
          action: scenario.action,
          outcome: scenario.outcome,
          category: scenario.category,
          source: scenario.source,
          evidence: scenario.evidence,
        })),
    })),
    scenarioCount: details.scenarios.length,
  });
}

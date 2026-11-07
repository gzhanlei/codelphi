import { NextRequest, NextResponse } from "next/server";
import { getProductDetails } from "@/lib/product-details";
import { specFeatureKey } from "@/lib/spec-diff";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

/** M3 机器可读导出：当前规格快照 + 证据，M10 MCP 与外部自动化同源使用。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  return NextResponse.json({
    product: { slug: details.product.slug, name: details.product.name, description: details.product.description, descriptionSource: details.product.descriptionSource },
    generatedAt: new Date().toISOString(),
    features: details.features.map((feature) => ({
      name: feature.name,
      summary: feature.summary,
      source: feature.source,
      stablePath: `/products/${slug}/spec/feature/${encodeURIComponent(specFeatureKey(feature.name))}`,
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

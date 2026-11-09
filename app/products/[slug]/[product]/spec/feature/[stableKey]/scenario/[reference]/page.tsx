import { notFound, redirect } from "next/navigation";
import { defaultExecute } from "@/lib/db";
import { productBasePath } from "@/lib/product-links";
import { resolveScenarioByStableKey } from "@/lib/stable-links";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/** M3 场景稳定引用（canonical）：解析到场景所属功能的最新规格视图。参数名说明见上两级 page.tsx。 */
export default async function StableScenarioPage({ params }: { params: Promise<{ slug: string; product: string; stableKey: string; reference: string }> }) {
  const { slug: org, product: slug, stableKey, reference } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const access = await requireProductAccess(user, slug, "viewer", defaultExecute, undefined, org);
  if (!access || access.organization.slug !== org) notFound();
  const featureId = await resolveScenarioByStableKey(access.product.id, decodeURIComponent(stableKey), decodeURIComponent(reference));
  if (featureId === null) notFound();
  redirect(`${productBasePath(org, slug)}?view=spec&feature=${featureId}`);
}

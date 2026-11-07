import { notFound, redirect } from "next/navigation";
import { resolveScenarioByStableKey } from "@/lib/stable-links";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/** M3 场景稳定引用：解析到场景所属功能的最新规格视图。 */
export default async function StableScenarioPage({ params }: { params: Promise<{ slug: string; stableKey: string; reference: string }> }) {
  const { slug, stableKey, reference } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const access = await requireProductAccess(user, slug);
  if (!access) notFound();
  const featureId = await resolveScenarioByStableKey(access.product.id, decodeURIComponent(stableKey), decodeURIComponent(reference));
  if (featureId === null) notFound();
  redirect(`/products/${slug}?view=spec&feature=${featureId}`);
}

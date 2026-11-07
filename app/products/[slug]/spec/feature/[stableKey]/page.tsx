import { notFound, redirect } from "next/navigation";
import { resolveFeatureByStableKey } from "@/lib/stable-links";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/** M3 稳定引用入口：/products/[slug]/spec/feature/[stable_key] 始终解析到最新规格里的该功能。 */
export default async function StableFeaturePage({ params }: { params: Promise<{ slug: string; stableKey: string }> }) {
  const { slug, stableKey } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const access = await requireProductAccess(user, slug);
  if (!access) notFound();
  const featureId = await resolveFeatureByStableKey(access.product.id, decodeURIComponent(stableKey));
  if (featureId === null) notFound();
  redirect(`/products/${slug}?view=spec&feature=${featureId}`);
}

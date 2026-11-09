import { notFound, redirect } from "next/navigation";
import { productBasePath } from "@/lib/product-links";
import { resolveScenarioByStableKey } from "@/lib/stable-links";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/** 旧一段地址的场景稳定引用：解析后重定向到 canonical 产品页的规格视图。 */
export default async function LegacyStableScenarioPage({ params }: { params: Promise<{ slug: string; stableKey: string; reference: string }> }) {
  const { slug, stableKey, reference } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const access = await requireProductAccess(user, slug);
  if (!access) notFound();
  const featureId = await resolveScenarioByStableKey(access.product.id, decodeURIComponent(stableKey), decodeURIComponent(reference));
  if (featureId === null) notFound();
  redirect(`${productBasePath(access.organization.slug, slug)}?view=spec&feature=${featureId}`);
}

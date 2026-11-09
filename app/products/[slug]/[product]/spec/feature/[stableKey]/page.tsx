import { notFound, redirect } from "next/navigation";
import { defaultExecute } from "@/lib/db";
import { productBasePath } from "@/lib/product-links";
import { resolveFeatureByStableKey } from "@/lib/stable-links";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/** M3 稳定引用入口（canonical）：/products/{org}/{product}/spec/feature/[stable_key] 始终解析到最新规格里的该功能。
 *  参数名说明见 [product]/page.tsx：与旧一段地址共享首段动态名 slug，首段 = 工区 slug。 */
export default async function StableFeaturePage({ params }: { params: Promise<{ slug: string; product: string; stableKey: string }> }) {
  const { slug: org, product: slug, stableKey } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const access = await requireProductAccess(user, slug, "viewer", defaultExecute, undefined, org);
  if (!access || access.organization.slug !== org) notFound();
  const featureId = await resolveFeatureByStableKey(access.product.id, decodeURIComponent(stableKey));
  if (featureId === null) notFound();
  redirect(`${productBasePath(org, slug)}?view=spec&feature=${featureId}`);
}

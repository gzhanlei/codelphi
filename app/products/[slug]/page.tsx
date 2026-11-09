import { notFound, redirect } from "next/navigation";
import { currentOrganization } from "@/lib/organizations";
import { productBasePath } from "@/lib/product-links";
import { findProductByOldSlug } from "@/lib/product-rename";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export const dynamic = "force-dynamic";

/**
 * 旧一段地址重定向层：canonical 地址是 /products/{org}/{slug}（页面在 [org]/[slug]）。
 * 这里按登录态解析唯一目标后 307 重定向，保留原查询参数：
 * 1) 当前上下文可访问 → 该产品的 canonical 地址；
 * 2) 改名历史（限可访问工作区，cookie 工作区优先）→ 新地址；
 * 3) 公开 demo → canonical demo 地址；匿名非 demo → 登录页；其余按不存在处理。
 */
export default async function LegacyProductPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const rawParams = await searchParams;
  const query = new URLSearchParams(Object.entries(rawParams).filter(([, value]) => value !== undefined) as Array<[string, string]>).toString();
  const suffix = query ? `?${query}` : "";

  const user = await getSessionUser();
  if (user) {
    const access = await requireProductAccess(user, slug);
    if (access) redirect(`${productBasePath(access.organization.slug, slug)}${suffix}`);
    const organization = await currentOrganization(user);
    const relocated = await findProductByOldSlug(slug, { userSub: user.sub, preferredOrgId: organization.id });
    if (relocated) redirect(`${productBasePath(relocated.orgSlug, relocated.slug)}${suffix}`);
    // 登录用户对公开 demo 无访问权限时仍按匿名可见性放行（与原行为一致）。
    const memberDemo = await resolveLegacyPublicDemoProduct(slug);
    if (memberDemo) redirect(`${productBasePath(memberDemo.organizationSlug, slug)}${suffix}`);
    notFound();
  }

  const demo = await resolveLegacyPublicDemoProduct(slug);
  if (demo) redirect(`${productBasePath(demo.organizationSlug, slug)}${suffix}`);
  redirect("/login");
}

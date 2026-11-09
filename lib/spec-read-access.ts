import { requireProductAccess } from "./product-access";
import { resolveLegacyPublicDemoProduct } from "./public-demo";
import { getSessionUser } from "./session";

export type SpecReadAccess =
  | { ok: true; productId: number }
  | { ok: false; status: 401 | 404; error: string };

/** 规格只读接口共用：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function resolveSpecReadProductId(slug: string): Promise<SpecReadAccess> {
  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  if (access) return { ok: true, productId: access.product.id };
  const demo = await resolveLegacyPublicDemoProduct(slug);
  if (!demo) {
    return { ok: false, status: user ? 404 : 401, error: user ? "产品不存在或不属于当前工作区" : "未登录" };
  }
  return { ok: true, productId: demo.id };
}

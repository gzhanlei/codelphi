import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadReleasePage } from "@/lib/product-details";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { publicDemoSlugs } from "@/lib/env";

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

/** 发布变化列表分页：登录成员按工作区读取；公开 demo 产品允许只读分页（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  const { offset, limit } = parsed.data;

  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  if (!access && !publicDemoSlugs().has(slug)) {
    if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
    return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  }
  const organizationId = access?.product.organizationId;
  const page = await loadReleasePage(slug, organizationId, offset, limit);
  if (!page) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  return NextResponse.json(page);
}

import { NextRequest, NextResponse } from "next/server";
import { searchSpec } from "@/lib/spec-search";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const query = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchSpec(access.product.id, query));
}

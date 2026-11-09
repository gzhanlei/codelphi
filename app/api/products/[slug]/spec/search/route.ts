import { NextRequest, NextResponse } from "next/server";
import { searchSpec } from "@/lib/spec-search";
import { resolveSpecReadProductId } from "@/lib/spec-read-access";

/** M3 产品内搜索：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const access = await resolveSpecReadProductId(slug);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const query = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await searchSpec(access.productId, query));
}

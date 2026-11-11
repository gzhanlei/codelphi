import { NextRequest, NextResponse } from "next/server";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { loadPublishedChangelog, renderChangelogDocument } from "@/lib/changelog";
import { enforceExportRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * M11 可信 changelog 聚合页（Specsight 形状）：匿名只读，按产品聚合全部已发布发布稿。
 * 门控 = 产品公开演示开关（migration 025）；非公开产品 404（防存在性泄露）。
 * 展示边界（R5）：正文只写用户影响语言；证据路径与规格锚点收进折叠「全部变化」，
 * 功能条目链接到产品规格页（公开 demo 产品匿名可达）。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ org: string; product: string }> }) {
  const { org, product } = await context.params;
  const limited = await enforceExportRateLimit(request, null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const demo = await resolvePublicDemoProduct(org, product);
  if (!demo) {
    return NextResponse.json({ error: "产品不存在或未开放" }, { status: 404 });
  }
  const entries = await loadPublishedChangelog(demo.id);
  const html = renderChangelogDocument({
    productName: demo.name,
    specBase: `/products/${org}/${product}`,
    entries,
  }).replace(
    '<a class="back" href="/">← 返回</a>',
    `<a class="back" href="/products/${org}/${product}">← 产品页</a>`
  );
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

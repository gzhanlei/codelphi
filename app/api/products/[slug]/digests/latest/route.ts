import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { renderDigestText } from "@/lib/digest-sweep";
import type { DigestContent } from "@/lib/digest";
import { parseJsonValue } from "@/lib/json";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/** 最近一期周期行为摘要（Digest 读侧）：登录成员可查，返回 Markdown 与原文。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const db = getDb();
  const result = await db.execute(
    `SELECT period_start AS periodStart, period_end AS periodEnd, content_json AS contentJson, created_at AS createdAt
     FROM digests WHERE product_id = ? ORDER BY period_start DESC LIMIT 1`,
    [access.product.id],
  ) as unknown;
  const rows = (Array.isArray(result) ? result[0] : result) as Array<{
    periodStart: string; periodEnd: string; contentJson: unknown; createdAt: Date;
  }>;
  const row = rows?.[0];
  if (!row) return NextResponse.json({ digest: null });
  const content = parseJsonValue(row.contentJson) as DigestContent | null;
  if (!content || !Array.isArray(content.changes)) return NextResponse.json({ digest: null });
  return NextResponse.json({
    digest: {
      periodStart: String(row.periodStart),
      periodEnd: String(row.periodEnd),
      createdAt: row.createdAt,
      markdown: renderDigestText(access.product.name, content),
      changes: content.changes.length,
      audiences: {
        support: content.audiences.support.length,
        sales: content.audiences.sales.length,
        marketing: content.audiences.marketing.length,
      },
    },
  });
}

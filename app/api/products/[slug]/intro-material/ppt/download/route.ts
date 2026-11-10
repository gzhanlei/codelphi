import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { loadIntroMaterial } from "@/lib/intro-material-service";
import { getPptDownload, PptPartnerError, requirePptPartnerConfig } from "@/lib/ppt-partner";

/** PPTX 下载代理：预签名链接 5 分钟有效，现取现转，不落本地文件。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const details = await getProductDetailsLite(slug, access.product.organizationId);
  const specVersionId = details?.specVersionId ?? null;
  const material = await loadIntroMaterial(getDb().execute.bind(getDb()), access.product.id, specVersionId);
  if (!material?.pptProjectId || !material.pptJobId) return NextResponse.json({ error: "尚无 PPT 任务" }, { status: 404 });
  const config = requirePptPartnerConfig();
  let download: { url: string; filename?: string | null };
  try {
    download = await getPptDownload(config, material.pptJobId, material.pptProjectId);
  } catch (error) {
    if (error instanceof PptPartnerError) return NextResponse.json({ error: `${error.code}: ${error.message}` }, { status: 502 });
    return NextResponse.json({ error: "获取下载链接失败" }, { status: 502 });
  }
  const upstream = await fetch(download.url, { cache: "no-store", signal: AbortSignal.timeout(120_000) });
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: `PPT 文件拉取失败（HTTP ${upstream.status}）` }, { status: 502 });
  const filename = download.filename ?? `${slug}-intro.pptx`;
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}

/** 轻量取当前 spec 版本号（避免为下载拉全量详情）。 */
async function getProductDetailsLite(slug: string, organizationId?: number): Promise<{ specVersionId: number | null } | null> {
  const db = getDb();
  const [rows] = await db.execute(
    organizationId === undefined
      ? "SELECT spec_version_id AS specVersionId FROM releases WHERE product_id = (SELECT id FROM products WHERE slug = ?) ORDER BY committed_at DESC LIMIT 1"
      : "SELECT r.spec_version_id AS specVersionId FROM releases r JOIN products p ON p.id = r.product_id WHERE p.slug = ? AND p.organization_id = ? ORDER BY r.committed_at DESC LIMIT 1",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const row = (rows as Array<{ specVersionId: number | null }>)[0];
  return row ? { specVersionId: row.specVersionId === null ? null : Number(row.specVersionId) } : null;
}

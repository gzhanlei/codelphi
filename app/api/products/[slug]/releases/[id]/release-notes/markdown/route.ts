import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { renderReleaseNoteMarkdown, releaseNotePublicUrl } from "@/lib/release-notes";
import { loadBlockViews, loadNoteByRelease, releaseOwned } from "@/lib/release-notes-service";
import { enforceExportRateLimit } from "@/lib/rate-limit";
import { appUrl } from "@/lib/env";

/** 发布稿 Markdown 导出（§4.3「Copy as Markdown」出口）：登录成员可导出草稿/已发布稿。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json({ error: "发布不存在" }, { status: 404 });
  const db = getDb();
  if (!(await releaseOwned(db.execute.bind(db), releaseId, access.product.id))) {
    return NextResponse.json({ error: "发布不存在" }, { status: 404 });
  }
  const note = await loadNoteByRelease(db.execute.bind(db), releaseId);
  if (!note) return NextResponse.json({ error: "该发布尚未生成发布稿" }, { status: 404 });
  const [releaseRows] = await db.execute(
    "SELECT title, sha, url FROM releases WHERE id = ?",
    [releaseId],
  );
  const release = (releaseRows as Array<{ title: string; sha: string; url: string | null }>)[0];
  const blocks = await loadBlockViews(db.execute.bind(db), note.id);
  const markdown = renderReleaseNoteMarkdown({
    productName: access.product.name,
    releaseTitle: release?.title ?? `#${releaseId}`,
    releaseSha: release?.sha ?? "",
    releaseUrl: release?.url ?? null,
    blocks,
    emphasis: note.emphasis,
    publicUrl: releaseNotePublicUrl(appUrl(), note.shareToken),
  });
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-release-notes-${releaseId}.md"`,
    },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { canPublish, releaseNotePublicUrl } from "@/lib/release-notes";
import { loadNoteById } from "@/lib/release-notes-service";
import { appUrl } from "@/lib/env";

/**
 * A2 发布状态机（§4.3 验收）：draft → publish（人工点击，一次性事务写 published_at
 * 与 share_token）→ published（只读，需下线才能改）→ unpublish（同 URL 下线）。
 * 发布前再跑一次锚定校验：块锚定的 spec_change 不存在即拒绝（R1 门禁）。
 * PATCH（GTM 桥面批次 1）：草稿期块级校对——全局 emphasis + 每块 emphasis/summary_override；
 * 已发布 409，与「先下线才能改」一致。
 */

function noteResponse(status: string, shareToken: string | null) {
  return NextResponse.json({ status, shareToken, publicUrl: releaseNotePublicUrl(appUrl(), shareToken) });
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId: noteIdParam } = await context.params;
  const noteId = Number(noteIdParam);
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  const action = body.action === "unpublish" ? "unpublish" : "publish";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: 404 });
  const db = getDb();
  const note = await loadNoteById(db.execute.bind(db), noteId, access.product.id);
  if (!note) return NextResponse.json({ error: "发布稿不存在" }, { status: 404 });

  if (action === "unpublish") {
    if (note.status !== "published") return NextResponse.json({ error: "仅已发布的稿可下线" }, { status: 400 });
    await db.execute("UPDATE release_notes SET status = 'unpublished', unpublished_at = NOW(3) WHERE id = ?", [noteId]);
    return noteResponse("unpublished", note.shareToken);
  }

  if (note.status === "published") return NextResponse.json({ error: "已发布只读：先下线才能改" }, { status: 409 });
  const [blockRows] = await db.execute("SELECT spec_change_id FROM release_note_blocks WHERE release_note_id = ? ORDER BY position", [noteId]);
  const blocks = (blockRows as Array<{ spec_change_id: number }>).map((row) => ({ specChangeId: row.spec_change_id }));
  const [changeRows] = await db.execute(
    "SELECT c.id FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id WHERE r.id = ?",
    [note.releaseId],
  );
  const existing = new Set((changeRows as Array<{ id: number }>).map((row) => row.id));
  const gate = canPublish(blocks, existing);
  if (gate) return NextResponse.json({ error: gate }, { status: 400 });
  await db.execute(
    "UPDATE release_notes SET status = 'published', published_at = NOW(3), unpublished_at = NULL WHERE id = ? AND status <> 'published'",
    [noteId],
  );
  return noteResponse("published", note.shareToken);
}

/** 草稿期块级校对：全局强调语 + 每块 emphasis / summary_override（人工措辞，锚定不变）。 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId: noteIdParam } = await context.params;
  const noteId = Number(noteIdParam);
  const body = (await request.json().catch(() => ({}))) as {
    emphasis?: string;
    blocks?: Array<{ position: number; emphasis?: string; summaryOverride?: string | null }>;
  };
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: 404 });
  const db = getDb();
  const note = await loadNoteById(db.execute.bind(db), noteId, access.product.id);
  if (!note) return NextResponse.json({ error: "发布稿不存在" }, { status: 404 });
  if (note.status === "published") return NextResponse.json({ error: "已发布只读：先下线才能改" }, { status: 409 });

  const updates = (body.blocks ?? []).filter((block) => Number.isInteger(block.position) && block.position > 0);
  if (body.emphasis === undefined && updates.length === 0) {
    return NextResponse.json({ error: "没有要保存的修改" }, { status: 400 });
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (body.emphasis !== undefined) {
      await connection.execute("UPDATE release_notes SET emphasis = ? WHERE id = ?", [String(body.emphasis), noteId]);
    }
    for (const block of updates) {
      const fields: string[] = [];
      const values: Array<string | null> = [];
      if (block.emphasis !== undefined) {
        fields.push("emphasis = ?");
        values.push(String(block.emphasis));
      }
      if (block.summaryOverride !== undefined) {
        const override = (block.summaryOverride ?? "").trim();
        fields.push("summary_override = ?");
        values.push(override ? override : null);
      }
      if (fields.length === 0) continue;
      await connection.execute(
        `UPDATE release_note_blocks SET ${fields.join(", ")} WHERE release_note_id = ? AND position = ?`,
        [...values, noteId, block.position],
      );
    }
    await connection.commit();
  } catch (cause) {
    await connection.rollback();
    throw cause;
  } finally {
    connection.release();
  }
  return NextResponse.json({ status: note.status, saved: true });
}

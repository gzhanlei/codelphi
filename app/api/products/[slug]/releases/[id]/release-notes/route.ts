import { NextRequest, NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { randomBytes } from "node:crypto";
import { buildDraftBlocks, canPublish, publishOrder, releaseNotePublicUrl, validateDraft } from "@/lib/release-notes";
import { loadBlockViews, loadNoteByRelease, releaseChanges, releaseOwned } from "@/lib/release-notes-service";
import { rewriteDraftBlocksToUserVoice } from "@/lib/release-notes-enhance";
import { requestStructuredCompletion } from "@/lib/ai";
import { appUrl } from "@/lib/env";

/**
 * A2 Release notes 草稿与发布（docs/specsight-gap-improvement-plan.md §4.3）。
 * GET：viewer 可读——无稿返回候选变更（不自动全选），有稿返回块视图（含人工 override）。
 * POST：editor/owner 起草；生成阶段做引用存在性校验（锚定缺失 / 越界证据直接 400，R1 门禁）。
 * 加固（GTM 桥面批次 1）：release 归属按产品校验；已发布稿拒绝重新生成（409，公开页只读）；
 * blocks 重写包进事务；share_token 仅首次插入生成，重生成不换公开链接。
 */

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json({ error: "发布不存在" }, { status: 404 });
  const db = getDb();
  if (!(await releaseOwned(db.execute.bind(db), releaseId, access.product.id))) {
    return NextResponse.json({ error: "发布不存在" }, { status: 404 });
  }
  const note = await loadNoteByRelease(db.execute.bind(db), releaseId);
  const candidates = publishOrder(await releaseChanges(db.execute.bind(db), releaseId));
  if (!note) {
    return NextResponse.json({ note: null, blocks: [], candidates });
  }
  return NextResponse.json({
    note: {
      id: note.id,
      status: note.status,
      emphasis: note.emphasis ?? "",
      voiceId: note.voiceId,
      shareToken: note.shareToken,
      publicUrl: releaseNotePublicUrl(appUrl(), note.shareToken),
      publishedAt: note.publishedAt,
      unpublishedAt: note.unpublishedAt,
    },
    blocks: await loadBlockViews(db.execute.bind(db), note.id),
    candidates,
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { slug?: string; releaseId?: number; selectedIds?: number[]; emphasis?: string; voiceId?: number | null };
  const slug = String(body.slug ?? "");
  const releaseId = Number(body.releaseId ?? 0);
  const access = await requireProductAccess(user, slug, "editor");
  if (!access || !releaseId) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: 404 });
  const db = getDb();
  // 归属校验：release 必须属于该产品，防止把别的产品的发布挂进草稿。
  if (!(await releaseOwned(db.execute.bind(db), releaseId, access.product.id))) {
    return NextResponse.json({ error: "发布不存在" }, { status: 404 });
  }
  const existing = await loadNoteByRelease(db.execute.bind(db), releaseId);
  // 已发布只读（R1）：重新生成会 DELETE+重建全部块、公开页随之变化，必须先下线。
  if (existing?.status === "published") {
    return NextResponse.json({ error: "已发布只读：先下线才能重新生成" }, { status: 409 });
  }
  const changes = await releaseChanges(db.execute.bind(db), releaseId);
  const blocks = buildDraftBlocks(changes, body.selectedIds);
  // 生成阶段引用存在性校验（§4.3 验收第 2 条，类似 assertEvidence 的引用校验）
  const validation = validateDraft(blocks, changes);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
  const publishGate = canPublish(blocks, new Set(changes.map((change) => change.id)));
  if (publishGate) return NextResponse.json({ error: publishGate }, { status: 400 });

  const shareToken = existing?.shareToken ?? randomBytes(16).toString("hex");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO release_notes (product_id, release_id, voice_id, emphasis, status, share_token, created_by)
       VALUES (?, ?, ?, ?, 'draft', ?, (SELECT id FROM users WHERE chandler_sub = ? LIMIT 1))
       ON DUPLICATE KEY UPDATE emphasis = VALUES(emphasis), voice_id = VALUES(voice_id), updated_at = NOW(3)`,
      [access.product.id, releaseId, body.voiceId ?? null, String(body.emphasis ?? ""), shareToken, user.sub],
    );
    const [idRows] = await connection.execute("SELECT id FROM release_notes WHERE release_id = ?", [releaseId]);
    const noteId = Number((idRows as Array<{ id: number }>)[0]?.id ?? 0);
    await connection.execute("DELETE FROM release_note_blocks WHERE release_note_id = ?", [noteId]);
    for (const block of blocks) {
      await connection.execute(
        `INSERT INTO release_note_blocks (release_note_id, position, spec_change_id, emphasis, summary_override)
         VALUES (?, ?, ?, ?, NULL)`,
        [noteId, block.position, block.specChangeId, block.emphasis],
      );
    }
    await connection.commit();

    // 草稿文案人话化（异步，不阻塞面板）：规格 diff 语言 → 用户影响语言。
    // 锚定/证据不变（只写 summary_override），失败保留原文；面板刷新即见改写结果。
    after(async () => {
      try {
        const blocks = await loadBlockViews(db.execute.bind(db), noteId);
        if (blocks.length === 0) return;
        const outcome = await rewriteDraftBlocksToUserVoice(
          { execute: (sql: string, params?: unknown[]) => db.execute(sql, params as never) },
          { completion: (messages, billing) => requestStructuredCompletion(messages, billing) },
          { noteId, emphasis: String(body.emphasis ?? ""), blocks: blocks.map((block) => ({ position: block.position, kind: block.kind, featureName: block.featureName, scenarioReference: block.scenarioReference, summary: block.summary, highlightType: block.highlightType })) },
        );
        console.log("[release-notes] manual draft copy rewritten", { releaseId, ...outcome });
      } catch (error) {
        console.warn("[release-notes] manual draft rewrite skipped", { releaseId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
    });

    return NextResponse.json({ noteId, status: "draft", shareToken, publicUrl: releaseNotePublicUrl(appUrl(), shareToken) });
  } catch (cause) {
    await connection.rollback();
    throw cause;
  } finally {
    connection.release();
  }
}

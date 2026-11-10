import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { requestStructuredCompletion } from "@/lib/ai";
import { buildEnhancePrompt, parseEnhancedSummary } from "@/lib/release-notes-enhance";
import { loadNoteById } from "@/lib/release-notes-service";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/**
 * Enhance 单块改写（A2 §4.3-3）：对草稿块调 AI 重写措辞，返回建议文本；
 * 不自动落库——人工确认后经 PATCH 存 summary_override（人在环）。
 * 已发布 409（先下线才能改）；计费=免费+如实记账（call_kind='release_note_enhance'）。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ slug: string; noteId: string }> }) {
  const { slug, noteId: noteIdParam } = await context.params;
  const noteId = Number(noteIdParam);
  const body = (await request.json().catch(() => ({}))) as { position?: number; instruction?: string };
  const position = Number(body.position ?? 0);
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: 404 });
  const db = getDb();
  const note = await loadNoteById(db.execute.bind(db), noteId, access.product.id);
  if (!note) return NextResponse.json({ error: "发布稿不存在" }, { status: 404 });
  if (note.status === "published") return NextResponse.json({ error: "已发布只读：先下线才能改" }, { status: 409 });
  const blockResult = await db.execute(
    `SELECT b.emphasis, c.kind, c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
            COALESCE(NULLIF(b.summary_override, ''), c.summary) AS summary, c.highlight_type AS highlightType
     FROM release_note_blocks b JOIN spec_changes c ON c.id = b.spec_change_id
     WHERE b.release_note_id = ? AND b.position = ?`,
    [noteId, position],
  ) as unknown;
  const blockRows = (Array.isArray(blockResult) ? blockResult[0] : blockResult) as Array<{
    emphasis: string; kind: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null;
  }>;
  const block = blockRows?.[0];
  if (!block) return NextResponse.json({ error: "块不存在" }, { status: 404 });

  try {
    const content = await requestStructuredCompletion(
      [
        { role: "system", content: "你是严谨的发布说明编辑，只改写措辞不改变事实。" },
        { role: "user", content: buildEnhancePrompt({
          kind: block.kind,
          featureName: block.featureName,
          scenarioReference: block.scenarioReference,
          summary: block.summary,
          highlightType: block.highlightType,
          emphasis: note.emphasis ?? "",
          instruction: String(body.instruction ?? ""),
        }) },
      ],
      { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
    );
    return NextResponse.json({ suggestion: parseEnhancedSummary(content) });
  } catch (error) {
    return NextResponse.json({ error: `改写失败：${error instanceof Error ? error.message : "AI 调用异常"}` }, { status: 502 });
  }
}

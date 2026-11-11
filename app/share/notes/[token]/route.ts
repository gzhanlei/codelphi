import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { enforceExportRateLimit } from "@/lib/rate-limit";
import { applySummaryOverride } from "@/lib/release-notes";
import { renderChangelogDocument, parseFeatureCopyRows } from "@/lib/changelog";

/**
 * A2 公开只读页（M11）：匿名访问，按 share_token 定位单条发布稿。
 * 展示（Specsight 形状）：H1=发布标题 → 来源行 → 导语 → 新增/改进/移除分节
 * （正文只写用户影响，场景号/类型码不进正文；人工改写优先）→ 折叠「全部变化」。
 * 隐私边界（R5）：证据以路径形式收进折叠区，不展示代码内容；下线后同 URL 404。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const limited = await enforceExportRateLimit(request, null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const db = getDb();
  const [noteRows] = await db.execute(
    `SELECT n.id, n.status, n.emphasis, n.headline, n.lead_override AS leadOverride, n.feature_copy_json AS featureCopyJson, n.published_at AS publishedAt, n.release_id AS releaseId,
            r.title AS releaseTitle, r.summary AS releaseSummary, r.sha AS releaseSha, r.url AS releaseUrl, r.committed_at AS committedAt,
            p.name AS productName
     FROM release_notes n JOIN releases r ON r.id = n.release_id JOIN products p ON p.id = n.product_id
     WHERE n.share_token = ? AND n.status = 'published'`,
    [token],
  );
  const note = (noteRows as Array<{
    id: number; status: string; emphasis: string; headline: string | null; leadOverride: string | null; featureCopyJson: unknown; publishedAt: Date; releaseId: number;
    releaseTitle: string; releaseSummary: string | null; releaseSha: string; releaseUrl: string | null; committedAt: Date; productName: string;
  }>)[0];
  if (!note) return NextResponse.json({ error: "发布稿不存在或已下线" }, { status: 404 });
  const [blockRows] = await db.execute(
    `SELECT b.position, b.summary_override AS summaryOverride,
            c.kind, c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
            c.summary, c.highlight_type AS highlightType, c.before_json AS beforeJson, c.after_json AS afterJson
     FROM release_note_blocks b
     JOIN spec_changes c ON c.id = b.spec_change_id
     WHERE b.release_note_id = ? ORDER BY b.position`,
    [note.id],
  );
  console.log("[share-notes-dbg] row:", JSON.stringify({ id: note.id, leadOverride: note.leadOverride, featureCopyJson: note.featureCopyJson === null ? null : String(note.featureCopyJson).slice(0, 80), status: note.status }));
  const blocks = (blockRows as Array<{ position: number; summaryOverride: string | null; kind: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null; beforeJson: unknown; afterJson: unknown }>).map((row) => ({
    position: Number(row.position),
    kind: row.kind,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    ...applySummaryOverride(row.summary, row.summaryOverride),
    highlightType: row.highlightType,
    evidencePaths: [...evidencePathsOf(row.beforeJson), ...evidencePathsOf(row.afterJson)],
  }));
  const html = renderChangelogDocument({
    productName: note.productName,
    specBase: null,
    entries: [{
      releaseTitle: note.releaseTitle,
      headline: note.headline,
      leadOverride: note.leadOverride,
      featureCopy: parseFeatureCopyRows(note.featureCopyJson),
      releaseSummary: note.releaseSummary ?? "",
      releaseSha: note.releaseSha,
      releaseUrl: note.releaseUrl,
      committedAt: note.committedAt,
      publishedAt: note.publishedAt,
      emphasis: note.emphasis ?? "",
      blocks,
    }],
  });
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "x-debug-release": "20261112-feature-copy" } });
}

function evidencePathsOf(subject: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const scenarios = (subject as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return [];
  return scenarios.flatMap((scenario) => {
    const evidence = (scenario as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) return [];
    return evidence.map((item) => String((item as { path?: string }).path ?? "")).filter(Boolean);
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * A2 公开只读页（M11 扩展）：匿名访问，按 share_token 定位。
 * 隐私边界（R5）：只展示行为变化与证据路径，不展示代码内容；
 * 页面明确说明「链接对无权限者不可达」。已下线（unpublished）的稿同 URL 不再展示。
 */
function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface BlockRow {
  kind: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  highlightType: string | null;
  evidencePaths: string[];
}

export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const db = getDb();
  const [noteRows] = await db.execute(
    `SELECT n.id, n.published_at AS publishedAt, p.name AS productName
     FROM release_notes n JOIN products p ON p.id = n.product_id
     WHERE n.share_token = ? AND n.status = 'published'`,
    [token],
  );
  const note = (noteRows as Array<{ id: number; publishedAt: Date; productName: string }>)[0];
  if (!note) return NextResponse.json({ error: "发布稿不存在或已下线" }, { status: 404 });
  const [blockRows] = await db.execute(
    `SELECT b.spec_change_id, c.kind, c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
            c.summary, c.highlight_type AS highlightType, c.before_json AS beforeJson, c.after_json AS afterJson
     FROM release_note_blocks b
     JOIN spec_changes c ON c.id = b.spec_change_id
     WHERE b.release_note_id = ? ORDER BY b.position`,
    [note.id],
  );
  const blocks = (blockRows as Array<{ spec_change_id: number; kind: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null; beforeJson: unknown; afterJson: unknown }>).map((row) => ({
    kind: row.kind,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    summary: row.summary,
    highlightType: row.highlightType,
    evidencePaths: [
      ...evidencePathsOf(row.beforeJson),
      ...evidencePathsOf(row.afterJson),
    ],
  }));
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(note.productName)} 发布说明 · CoDelphi</title><style>body{font-family:system-ui;max-width:720px;margin:8vh auto;padding:0 16px;color:#1a1a1a}.change{border-top:1px solid #eee;padding:12px 0}.kind{font-size:12px;color:#666}.path{font-family:monospace;font-size:12px;color:#36c}.note{font-size:13px;color:#888}</style></head><body>
<h1>${esc(note.productName)} 发布说明</h1>
<p class="note">发布于 ${esc(note.publishedAt.toISOString().slice(0, 10))} · 由 CoDelphi 从规格变更生成，人工审核后发布。</p>
${blocks.map((block: BlockRow, index: number) => `<div class="change">
<div class="kind">[${esc(block.kind)}] ${esc(block.featureName)}${block.scenarioReference ? ` · ${esc(block.scenarioReference)}` : ""}${block.highlightType ? ` · Highlight: ${esc(block.highlightType)}` : ""}</div>
<p>${esc(block.summary)}</p>
<div>${block.evidencePaths.map((path) => `<span class="path">${esc(path)}</span>`).join(" ")}</div>
</div>`).join("\n")}
<p class="note">证据路径指向源码仓库；链接对无仓库权限者不可达，本页不展示代码内容。</p>
</body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
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

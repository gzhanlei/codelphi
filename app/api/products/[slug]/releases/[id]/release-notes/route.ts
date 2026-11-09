import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { randomBytes } from "node:crypto";
import { buildDraftBlocks, canPublish, validateDraft, type ReleaseNoteChange } from "@/lib/release-notes";

/**
 * A2 Release notes 草稿与发布（docs/specsight-gap-improvement-plan.md §4.3）。
 * 角色门槛：editor/owner 才能起草；人工 POST publish 才发布（R1 门禁）；
 * 生成阶段做引用存在性校验——锚定缺失 / 越界证据的草稿直接 400，不落库。
 */
async function releaseChanges(execute: ReturnType<typeof getDb>["execute"], releaseId: number): Promise<ReleaseNoteChange[]> {
  const [rows] = await execute(
    `SELECT c.id, c.kind, c.entity_type AS entityType, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary, c.highlight_type AS highlightType,
            c.before_json AS beforeJson, c.after_json AS afterJson
     FROM spec_changes c
     JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.id = ? AND c.wording_only = 0 ORDER BY c.id`,
    [releaseId],
  );
  const changes = rows as Array<{ id: number; kind: string; entityType: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null; beforeJson: unknown; afterJson: unknown }>;
  return changes.map((row) => ({
    id: row.id,
    kind: row.kind,
    entityType: row.entityType,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    summary: row.summary,
    highlightType: row.highlightType,
    evidencePaths: [...collectEvidencePaths(row.beforeJson), ...collectEvidencePaths(row.afterJson)],
  }));
}

function collectEvidencePaths(subject: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const scenarios = (subject as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return [];
  return scenarios.flatMap((scenario) => {
    const evidence = (scenario as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) return [];
    return evidence.map((item) => String((item as { path?: string }).path ?? "")).filter(Boolean);
  });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { slug?: string; releaseId?: number; selectedIds?: number[]; emphasis?: string; voiceId?: number | null };
  const slug = String(body.slug ?? "");
  const releaseId = Number(body.releaseId ?? 0);
  const access = await requireProductAccess(user, slug, "editor");
  if (!access || !releaseId) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: access ? 404 : 403 });
  const db = getDb();
  const changes = await releaseChanges(db.execute.bind(db), releaseId);
  const blocks = buildDraftBlocks(changes, body.selectedIds);
  // 生成阶段引用存在性校验（§4.3 验收第 2 条，类似 assertEvidence 的引用校验）
  const validation = validateDraft(blocks, changes);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
  const publishGate = canPublish(blocks, new Set(changes.map((change) => change.id)));
  if (publishGate) return NextResponse.json({ error: publishGate }, { status: 400 });

  const shareToken = randomBytes(16).toString("hex");
  const [noteResult] = await db.execute(
    `INSERT INTO release_notes (product_id, release_id, voice_id, emphasis, status, share_token, created_by)
     VALUES (?, ?, ?, ?, 'draft', ?, (SELECT id FROM users WHERE chandler_sub = ? LIMIT 1))
     ON DUPLICATE KEY UPDATE emphasis = VALUES(emphasis), voice_id = VALUES(voice_id), updated_at = NOW(3)`,
    [access.product.id, releaseId, body.voiceId ?? null, String(body.emphasis ?? ""), shareToken, user.sub],
  );
  const noteId = Number((noteResult as { insertId: number }).insertId);
  await db.execute("DELETE FROM release_note_blocks WHERE release_note_id = ?", [noteId]);
  for (const block of blocks) {
    await db.execute(
      `INSERT INTO release_note_blocks (release_note_id, position, spec_change_id, emphasis) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE emphasis = VALUES(emphasis)`,
      [noteId, block.position, block.specChangeId, block.emphasis],
    );
  }
  return NextResponse.json({ noteId, blocks });
}

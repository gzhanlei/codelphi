import { applySummaryOverride, buildDraftBlocks, canPublish, validateDraft, type ReleaseNoteBlockView, type ReleaseNoteChange } from "./release-notes";
import type { getDb } from "./db";

/**
 * Release notes 读侧查询（生成/发布/导出三个路由共用）。
 * 块视图：DB 只持久化 position/spec_change_id/emphasis/summary_override，
 * summary 现取自 spec_changes，override 非空时人工措辞覆盖展示。
 */

type Execute = ReturnType<typeof getDb>["execute"];

export async function releaseOwned(execute: Execute, releaseId: number, productId: number): Promise<boolean> {
  const [rows] = await execute("SELECT id FROM releases WHERE id = ? AND product_id = ?", [releaseId, productId]);
  return (rows as Array<{ id: number }>).length > 0;
}

export async function releaseChanges(execute: Execute, releaseId: number): Promise<ReleaseNoteChange[]> {
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

export function collectEvidencePaths(subject: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const scenarios = (subject as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return [];
  return scenarios.flatMap((scenario) => {
    const evidence = (scenario as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) return [];
    return evidence.map((item) => String((item as { path?: string }).path ?? "")).filter(Boolean);
  });
}

export interface ReleaseNoteRow {
  id: number;
  status: string;
  emphasis: string;
  headline: string | null;
  voiceId: number | null;
  shareToken: string | null;
  publishedAt: Date | null;
  unpublishedAt: Date | null;
  releaseId: number;
}

export async function loadNoteByRelease(execute: Execute, releaseId: number): Promise<ReleaseNoteRow | null> {
  const [rows] = await execute(
    `SELECT id, status, emphasis, headline, voice_id AS voiceId, share_token AS shareToken,
            published_at AS publishedAt, unpublished_at AS unpublishedAt, release_id AS releaseId
     FROM release_notes WHERE release_id = ?`,
    [releaseId],
  );
  return (rows as ReleaseNoteRow[])[0] ?? null;
}

export async function loadNoteById(execute: Execute, noteId: number, productId: number): Promise<ReleaseNoteRow | null> {
  const [rows] = await execute(
    `SELECT id, status, emphasis, headline, voice_id AS voiceId, share_token AS shareToken,
            published_at AS publishedAt, unpublished_at AS unpublishedAt, release_id AS releaseId
     FROM release_notes WHERE id = ? AND product_id = ?`,
    [noteId, productId],
  );
  return (rows as ReleaseNoteRow[])[0] ?? null;
}

export async function loadBlockViews(execute: Execute, noteId: number): Promise<ReleaseNoteBlockView[]> {
  const [rows] = await execute(
    `SELECT b.position, b.spec_change_id AS specChangeId, b.emphasis, b.summary_override AS summaryOverride,
            c.kind, c.entity_type AS entityType, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary,
            c.highlight_type AS highlightType, c.before_json AS beforeJson, c.after_json AS afterJson
     FROM release_note_blocks b
     JOIN spec_changes c ON c.id = b.spec_change_id
     WHERE b.release_note_id = ? ORDER BY b.position`,
    [noteId],
  );
  return (rows as Array<{
    position: number; specChangeId: number; emphasis: string; summaryOverride: string | null;
    kind: string; entityType: string; featureName: string; scenarioReference: string; summary: string;
    highlightType: string | null; beforeJson: unknown; afterJson: unknown;
  }>).map((row) => ({
    position: Number(row.position),
    specChangeId: row.specChangeId,
    featureName: row.featureName,
    kind: row.kind,
    entityType: row.entityType,
    scenarioReference: row.scenarioReference,
    ...applySummaryOverride(row.summary, row.summaryOverride),
    highlightType: row.highlightType,
    evidencePaths: [...collectEvidencePaths(row.beforeJson), ...collectEvidencePaths(row.afterJson)],
    emphasis: row.emphasis ?? "",
  }));
}

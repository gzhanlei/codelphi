import { getDb } from "./db";
import { loadBlockViews, type ReleaseNoteRow } from "./release-notes-service";

/**
 * M11 可信 changelog 聚合页数据层（GTM 桥面）：产品全部已发布发布稿，时间倒序。
 * 隐私边界与逐发布 share 页一致（R5）：只展示行为变化与证据路径，不展示代码内容；
 * 门控 = 产品公开演示开关（migration 025 语义），非公开产品 404。
 */

export interface ChangelogEntry {
  releaseId: number;
  releaseTitle: string;
  releaseSha: string;
  releaseUrl: string | null;
  committedAt: Date;
  publishedAt: Date;
  emphasis: string;
  blocks: Awaited<ReturnType<typeof loadBlockViews>>;
}

export async function loadPublishedChangelog(productId: number, limit = 30): Promise<ChangelogEntry[]> {
  const db = getDb();
  const noteResult = await db.execute(
    `SELECT n.id, n.status, n.emphasis, n.voice_id AS voiceId, n.share_token AS shareToken,
            n.published_at AS publishedAt, n.unpublished_at AS unpublishedAt, n.release_id AS releaseId,
            r.title AS releaseTitle, r.sha AS releaseSha, r.url AS releaseUrl, r.committed_at AS committedAt
     FROM release_notes n JOIN releases r ON r.id = n.release_id
     WHERE n.product_id = ? AND n.status = 'published'
     ORDER BY n.published_at DESC LIMIT ${limit}`,
    [productId],
  ) as unknown;
  const noteRows = (Array.isArray(noteResult) ? noteResult[0] : noteResult) as Array<Omit<ReleaseNoteRow, "status" | "emphasis" | "voiceId" | "shareToken" | "publishedAt" | "unpublishedAt" | "releaseId"> & {
    status: string; emphasis: string; voiceId: number | null; shareToken: string | null; publishedAt: Date | null; unpublishedAt: Date | null; releaseId: number;
    releaseTitle: string; releaseSha: string; releaseUrl: string | null; committedAt: Date;
  }>;
  const notes = noteRows ?? [];
  const entries: ChangelogEntry[] = [];
  for (const note of notes) {
    if (note.status !== "published" || !note.publishedAt) continue;
    entries.push({
      releaseId: note.releaseId,
      releaseTitle: note.releaseTitle,
      releaseSha: note.releaseSha,
      releaseUrl: note.releaseUrl,
      committedAt: note.committedAt,
      publishedAt: note.publishedAt,
      emphasis: note.emphasis ?? "",
      blocks: await loadBlockViews(db.execute.bind(db), note.id),
    });
  }
  return entries;
}

import type { ReleaseNoteBlockView, ReleaseNoteChange } from "./release-notes";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function parse<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export interface ReleaseNoteState {
  note: {
    id: number;
    status: string;
    emphasis: string;
    voiceId: number | null;
    shareToken: string | null;
    publicUrl: string | null;
    publishedAt: string | null;
    unpublishedAt: string | null;
  } | null;
  blocks: ReleaseNoteBlockView[];
  candidates: ReleaseNoteChange[];
}

export async function loadReleaseNote(slug: string, releaseId: number, fetcher: Fetcher = fetch): Promise<ReleaseNoteState> {
  const response = await fetcher(`/api/products/${slug}/releases/${releaseId}/release-notes`, { cache: "no-store" });
  return parse<ReleaseNoteState & { error?: string }>(response, "加载发布稿失败");
}

export async function generateDraft(slug: string, releaseId: number, selectedIds: number[], emphasis: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/releases/${releaseId}/release-notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, releaseId, selectedIds, emphasis }),
  });
  await parse<{ noteId?: number; error?: string }>(response, "生成发布稿失败");
  return "generated" as const;
}

export async function saveNoteEdits(
  slug: string,
  noteId: number,
  payload: { emphasis?: string; blocks?: Array<{ position: number; emphasis?: string; summaryOverride?: string | null }> },
  fetcher: Fetcher = fetch,
) {
  const response = await fetcher(`/api/products/${slug}/release-notes/${noteId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await parse(response, "保存校对失败");
  return "saved" as const;
}

export async function setNoteStatus(slug: string, noteId: number, action: "publish" | "unpublish", fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/release-notes/${noteId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = await parse<{ status?: string; publicUrl?: string | null; error?: string }>(response, "更新发布状态失败");
  return data;
}

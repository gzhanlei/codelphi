import { getDb } from "./db";
import { parseJsonValue } from "./json";
import { loadBlockViews, type ReleaseNoteRow } from "./release-notes-service";

/**
 * M11 可信 changelog 聚合页数据层（GTM 桥面）：产品全部已发布发布稿，时间倒序。
 * 隐私边界与逐发布 share 页一致（R5）：只展示行为变化与证据路径，不展示代码内容；
 * 门控 = 产品公开演示开关（migration 025 语义），非公开产品 404。
 */

export interface FeatureCopyRow {
  feature: string;
  section: "新增" | "改进" | "修复" | "移除";
  text: string;
}

export function parseFeatureCopyRows(value: unknown): FeatureCopyRow[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is FeatureCopyRow => Boolean(item && typeof item === "object" && typeof (item as { feature?: unknown }).feature === "string" && typeof (item as { text?: unknown }).text === "string"));
}

export interface ChangelogEntry {
  releaseId: number;
  releaseTitle: string;
  /** 发布级摘要（AI 生成，面向用户可感知变化）——公开页的导语。 */
  releaseSummary: string;
  /** 导语改写（用户影响语言）；非空时优先于 releaseSummary。 */
  leadOverride: string | null;
  /** 功能级成文（合并发布：每功能一条）；非空时公开正文优先用它。 */
  featureCopy: FeatureCopyRow[];
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
            r.title AS releaseTitle, r.summary AS releaseSummary, n.lead_override AS leadOverride, n.feature_copy_json AS featureCopyJson, r.sha AS releaseSha, r.url AS releaseUrl, r.committed_at AS committedAt
     FROM release_notes n JOIN releases r ON r.id = n.release_id
     WHERE n.product_id = ? AND n.status = 'published'
     ORDER BY n.published_at DESC LIMIT ${limit}`,
    [productId],
  ) as unknown;
  const noteRows = (Array.isArray(noteResult) ? noteResult[0] : noteResult) as Array<Omit<ReleaseNoteRow, "status" | "emphasis" | "voiceId" | "shareToken" | "publishedAt" | "unpublishedAt" | "releaseId"> & {
    status: string; emphasis: string; voiceId: number | null; shareToken: string | null; publishedAt: Date | null; unpublishedAt: Date | null; releaseId: number;
    releaseTitle: string; releaseSummary: string | null; leadOverride: string | null; featureCopyJson: unknown; releaseSha: string; releaseUrl: string | null; committedAt: Date;
  }>;
  const notes = noteRows ?? [];
  const entries: ChangelogEntry[] = [];
  for (const note of notes) {
    if (note.status !== "published" || !note.publishedAt) continue;
    entries.push({
      releaseId: note.releaseId,
      releaseTitle: note.releaseTitle,
      releaseSummary: note.releaseSummary ?? "",
      leadOverride: note.leadOverride ?? null,
      featureCopy: parseFeatureCopyRows(note.featureCopyJson),
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

const KIND_SECTION: Record<string, string> = { added: "新增", changed: "改进", removed: "移除" };
const SECTION_ORDER = ["新增", "改进", "修复", "移除"];

/** 修复分节判定（确定性）：summary 含修复/fix 语义信号 → Fixed；其余按 kind。 */
function sectionOf(block: { kind: string; summary: string }): string {
  if (/修复|fix(ed)?\s|bug/i.test(block.summary)) return "修复";
  return KIND_SECTION[block.kind] ?? "改进";
}

function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(date));
}

/**
 * M11 可信 changelog 文档渲染（Specsight 形状，2026-11-11 调研对齐）：
 * H1 = 发布标题 → 来源行（日期 + 源码链接，路径不铺正文）→ 导语（发布级摘要）→
 * 新增/改进/移除 分节（每条 = **功能**：一句话用户影响；场景号/类型码/Highlight 不进正文）→
 * 折叠「全部变化」按功能分组（条目链接到产品规格页——内部 ID 藏在链接后面）。
 */
export interface ChangelogDocBlock {
  kind: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  highlightType?: string | null;
  evidencePaths?: string[];
}

export interface ChangelogDocEntry {
  releaseTitle: string;
  /** 合成公告标题（Specsight 的 H1）；缺省回退 releaseTitle。 */
  headline?: string | null;
  /** 功能级成文（合并发布正文）：每功能一条用户可读说明按分类分节；缺省回退块合并。 */
  featureCopy?: Array<{ feature: string; section: string; text: string }>;
  /** 导语改写（用户影响语言）；缺省用 releaseSummary。 */
  leadOverride?: string | null;
  releaseSummary?: string | null;
  releaseSha: string;
  releaseUrl?: string | null;
  committedAt: Date;
  publishedAt: Date;
  emphasis?: string | null;
  blocks: ChangelogDocBlock[];
}

export function renderChangelogDocument(input: {
  productName: string;
  specBase?: string | null;
  entries: ChangelogDocEntry[];
}): string {
  const body = input.entries.map((entry: ChangelogDocEntry & { emphasis?: string | null }) => {
    // 合并发布成文优先：feature_copy_json 的每功能一条用户可读说明按分类分节；
    // 未生成时回退为块条目，并把同一功能的多条合并成一个条目（句子「；」连接）
    const fromCopy = Array.isArray(entry.featureCopy) && entry.featureCopy.length > 0;
    const sections = new Map<string, Array<{ featureName: string; text: string }>>();
    if (fromCopy) {
      for (const copy of entry.featureCopy!) {
        sections.set(copy.section, [...(sections.get(copy.section) ?? []), { featureName: copy.feature, text: copy.text }]);
      }
    } else {
      for (const block of entry.blocks) {
        const label = sectionOf(block);
        sections.set(label, [...(sections.get(label) ?? []), { featureName: block.featureName, text: block.summary }]);
      }
    }
    const ordered = [...new Set([...SECTION_ORDER.filter((label) => sections.has(label)), ...sections.keys()])];
    let mergedBySection: Map<string, Array<{ featureName: string; text: string }>>;
    if (fromCopy) {
      mergedBySection = sections;
    } else {
      mergedBySection = new Map<string, Array<{ featureName: string; text: string }>>();
      for (const [label, blocks] of sections) {
        const byFeature = new Map<string, string[]>();
        for (const item of blocks) byFeature.set(item.featureName, [...(byFeature.get(item.featureName) ?? []), item.text]);
        mergedBySection.set(label, [...byFeature.entries()].map(([featureName, summaries]) => ({ featureName, text: summaries.join("；") })));
      }
    }
    // 按功能分组的「全部变化」（折叠区）：内部锚点藏在链接后
    const byFeature = new Map<string, typeof entry.blocks>();
    for (const block of entry.blocks) byFeature.set(block.featureName, [...(byFeature.get(block.featureName) ?? []), block]);
    const leadText = entry.leadOverride ?? entry.releaseSummary;

    return `<section class="cl-entry">
<div class="cl-meta">来源 · ${esc(formatDate(entry.publishedAt))}${entry.releaseUrl ? ` · <a href="${esc(entry.releaseUrl)}" rel="noreferrer">源码 ↗</a>` : ` · <code>${esc(entry.releaseSha.slice(0, 7))}</code>`}</div>
<h2>${esc(entry.headline || entry.releaseTitle)}</h2>
${leadText ? `<p class="cl-lead">${esc(leadText)}</p>` : ""}
${(entry.emphasis ?? "").trim() ? `<p class="cl-emphasis">${esc(entry.emphasis!.trim())}</p>` : ""}
${ordered.map((label) => `<h3 class="cl-section">${esc(label)}</h3>
<ul class="cl-list">${(mergedBySection.get(label) ?? []).map((item) => `<li><strong>${esc(item.featureName)}</strong>${item.text ? `：${esc(item.text)}` : ""}</li>`).join("")}</ul>`).join("\n")}
<details class="cl-all"><summary>全部变化（按功能）</summary>
${[...byFeature.entries()].map(([feature, blocks]) => {
    const paths = [...new Set(blocks.flatMap((block) => block.evidencePaths ?? []))];
    return `<div class="cl-feature"><h4>${esc(feature)}${input.specBase ? ` <a class="cl-spec" href="${esc(input.specBase)}/spec/feature/${encodeURIComponent(feature.toLowerCase())}">规格 ↗</a>` : ""}</h4><ul>${blocks.map((block) => `<li>${esc(block.summary)}${block.scenarioReference ? ` <code>${esc(block.scenarioReference)}</code>` : ""}</li>`).join("")}</ul>${paths.length > 0 ? `<div class="cl-paths">涉及代码：${paths.map((path) => `<code>${esc(path)}</code>`).join(" ")}</div>` : ""}</div>`;
  }).join("\n")}
</details>
</section>`;
  }).join("\n");

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(input.productName)} 变更日志</title>
<style>
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:720px;margin:0 auto;padding:48px 20px 64px;color:#1a1a1a;line-height:1.65}
.back{font-size:13px;color:#666;text-decoration:none}
.eyebrow{font-size:11px;letter-spacing:.12em;color:#0d7a4f;font-weight:700}
h1{font-size:24px;font-weight:650;margin:6px 0 4px}
.cl-entry{border-top:1px solid #eee;margin-top:28px;padding-top:10px}
.cl-meta{font-size:12px;color:#888}
.cl-meta a{color:#36c;text-decoration:none}
h2{font-size:20px;font-weight:650;margin:6px 0 8px}
.cl-lead{margin:0 0 6px;color:#333}
.cl-emphasis{margin:8px 0 0;font-size:13px;color:#7a6226;background:#faf3e2;border-radius:6px;padding:8px 12px}
.cl-section{font-size:14px;font-weight:650;color:#0d7a4f;margin:18px 0 6px}
.cl-list{margin:0;padding-left:20px}
.cl-list li{margin:5px 0}
.cl-all{margin-top:14px;font-size:13px}
.cl-all summary{cursor:pointer;color:#666}
.cl-feature{padding:8px 0;border-bottom:1px solid #f2f2f2}
.cl-feature h4{margin:0 0 4px;font-size:13px}
.cl-spec{font-size:12px;color:#36c;text-decoration:none;font-weight:400;margin-left:6px}
.cl-feature ul{margin:0;padding-left:18px;color:#444}
.cl-feature code{font-size:11px;color:#999}
.cl-paths{margin-top:4px;font-size:11px;color:#888}
.cl-paths code{margin-right:6px;font-family:monospace}
.cl-foot{margin-top:32px;font-size:12px;color:#999}
.cl-foot a{color:#36c}
@media (prefers-color-scheme: dark){body{background:#111;color:#e8e8e8}.cl-entry{border-color:#333}.cl-meta,.cl-foot,.cl-feature code{color:#999}.cl-all summary{color:#aaa}.cl-feature{border-color:#2a2a2a}.cl-feature ul{color:#ccc}}
</style></head><body>
<a class="back" href="/">← 返回</a>
<div class="eyebrow">CHANGELOG</div>
<h1>${esc(input.productName)} 变更日志</h1>
${body}
<p class="cl-foot">每条变化由 CoDelphi 从代码行为中提取并附源码依据，经人工审核后发布。${input.specBase ? `完整功能规格见<a href="${esc(input.specBase)}">产品页</a>。` : ""}</p>
</body></html>`;
}

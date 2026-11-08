import { defaultExecute, type Execute } from "./db";

export interface ProgressRelease {
  id: number;
  title: string;
  summary: string;
  sha: string;
  url: string;
  committedAt: Date;
  total: number;
  added: number;
  changed: number;
  removed: number;
}

function flatten(text: string) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function firstSentence(text: string) {
  const flat = flatten(text);
  const cut = flat.search(/[。.!；;]/);
  return cut > 0 ? flat.slice(0, cut + 1) : flat;
}

function dayLabel(date: Date) {
  return date.toISOString().slice(5, 10);
}

export interface ProgressFeatureDelta {
  featureName: string;
  scenariosAdded: number;
  scenariosChanged: number;
  scenariosRemoved: number;
}

/** CTO 进展摘要的纯渲染：窗口合计 + 能力增量聚合 + 每次发布一行（标题链接 + 首句摘要 + 计数）。 */
export function renderProgressSummary(input: { productName: string; days: number; releases: ProgressRelease[]; featureDeltas?: ProgressFeatureDelta[] }) {
  const { productName, days, releases } = input;
  const totals = releases.reduce(
    (acc, item) => ({ releases: acc.releases + 1, total: acc.total + item.total, added: acc.added + item.added, changed: acc.changed + item.changed, removed: acc.removed + item.removed }),
    { releases: 0, total: 0, added: 0, changed: 0, removed: 0 },
  );
  const lines = [
    `# 进展摘要 · ${productName}`,
    "",
    `- 统计窗口：最近 ${days} 天`,
    `- 发布 ${totals.releases} 次 · 行为变化 ${totals.total} 条（新增 ${totals.added} · 变化 ${totals.changed} · 移除 ${totals.removed}）`,
  ];
  if (releases.length === 0) {
    lines.push("", "统计窗口内没有发布。");
    return lines.join("\n");
  }
  const deltas = (input.featureDeltas ?? []).filter((delta) => delta.scenariosAdded + delta.scenariosChanged + delta.scenariosRemoved > 0);
  if (deltas.length > 0) {
    lines.push("", "## 能力进展（按功能聚合）", "");
    const visible = deltas.slice(0, 20);
    for (const delta of visible) {
      const net = delta.scenariosAdded - delta.scenariosRemoved;
      const netLabel = net !== 0 ? `，净 ${net > 0 ? "+" : ""}${net} 个场景` : "";
      lines.push(`- ${delta.featureName}：场景 +${delta.scenariosAdded} · 更新 ${delta.scenariosChanged} · 移除 ${delta.scenariosRemoved}${netLabel}`);
    }
    if (deltas.length > visible.length) lines.push(`-（其余 ${deltas.length - visible.length} 个功能有零星变化，详见下方发布明细）`);
    lines.push("", "## 发布明细", "");
  } else {
    lines.push("");
  }
  for (const item of releases) {
    const counts = item.total > 0 ? `（行为变化 ${item.total} 条：新增 ${item.added} · 变化 ${item.changed} · 移除 ${item.removed}）` : "（无行为变化）";
    lines.push(`- [${dayLabel(item.committedAt)}] [${item.title}](${item.url}) — ${firstSentence(item.summary)}${counts}`);
  }
  return lines.join("\n");
}

/** 窗口内的发布及其行为变化计数（spec_changes 按 spec 版本归属）。 */
export async function loadRecentReleasesWithChanges(productId: number, days: number, execute: Execute = defaultExecute): Promise<ProgressRelease[]> {
  const [rows] = await execute(
    `SELECT r.id, r.title, r.summary, r.sha, r.url, r.committed_at AS committedAt,
            COUNT(c.id) AS total,
            COALESCE(SUM(c.kind = 'added'), 0) AS added,
            COALESCE(SUM(c.kind = 'changed'), 0) AS changed,
            COALESCE(SUM(c.kind = 'removed'), 0) AS removed
     FROM releases r LEFT JOIN spec_changes c ON c.spec_version_id = r.spec_version_id AND c.wording_only = 0
     WHERE r.product_id = ? AND r.committed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY r.id ORDER BY r.committed_at DESC LIMIT 100`,
    [productId, days],
  ) as [Array<{ id: number; title: string; summary: string; sha: string; url: string; committedAt: Date; total: number; added: number; changed: number; removed: number }>, unknown];
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    summary: row.summary,
    sha: row.sha,
    url: row.url,
    committedAt: row.committedAt,
    total: Number(row.total),
    added: Number(row.added),
    changed: Number(row.changed),
    removed: Number(row.removed),
  }));
}

/** 能力增量聚合：窗口内按功能统计场景的新增/更新/移除（CTO 视角回答「能力进展了什么」）。 */
export async function loadWindowFeatureDeltas(productId: number, days: number, execute: Execute = defaultExecute): Promise<ProgressFeatureDelta[]> {
  const [rows] = await execute(
    `SELECT c.feature_name AS featureName,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'added'), 0) AS scenariosAdded,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'changed'), 0) AS scenariosChanged,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'removed'), 0) AS scenariosRemoved
     FROM spec_changes c
     JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND r.committed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND c.wording_only = 0
     GROUP BY c.feature_name
     ORDER BY scenariosAdded + scenariosChanged + scenariosRemoved DESC, featureName`,
    [productId, days],
  ) as [Array<{ featureName: string; scenariosAdded: number; scenariosChanged: number; scenariosRemoved: number }>, unknown];
  return rows.map((row) => ({
    featureName: row.featureName,
    scenariosAdded: Number(row.scenariosAdded),
    scenariosChanged: Number(row.scenariosChanged),
    scenariosRemoved: Number(row.scenariosRemoved),
  }));
}

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
  /** 窗口内新增场景的引用（去重后），用于一句确定性的能力增量描述。 */
  addedReferences?: string[];
}

/** 每项能力增量一句话：先说新增了哪些场景（能力增量），再补更新/移除，净变化收尾。全部由落库数据拼出，不经 LLM。 */
function capabilitySentence(delta: ProgressFeatureDelta) {
  const references = [...new Set(delta.addedReferences ?? [])];
  const parts: string[] = [];
  if (delta.scenariosAdded > 0) {
    parts.push(references.length > 0
      ? `新增场景 ${references.slice(0, 3).join("、")}${references.length > 3 ? " 等" : ""}`
      : `新增 ${delta.scenariosAdded} 个场景`);
  }
  if (delta.scenariosChanged > 0) parts.push(`更新 ${delta.scenariosChanged} 个场景`);
  if (delta.scenariosRemoved > 0) parts.push(`移除 ${delta.scenariosRemoved} 个场景`);
  const net = delta.scenariosAdded - delta.scenariosRemoved;
  const netLabel = net !== 0 ? `，净 ${net > 0 ? "+" : ""}${net} 个场景` : "";
  return `${parts.join("，")}${netLabel}`;
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
      lines.push(`- ${delta.featureName}：${capabilitySentence(delta)}`);
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

/** 能力增量聚合：窗口内按功能统计场景的新增/更新/移除（CTO 视角回答「能力进展了什么」）。
 *  功能改名后 spec_changes 仍存历史 feature_key，按 feature_aliases 显式归并到当前功能（不做自动合并）；
 *  显示名优先取当前规格的功能名，别名行也能归到同一能力。 */
export async function loadWindowFeatureDeltas(productId: number, days: number, execute: Execute = defaultExecute): Promise<ProgressFeatureDelta[]> {
  const [rows] = await execute(
    `SELECT COALESCE(fa.canonical_key, c.feature_key) AS featureKey,
            COALESCE(MAX(canon.name), MAX(c.feature_name)) AS featureName,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'added'), 0) AS scenariosAdded,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'changed'), 0) AS scenariosChanged,
            COALESCE(SUM(c.entity_type = 'scenario' AND c.kind = 'removed'), 0) AS scenariosRemoved,
            GROUP_CONCAT(DISTINCT CASE WHEN c.entity_type = 'scenario' AND c.kind = 'added' THEN c.scenario_reference END SEPARATOR '、') AS addedReferences
     FROM spec_changes c
     JOIN releases r ON r.spec_version_id = c.spec_version_id
     JOIN spec_versions sv ON sv.id = c.spec_version_id
     LEFT JOIN feature_aliases fa ON fa.product_id = sv.product_id AND fa.alias_key = c.feature_key
     LEFT JOIN spec_features canon ON canon.spec_version_id = (
       SELECT sv2.id FROM spec_versions sv2 WHERE sv2.product_id = sv.product_id ORDER BY sv2.id DESC LIMIT 1
     ) AND canon.stable_key = COALESCE(fa.canonical_key, c.feature_key)
     WHERE r.product_id = ? AND r.committed_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND c.wording_only = 0
     GROUP BY COALESCE(fa.canonical_key, c.feature_key)
     ORDER BY scenariosAdded + scenariosChanged + scenariosRemoved DESC, featureName`,
    [productId, days],
  ) as [Array<{ featureName: string; scenariosAdded: number; scenariosChanged: number; scenariosRemoved: number; addedReferences: string | null }>, unknown];
  return rows.map((row) => ({
    featureName: row.featureName,
    scenariosAdded: Number(row.scenariosAdded),
    scenariosChanged: Number(row.scenariosChanged),
    scenariosRemoved: Number(row.scenariosRemoved),
    addedReferences: row.addedReferences ? String(row.addedReferences).split("、").filter(Boolean) : [],
  }));
}

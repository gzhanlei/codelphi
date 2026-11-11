import { evidenceItems } from "./evidence";
import { featureHref } from "./spec-editor-ui";
import type { BehaviorChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "./types";

interface ProductOverviewInput {
  product: { id: number; slug: string; name: string; description: string; descriptionSource?: string; descriptionEvidence?: unknown };
  /** canonical 页面地址基路径 /products/{orgSlug}/{slug}，功能深链据此构造。 */
  productBase: string;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  behaviorChanges: BehaviorChangeRow[];
  latestRun?: { status: string; errorMessage?: string };
  latestReleaseNote?: { status: string; releaseId: number; publishedAt: Date | string | null; blocks: number } | null;
}

function analysisLabel(status?: string) {
  if (!status) return "尚无分析记录";
  const label = { succeeded: "最近分析成功", failed: "最近分析失败", running: "正在分析", queued: "等待分析" }[status];
  return label === undefined ? `分析状态：${status}` : label;
}

function specLabel(specVersionId: number | null, sha?: string, committedAt?: Date) {
  if (specVersionId === null) return "尚未生成规格";
  const shaPart = sha ? ` · ${sha.slice(0, 7)}` : "";
  const timePart = committedAt ? ` · 更新 ${dayLabel(committedAt)}` : "";
  return `Spec v${specVersionId}${shaPart}${timePart}`;
}

function dayLabel(date: Date) {
  return `${date.toISOString().slice(5, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function compareCapabilities(a: { scenarioCount: number; name: string }, b: { scenarioCount: number; name: string }) {
  if (a.scenarioCount !== b.scenarioCount) return Math.sign(b.scenarioCount - a.scenarioCount);
  return a.name.localeCompare(b.name);
}

const changeKindPriority: Record<string, number> = { added: 0, removed: 1, changed: 2 };

/** 总览 02 面板的按功能聚合视图：大发布逐条列出会淹没在场景编号里，先给功能级摘要。 */
function groupChangesByFeature(changes: Array<{ kind: string; featureName: string }>) {
  const groups = new Map<string, { featureName: string; added: number; removed: number; changed: number }>();
  for (const change of changes) {
    const featureName = change.featureName || "未知功能";
    const group = groups.get(featureName) ?? { featureName, added: 0, removed: 0, changed: 0 };
    if (change.kind === "added") group.added += 1;
    else if (change.kind === "removed") group.removed += 1;
    else group.changed += 1;
    groups.set(featureName, group);
  }
  return [...groups.values()].sort((a, b) => (b.added + b.removed + b.changed) - (a.added + a.removed + a.changed) || a.featureName.localeCompare(b.featureName));
}

export function changeGroupLabel(group: { added: number; removed: number; changed: number }) {
  const parts = [];
  if (group.added > 0) parts.push(`新增 ${group.added}`);
  if (group.removed > 0) parts.push(`移除 ${group.removed}`);
  if (group.changed > 0) parts.push(`更新 ${group.changed}`);
  return parts.join(" · ") || "无行为变化";
}

export function buildProductOverview(input: ProductOverviewInput) {
  const latestRelease = input.releases[0];
  const specVersionId = latestRelease ? latestRelease.specVersionId : null;
  const revision = latestRelease?.sha;
  const evidencePaths = new Set(input.scenarios.flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => item.path)));
  const latestChanges = latestRelease ? input.behaviorChanges.filter((change) => change.releaseId === latestRelease.id) : [];
  const changeStats = {
    added: latestChanges.filter((change) => change.kind === "added").length,
    removed: latestChanges.filter((change) => change.kind === "removed").length,
    changed: latestChanges.filter((change) => change.kind !== "added" && change.kind !== "removed").length,
  };
  const changeGroups = groupChangesByFeature(latestChanges);
  return {
    slug: input.product.slug,
    productBase: input.productBase,
    description: input.product.description,
    headline: input.product.description.trim() || "产品概览",
    headlineSource: input.product.descriptionSource === undefined ? "manual" : input.product.descriptionSource,
    headlineEvidence: evidenceItems(input.product.descriptionEvidence),
    freshness: specLabel(specVersionId, revision, latestRelease?.committedAt),
    analysisLabel: analysisLabel(input.latestRun ? input.latestRun.status : undefined),
    capabilities: input.features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      summary: feature.summary,
      source: feature.source,
      scenarioCount: input.scenarios.filter((scenario) => scenario.featureId === feature.id).length,
      href: `${input.productBase}${featureHref(feature.id)}`,
    })).sort(compareCapabilities).slice(0, 6),
    changes: [...latestChanges]
      .sort((a, b) => (changeKindPriority[a.kind] ?? 9) - (changeKindPriority[b.kind] ?? 9) || a.id - b.id)
      .slice(0, 3),
    changeStats,
    changeGroups,
    latestRelease,
    latestReleaseNote: input.latestReleaseNote ?? null,
    trust: {
      featureCount: input.features.length,
      scenarioCount: input.scenarios.length,
      manualFeatureCount: input.features.filter((feature) => feature.source === "manual").length,
      manualScenarioCount: input.scenarios.filter((scenario) => scenario.source === "manual").length,
      evidencePathCount: evidencePaths.size,
      specVersionId,
    },
  };
}

export type ProductOverviewData = ReturnType<typeof buildProductOverview>;

import { evidenceItems } from "./evidence";
import { featureHref } from "./spec-editor-ui";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "./types";

interface ProductOverviewInput {
  product: { id: number; slug: string; name: string; description: string; descriptionSource?: string; descriptionEvidence?: unknown };
  /** canonical 页面地址基路径 /products/{orgSlug}/{slug}，功能深链据此构造。 */
  productBase: string;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  releases: ReleaseRow[];
  behaviorChanges: BehaviorChangeRow[];
  /** 发布变更说明（含 userImpact，取自 changes 表；只消费已落库文本，不在展示层生成事实）。 */
  changes?: ChangeRow[];
  latestRun?: { status: string; errorMessage?: string };
  latestReleaseNote?: { status: string; releaseId: number; publishedAt: Date | string | null; blocks: number } | null;
  /** 发布稿映射（总览时间线的状态徽章用）。 */
  releaseNotes?: Array<{ releaseId: number; status: string; headline: string | null }>;
  /** 覆盖率回执（信任行用）。 */
  coverage?: { coverageRatio: number; implFilesAssembled: number; implFilesTotal: number; partitionsCapped: boolean } | null;
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

/**
 * 最新发布的用户影响投影（设计 §6）：只复用已落库的 changes.user_impact 文本，
 * 不在展示层生成事实。最新发布没有非空用户影响时按确定性数据回退，
 * 不用更早发布冒充最新发布。
 */
function buildUserImpact(
  input: ProductOverviewInput,
  latestRelease: ReleaseRow | undefined,
  latestChanges: BehaviorChangeRow[],
  changeStats: { added: number; removed: number; changed: number },
) {
  const items = latestRelease
    ? (input.changes ?? [])
        .filter((change) => change.releaseId === latestRelease.id && change.userImpact.trim().length > 0)
        .slice(0, 3)
        .map((change) => ({ releaseId: latestRelease.id, featureName: change.featureName, userImpact: change.userImpact }))
    : [];
  const state = items.length > 0 ? "impacts" : latestRelease ? (latestChanges.length > 0 ? "changes" : "quiet") : "none";
  // 供「查看最近一次有行为变化的发布」导航：显式带日期与发布身份，不与「本次发布」混称。
  const priorBehavioralRelease = latestRelease
    ? input.releases.slice(1).map((release) => ({ release, changes: input.behaviorChanges.some((change) => change.releaseId === release.id) })).find((candidate) => candidate.changes)?.release ?? null
    : null;
  return {
    state: state as "impacts" | "changes" | "quiet" | "none",
    items,
    changeStats,
    releaseId: latestRelease?.id ?? null,
    priorBehavioralRelease: priorBehavioralRelease
      ? {
          id: priorBehavioralRelease.id,
          title: priorBehavioralRelease.title,
          dateLabel: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(priorBehavioralRelease.committedAt)),
        }
      : null,
  };
}

/** 时间线条目（发布时间线的单条投影），quiet-run 分组展开后保持同构数据。 */
export interface TimelineEntry {
  id: number;
  committedAt: Date;
  title: string;
  sha: string;
  url: string;
  firstLine: string;
  noteStatus: string | null;
  headline: string | null;
  dateLabel: string;
}

/**
 * 发布时间线分组（设计 §8）：仅折叠连续的零行为变化发布，审计语义保留——
 * 展开后数据与单条发布同构；单个零变化发布不分组，非连续不合并不重排。
 * 零行为变化以该发布没有 spec_changes（wording_only=0）条目为准。
 */
export type TimelineGroup = { kind: "single"; release: TimelineEntry } | { kind: "quiet-run"; count: number; releases: TimelineEntry[] };

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
  const changedReleaseIds = new Set(input.behaviorChanges.map((change) => change.releaseId));
  const entries: TimelineEntry[] = input.releases.map((release) => {
    const note = input.releaseNotes?.find((candidate) => candidate.releaseId === release.id);
    const flat = release.summary.replace(/\s*\n\s*/g, " ").trim();
    const sentenceEnd = flat.search(/[。；！？]/);
    const firstLine = sentenceEnd > 0 ? flat.slice(0, sentenceEnd + 1) : flat;
    return {
      id: release.id,
      committedAt: release.committedAt,
      title: release.title,
      sha: release.sha,
      url: release.url,
      firstLine: firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine,
      noteStatus: note?.status ?? null,
      headline: note?.headline ?? null,
      dateLabel: new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(release.committedAt)),
    };
  });
  const timelineGroups: TimelineGroup[] = [];
  for (const entry of entries) {
    const quiet = !changedReleaseIds.has(entry.id);
    const last = timelineGroups[timelineGroups.length - 1];
    if (quiet && last?.kind === "quiet-run") {
      last.releases.push(entry);
      last.count += 1;
    } else if (quiet) {
      timelineGroups.push({ kind: "quiet-run", count: 1, releases: [entry] });
    } else {
      timelineGroups.push({ kind: "single", release: entry });
    }
  }
  // 单条零变化发布直接展示，连续多条才折叠成组。
  for (let index = timelineGroups.length - 1; index >= 0; index -= 1) {
    const group = timelineGroups[index];
    if (group.kind === "quiet-run" && group.count === 1) timelineGroups[index] = { kind: "single", release: group.releases[0] };
  }
  const coverageLine = input.coverage ? `覆盖率 ${Math.round(input.coverage.coverageRatio * 1000) / 10}%（${input.coverage.implFilesAssembled}/${input.coverage.implFilesTotal} 个实现文件）` : null;
  const userImpact = buildUserImpact(input, latestRelease, latestChanges, changeStats);

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
    userImpact,
    latestRelease,
    latestReleaseNote: input.latestReleaseNote ?? null,
    noteByRelease: Object.fromEntries((input.releaseNotes ?? []).map((note) => [String(note.releaseId), { status: note.status, headline: note.headline }])),
    timelineGroups,
    coverageLine,
    trust: {
      featureCount: input.features.length,
      scenarioCount: input.scenarios.length,
      manualFeatureCount: input.features.filter((feature) => feature.source === "manual").length,
      manualScenarioCount: input.scenarios.filter((scenario) => scenario.source === "manual").length,
      evidencePathCount: evidencePaths.size,
      specVersionId,
      coverageRatio: input.coverage ? `${Math.round(input.coverage.coverageRatio * 1000) / 10}%` : null as string | null,
    },
  };
}

export type ProductOverviewData = ReturnType<typeof buildProductOverview>;

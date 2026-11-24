import { formatDateIn } from "./format";
import { buildProductFocus } from "./product-focus";
import { pick, type UiLocale } from "./ui-locale";
import { OVERVIEW_DATA } from "./ui-strings/product";
import { evidenceItems, isTestOnlyEvidence } from "./evidence";
import { buildBusinessDomainCards } from "./business-domains";
import { buildProductPresentationView, type ProductPresentationRow, type ProductPresentationView } from "./product-presentation";
import type { RegressionTaskView } from "./regression-task-view";
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
  /** 回归任务（任务入口判断最新发布是否有回归建议）。 */
  regressionTasks?: RegressionTaskView[];
  latestRun?: { status: string; errorMessage?: string };
  latestReleaseNote?: { status: string; releaseId: number; publishedAt: Date | string | null; blocks: number } | null;
  /** 发布稿映射（总览时间线的状态徽章用）。 */
  releaseNotes?: Array<{ releaseId: number; status: string; headline: string | null }>;
  /** 覆盖率回执仅用于内部分析诊断，不在总览展示。 */
  coverage?: { coverageRatio: number; implFilesAssembled: number; implFilesTotal: number; partitionsCapped: boolean } | null;
  /** 产品理解层（migration 083）：能力归纳与典型使用场景的落库行；没有或读取失败时为空。 */
  presentation?: ProductPresentationRow | null;
}

/** 总览能力卡：三种来源共用一个形状，渲染时按 origin 分形态。 */
export interface OverviewCapabilityCard {
  /** 业务域卡 / 平铺卡 = 功能行 id；AI 归纳卡 = 序号（只作列表 key）。 */
  id: number;
  /** 原始名称（问答检索身份）；AI 归纳卡即分组名。 */
  canonicalName: string;
  name: string;
  summary: string;
  source: string;
  scenarioCount: number;
  /** 业务域卡 → 父功能规格页；平铺卡 → 功能规格页；AI 归纳卡 → 使用场景视图里该能力的分组。 */
  href: string;
  /** domains = 人工确认的业务域；flat = 平铺功能；ai = 理解层的 AI 归纳分组（未经人工确认）。 */
  origin: "domains" | "flat" | "ai";
  featureCount?: number;
  /** AI 归纳卡的成员功能（已解析到当前活跃行）。 */
  members?: Array<{ id: number; name: string; displayName: string; href: string }>;
}

/** 总览只放「一句话讲完」的典型场景，完整步骤在使用场景视图。 */
const JOURNEY_HIGHLIGHTS = 3;

export interface JourneyHighlight {
  id: string;
  name: string;
  startingPoint: string;
  finalOutcome: string;
  stepCount: number;
  featureCount: number;
  href: string;
}

function analysisLabel(status: string | undefined, locale: UiLocale = "zh-CN") {
  if (!status) return pick(locale, OVERVIEW_DATA.analysisNone);
  const label = {
    succeeded: OVERVIEW_DATA.analysisSucceeded,
    failed: OVERVIEW_DATA.analysisFailed,
    running: OVERVIEW_DATA.analysisRunning,
    queued: OVERVIEW_DATA.analysisQueued,
  }[status];
  return label === undefined ? `${pick(locale, OVERVIEW_DATA.analysisStatus)}${status}` : pick(locale, label);
}

function specLabel(specVersionId: number | null, sha?: string, committedAt?: Date, locale: UiLocale = "zh-CN") {
  if (specVersionId === null) return pick(locale, OVERVIEW_DATA.specNone);
  const shaPart = sha ? ` · ${sha.slice(0, 7)}` : "";
  const timePart = committedAt ? `${pick(locale, OVERVIEW_DATA.specUpdated)}${dayLabel(committedAt)}` : "";
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

/**
 * BM-6/B2 口径：场景级变化的对侧证据全部为测试/文档（无实现代码）时，只在
 * 「全部前后差异」（发布变化视图）展示，不进总览影响投影与发布稿功能勾选计数；
 * 发布时间线的 changeStats 保持全量口径（两处数字差由「测试佐证」徽标解释）。
 */
function changeIsTestOnly(change: BehaviorChangeRow): boolean {
  if (change.entityType !== "scenario") return false;
  const side = change.kind === "removed" ? change.before : change.after;
  return isTestOnlyEvidence(side);
}

/** 总览 02 面板的按功能聚合视图：大发布逐条列出会淹没在场景编号里，先给功能级摘要。 */
function groupChangesByFeature(changes: Array<{ kind: string; featureName: string }>, locale: UiLocale = "zh-CN") {
  const groups = new Map<string, { featureName: string; added: number; removed: number; changed: number }>();
  for (const change of changes) {
    const featureName = change.featureName || pick(locale, OVERVIEW_DATA.unknownFeature);
    const group = groups.get(featureName) ?? { featureName, added: 0, removed: 0, changed: 0 };
    if (change.kind === "added") group.added += 1;
    else if (change.kind === "removed") group.removed += 1;
    else group.changed += 1;
    groups.set(featureName, group);
  }
  return [...groups.values()].sort((a, b) => (b.added + b.removed + b.changed) - (a.added + a.removed + a.changed) || a.featureName.localeCompare(b.featureName));
}

export function changeGroupLabel(group: { added: number; removed: number; changed: number }, locale: UiLocale = "zh-CN") {
  const parts = [];
  if (group.added > 0) parts.push(pick(locale, OVERVIEW_DATA.groupAdded).replace("{count}", String(group.added)));
  if (group.removed > 0) parts.push(pick(locale, OVERVIEW_DATA.groupRemoved).replace("{count}", String(group.removed)));
  if (group.changed > 0) parts.push(pick(locale, OVERVIEW_DATA.groupChanged).replace("{count}", String(group.changed)));
  return parts.join(" · ") || pick(locale, OVERVIEW_DATA.groupNone);
}

/**
 * 最新发布的用户影响投影（设计 §6）：只复用已落库的 changes.user_impact 文本，
 * 不在展示层生成事实。同一功能的多条影响合并为一组（不产生同名重复卡片）；
 * 每组保留前 3 条文本并给出溢出计数（概览是轻量投影，全量文本在发布卡），
 * 最多展示 3 个功能组。最新发布没有非空用户影响时按确定性数据回退，
 * 不用更早发布冒充最新发布。
 */
const IMPACT_TEXTS_PER_FEATURE = 3;

function buildUserImpact(
  input: ProductOverviewInput,
  latestRelease: ReleaseRow | undefined,
  latestChanges: BehaviorChangeRow[],
  changeStats: { added: number; removed: number; changed: number },
  locale: "zh-CN" | "en" = "zh-CN",
) {
  const groups = new Map<string, { releaseId: number; featureName: string; userImpacts: string[]; moreCount: number }>();
  if (latestRelease) {
    // BM-6/B2：实现证据的变化文本优先占位，测试/文档佐证的文本只在有余位时补充——
    // 影响卡不再让「测试这样断言」冒充排在最前的用户影响（全量仍在发布变化视图）。
    const pending = (input.changes ?? []).filter((change) => change.releaseId === latestRelease.id && change.userImpact.trim().length > 0);
    const ordered = [...pending.filter((change) => !isTestOnlyEvidence(change.evidence)), ...pending.filter((change) => isTestOnlyEvidence(change.evidence))];
    for (const change of ordered) {
      const group = groups.get(change.featureName) ?? { releaseId: latestRelease.id, featureName: change.featureName, userImpacts: [], moreCount: 0 };
      if (group.userImpacts.length < IMPACT_TEXTS_PER_FEATURE) group.userImpacts.push(change.userImpact);
      else group.moreCount += 1;
      groups.set(change.featureName, group);
    }
  }
  const items = [...groups.values()].slice(0, 3);
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
          dateLabel: formatDateIn(locale, priorBehavioralRelease.committedAt, { month: "long", day: "numeric" }),
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

/**
 * 任务入口投影（设计 §7）：现有视图的导航，不是新的角色数据系统。
 * 数据缺失时给出真实禁用原因，不产生指向不存在数据的链接；
 * 任务文案优先于角色标签。
 */
function buildTaskEntries(input: ProductOverviewInput, latestRelease: ReleaseRow | undefined, locale: UiLocale = "zh-CN") {
  const hasFeatures = input.features.length > 0;
  const latestRegressionTasks = latestRelease ? (input.regressionTasks ?? []).some((task) => task.releaseId === latestRelease.id) : false;
  const changesHref = latestRelease ? `${input.productBase}?view=changes#release-${latestRelease.id}` : null;
  return [
    { key: "capability", question: pick(locale, OVERVIEW_DATA.taskCapabilityQuestion), href: hasFeatures ? `${input.productBase}?view=spec` : null, disabledReason: hasFeatures ? null : pick(locale, OVERVIEW_DATA.taskDisabledNoSpec) },
    { key: "release-impact", question: pick(locale, OVERVIEW_DATA.taskReleaseImpactQuestion), href: changesHref, disabledReason: latestRelease ? null : pick(locale, OVERVIEW_DATA.taskDisabledNoRelease) },
    { key: "regression", question: pick(locale, OVERVIEW_DATA.taskRegressionQuestion), href: latestRegressionTasks ? changesHref : null, disabledReason: latestRelease ? (latestRegressionTasks ? null : pick(locale, OVERVIEW_DATA.taskDisabledNoRegression)) : pick(locale, OVERVIEW_DATA.taskDisabledNoRelease) },
    { key: "traceable-changes", question: pick(locale, OVERVIEW_DATA.taskTraceableQuestion), href: input.releases.length > 0 ? `${input.productBase}?view=changes` : null, disabledReason: input.releases.length > 0 ? null : pick(locale, OVERVIEW_DATA.taskDisabledNoRelease) },
  ];
}

export function buildProductOverview(input: ProductOverviewInput, locale: "zh-CN" | "en" = "zh-CN") {
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
  // BM-6/B2：发布稿勾选与影响投影用实现证据口径；changeStats/发布变化视图保持全量。
  const userVisibleChanges = latestChanges.filter((change) => !changeIsTestOnly(change));
  const changeGroups = groupChangesByFeature(userVisibleChanges, locale);
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
      dateLabel: formatDateIn(locale, release.committedAt, { month: "long", day: "numeric" }),
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
  const userImpact = buildUserImpact(input, latestRelease, latestChanges, changeStats, locale);
  // 业务分组（Task 2）：有人工确认的「父节点 + 子级」树时，首页能力卡聚合为业务域卡片；
  // 没有分组的产品依次回退 AI 归纳分组、平铺卡片。组织用父节点不进入问答建议——检索身份始终是原始功能。
  const businessDomains: OverviewCapabilityCard[] = buildBusinessDomainCards(input.features, input.scenarios, input.productBase).map((card) => ({ ...card, origin: "domains" }));
  const capabilityCard = (feature: FeatureRow): OverviewCapabilityCard => ({
    id: feature.id,
    canonicalName: feature.name,
    name: feature.displayName || feature.name,
    summary: feature.summary,
    source: feature.source,
    scenarioCount: input.scenarios.filter((scenario) => scenario.featureId === feature.id).length,
    href: `${input.productBase}${featureHref(feature.id)}`,
    origin: "flat",
  });
  const parentIdSet = new Set(input.features.filter((feature) => feature.parentId !== null && input.features.some((parent) => parent.id === feature.parentId)).map((feature) => feature.parentId));
  // 理解层视图：旅程引用链解析到当前活跃场景（失效步骤保留并标注），总览与使用场景视图共用一次投影。
  const presentation: ProductPresentationView | null = input.presentation
    ? buildProductPresentationView({ row: input.presentation, features: input.features, scenarios: input.scenarios, productBase: input.productBase })
    : null;
  // 能力卡取值链第二档（2026-11-23 用户裁决）：没有人工业务域时直接展示理解层的 AI 归纳分组并标注来源
  // （生成器已校验每个功能恰好归属一次；成员解析不到当前行的名字在投影里剔除，空壳分组不出现）。
  const aiCapabilities: OverviewCapabilityCard[] = businessDomains.length === 0 && presentation
    ? presentation.capabilities.map((capability, order) => ({
      id: order + 1,
      canonicalName: capability.name,
      name: capability.name,
      summary: capability.summary,
      source: "generated",
      scenarioCount: capability.scenarioCount,
      href: `${input.productBase}?view=journeys#${capability.id}`,
      origin: "ai",
      featureCount: capability.features.length,
      members: capability.features,
    }))
    : [];
  // 精简卡与计数只取页面上实际展示的旅程（完好且功能组合互不重复）
  const journeyHighlights: JourneyHighlight[] = (presentation?.visibleJourneys ?? [])
    .map((journey, order) => ({ journey, order, tier: journey.tier === "headline" ? 0 : 1 }))
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, JOURNEY_HIGHLIGHTS)
    .map(({ journey }) => ({
      id: journey.id,
      name: journey.name,
      startingPoint: journey.startingPoint ?? "",
      finalOutcome: journey.finalOutcome ?? "",
      stepCount: journey.resolvedSteps,
      featureCount: journey.featureCount,
      href: journey.href,
    }));

  return {
    focus: buildProductFocus(input),
    slug: input.product.slug,
    productBase: input.productBase,
    presentation,
    journeyHighlights,
    journeyTotal: presentation?.visibleJourneys.length ?? 0,
    description: input.product.description,
    headline: input.product.description.trim() || pick(locale, OVERVIEW_DATA.headlineFallback),
    headlineSource: input.product.descriptionSource === undefined ? "manual" : input.product.descriptionSource,
    headlineEvidence: evidenceItems(input.product.descriptionEvidence),
    freshness: specLabel(specVersionId, revision, latestRelease?.committedAt, locale),
    analysisLabel: analysisLabel(input.latestRun ? input.latestRun.status : undefined, locale),
    capabilities: businessDomains.length > 0 ? businessDomains : aiCapabilities.length > 0 ? aiCapabilities : input.features.map(capabilityCard).sort(compareCapabilities).slice(0, 6),
    questionCapabilities: input.features.filter((feature) => !parentIdSet.has(feature.id)).map(capabilityCard).filter((card) => card.scenarioCount > 0).sort(compareCapabilities),
    changes: [...latestChanges]
      .sort((a, b) => (changeKindPriority[a.kind] ?? 9) - (changeKindPriority[b.kind] ?? 9) || a.id - b.id)
      .slice(0, 3),
    changeStats,
    changeGroups,
    userImpact,
    taskEntries: buildTaskEntries(input, latestRelease, locale),
    latestRelease,
    latestReleaseNote: input.latestReleaseNote ?? null,
    noteByRelease: Object.fromEntries((input.releaseNotes ?? []).map((note) => [String(note.releaseId), { status: note.status, headline: note.headline }])),
    timelineGroups,
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

import { createHash } from "node:crypto";
import type { Execute } from "./db";
import { evidenceItems } from "./evidence";
import { parseJsonValue } from "./json";
import { featureHref } from "./spec-editor-ui";
import type { FeatureRow, ScenarioRow } from "./types";

/**
 * 产品理解层（Radar 式 presentation）读侧：类型、结构指纹、加载与视图投影（纯函数）。
 * 能力归纳与典型使用场景都是对已有规格的重组，不新增事实——旅程只是一条引用链
 * （featureName + 场景编号），情境/操作/结果/证据全部读侧从 features/scenarios 现取。
 * 生成与调度见 lib/product-presentation-service.ts。
 */

export type PresentationLanguage = "zh-CN" | "en";
export type PresentationStatus = "generated" | "partial" | "failed";
export type PresentationSource = "generated" | "ai_snapshot_import";

export interface PresentationScenarioRef {
  featureName: string;
  reference: string;
}

export interface PresentationCapability {
  id: string;
  name: string;
  summary: string;
  /** 归属功能的原始名称（检索身份）；展示时用 displayName。 */
  featureNames: string[];
}

/** headline = 跨能力的全局典型场景；capability = 按能力域深挖出的场景。 */
export type PresentationJourneyTier = "headline" | "capability";

export interface PresentationJourney {
  id: string;
  name: string;
  tier: PresentationJourneyTier;
  /**
   * 这条旅程实际触及的能力分组（可多个，按首次出现排序）——由步骤所属功能对照能力分组得出，
   * 而不是「挖出它的那个窗口」。第一个标签是它出发的能力：完整卡片只出现在那里；
   * 其余途经的能力分组用链接引用它。空数组 = 只触及未归组的功能。生成后会按当前分组重新计算，
   * 所以归组变化时旧旅程的标签自动跟上。
   */
  capabilityNames: string[];
  steps: PresentationScenarioRef[];
}

export interface PresentationCoverage {
  featuresTotal: number;
  featuresInJourneys: number;
  scenariosInJourneys: number;
}

export interface ProductPresentationPayload {
  status: PresentationStatus;
  language: PresentationLanguage;
  tagline?: string;
  capabilities: PresentationCapability[];
  journeys: PresentationJourney[];
  coverage: PresentationCoverage;
}

export interface ProductPresentationRow extends ProductPresentationPayload {
  productId: number;
  specVersionId: number | null;
  source: PresentationSource;
  fingerprint: string;
  /** 规格已变但尚未重算：当前内容对应的是变更前的规格。 */
  pending: boolean;
  /** 有一次生成正在进行（生成租约有效）。 */
  refreshing: boolean;
  modelName: string | null;
  passes: number;
  lastError: string | null;
  generatedAt: Date | null;
}

interface PresentationDbRow {
  product_id: number;
  spec_version_id: number | null;
  language: string;
  status: string;
  source: string;
  tagline: string | null;
  capabilities_json: unknown;
  journeys_json: unknown;
  coverage_json: unknown;
  fingerprint: string;
  pending: number;
  /** 租约仍有效 = 有一次生成正在进行（时间比较留在 SQL 侧，避开 DATETIME 列的时区偏移）。 */
  refreshing: number | null;
  model_name: string | null;
  passes: number;
  last_error: string | null;
  generated_at: Date | null;
}

function payloadRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload) && Array.isArray(payload[0])) return payload[0] as T[];
  return (payload ?? []) as T[];
}

export function presentationLanguage(value: unknown): PresentationLanguage {
  return value === "en" ? "en" : "zh-CN";
}

function refOf(value: unknown): PresentationScenarioRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { featureName?: unknown; reference?: unknown };
  if (typeof record.featureName !== "string" || typeof record.reference !== "string") return null;
  if (record.featureName.trim() === "" || record.reference.trim() === "") return null;
  return { featureName: record.featureName, reference: record.reference };
}

/** 落库 JSON 的防御式解析：形状不对的条目逐个丢弃，不让一条坏数据拖垮整个视图。 */
export function parsePresentationPayload(value: unknown): Pick<ProductPresentationPayload, "status" | "capabilities" | "journeys" | "coverage"> {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const capabilities: PresentationCapability[] = [];
  for (const [index, item] of (Array.isArray(record.capabilities) ? record.capabilities : []).entries()) {
    if (typeof item !== "object" || item === null) continue;
    const capability = item as { name?: unknown; summary?: unknown; featureNames?: unknown };
    if (typeof capability.name !== "string" || typeof capability.summary !== "string" || !Array.isArray(capability.featureNames)) continue;
    const featureNames = capability.featureNames.filter((name): name is string => typeof name === "string" && name.trim() !== "");
    if (featureNames.length === 0) continue;
    capabilities.push({ id: `capability-${index + 1}`, name: capability.name, summary: capability.summary, featureNames });
  }
  const journeys: PresentationJourney[] = [];
  for (const [index, item] of (Array.isArray(record.journeys) ? record.journeys : []).entries()) {
    if (typeof item !== "object" || item === null) continue;
    const journey = item as { name?: unknown; steps?: unknown; tier?: unknown; capabilityNames?: unknown; capabilityName?: unknown };
    if (typeof journey.name !== "string" || !Array.isArray(journey.steps)) continue;
    const steps = journey.steps.map(refOf).filter((ref): ref is PresentationScenarioRef => ref !== null);
    if (steps.length === 0) continue;
    // capabilityName 是首版落库的单标签写法：读得出来，下次生成合并时会被重新计算成多标签。
    const legacyName = typeof journey.capabilityName === "string" && journey.capabilityName.trim() !== "" ? [journey.capabilityName] : [];
    const names = Array.isArray(journey.capabilityNames) ? journey.capabilityNames.filter((name): name is string => typeof name === "string" && name.trim() !== "") : legacyName;
    journeys.push({
      id: `journey-${index + 1}`,
      name: journey.name,
      tier: journey.tier === "headline" ? "headline" : "capability",
      capabilityNames: [...new Set(names)],
      steps,
    });
  }
  const coverage = typeof record.coverage === "object" && record.coverage !== null ? record.coverage as Record<string, unknown> : {};
  return {
    status: record.status === "generated" || record.status === "partial" ? record.status : "failed",
    capabilities,
    journeys,
    coverage: {
      featuresTotal: Number(coverage.featuresTotal ?? 0) || 0,
      featuresInJourneys: Number(coverage.featuresInJourneys ?? 0) || 0,
      scenariosInJourneys: Number(coverage.scenariosInJourneys ?? 0) || 0,
    },
  };
}

export async function loadProductPresentation(execute: Execute, productId: number): Promise<ProductPresentationRow | null> {
  const row = payloadRows<PresentationDbRow>(await execute(
    `SELECT product_id, spec_version_id, language, status, source, tagline, capabilities_json, journeys_json, coverage_json,
            fingerprint, pending, (lease_until IS NOT NULL AND lease_until > CURRENT_TIMESTAMP(3)) AS refreshing,
            model_name, passes, last_error, generated_at
     FROM product_presentations WHERE product_id = ? LIMIT 1`,
    [productId],
  ))[0];
  if (!row) return null;
  const payload = parsePresentationPayload({
    status: row.status,
    capabilities: parseJsonValue(row.capabilities_json),
    journeys: parseJsonValue(row.journeys_json),
    coverage: parseJsonValue(row.coverage_json),
  });
  return {
    productId: Number(row.product_id),
    specVersionId: row.spec_version_id === null ? null : Number(row.spec_version_id),
    language: presentationLanguage(row.language),
    source: row.source === "ai_snapshot_import" ? "ai_snapshot_import" : "generated",
    tagline: row.tagline ?? undefined,
    ...payload,
    fingerprint: row.fingerprint ?? "",
    pending: Number(row.pending) === 1,
    refreshing: Number(row.refreshing ?? 0) === 1,
    modelName: row.model_name,
    passes: Number(row.passes) || 0,
    lastError: row.last_error,
    generatedAt: row.generated_at ?? null,
  };
}

/**
 * 结构指纹：功能名 + 父子分组 + 场景编号与类别 + 语言。摘要措辞变化不触发重算——
 * 旅程引用的是场景身份，文案由读侧现取。id 只用于把场景归到功能，不进指纹（跨环境稳定）。
 */
export function presentationFingerprint(input: {
  features: Array<{ id: number; name: string; parentId: number | null }>;
  scenarios: Array<{ featureId: number; reference: string; category: string }>;
  language: PresentationLanguage;
}): string {
  const nameById = new Map(input.features.map((feature) => [feature.id, feature.name]));
  const scenariosByFeature = new Map<number, string[]>();
  for (const scenario of input.scenarios) {
    const list = scenariosByFeature.get(scenario.featureId) ?? [];
    list.push(`${scenario.reference}:${scenario.category}`);
    scenariosByFeature.set(scenario.featureId, list);
  }
  const lines = [...input.features]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((feature) => `${feature.name}\u0000${feature.parentId === null ? "" : nameById.get(feature.parentId) ?? ""}\u0000${(scenariosByFeature.get(feature.id) ?? []).sort().join(",")}`);
  return createHash("sha256").update([`lang=${input.language}`, ...lines].join("\n"), "utf8").digest("hex");
}

function normalizedKey(featureName: string, reference: string) {
  return `${featureName.trim().toLowerCase().replace(/\s+/g, " ")}\u0000${reference.trim()}`;
}

/** 旅程判重的相似度阈值：两条旅程的功能集合 Jaccard 达到它即视为同一个场景。 */
export const JOURNEY_FEATURE_SIMILARITY = 0.6;

function contains<T>(outer: Set<T>, inner: Set<T>): boolean {
  return [...inner].every((item) => outer.has(item));
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 两条旅程是否算「同一个场景」——以经过的功能组合为准，这是写侧接纳器与读侧投影共用的唯一口径。
 * 读者凭「走过哪些功能」分辨场景；场景编号只是同一个功能的不同细节。
 * 生产实测（2026-11-24）：按「功能 + 场景编号」判重时，模型会给同一对功能换着编号写三四条
 * （「配置加载 → 安全中间件」出现 4 次），11 个功能的产品挖出 20 条旅程只有 13 种走法。
 * 功能组合相同或高度相似算重复；其中一组被另一组完全包含的也算——它只是更长场景的一段，对读者没有增量。
 */
export function sameJourneyFeatures(a: Set<string>, b: Set<string>): boolean {
  return jaccard(a, b) >= JOURNEY_FEATURE_SIMILARITY || contains(a, b) || contains(b, a);
}

/**
 * 按传入顺序保留先到的旅程，其后与已保留旅程经过同一组功能的归入 duplicates。
 * 写侧接纳器在此之上另有「更完整者原位替换」，这里只做读侧展示前的折叠。
 */
export function splitDuplicateJourneys<T extends { steps: unknown[] }>(journeys: T[], featureKeyOf: (step: T["steps"][number]) => string): { kept: T[]; duplicates: T[] } {
  const kept: T[] = [];
  const duplicates: T[] = [];
  const seen: Set<string>[] = [];
  for (const journey of journeys) {
    const features = new Set(journey.steps.map((step) => featureKeyOf(step)));
    // 空集合被任何集合「包含」，单独处理：没有功能可比的旅程不参与判重
    const duplicate = features.size > 0 && seen.some((set) => sameJourneyFeatures(set, features));
    if (duplicate) duplicates.push(journey);
    else {
      kept.push(journey);
      seen.push(features);
    }
  }
  return { kept, duplicates };
}

/**
 * 是否把同一个功能的多条场景首尾相接——这是在罗列变体，不是用户旅程的后续步骤
 * （生产实测 2026-11-24：首轮生成的 codelphi 60 条旅程里 22 条如此，如「知识健康统计 HP-1 → HP-2 → HP-3 →
 * 知识健康面板」，三步内容几乎一样）。写侧校验与读侧折叠共用；单功能产品的旅程只能如此，由调用方豁免。
 */
export function chainsScenariosOfOneFeature(featureKeys: unknown[]): boolean {
  return featureKeys.some((key, position) => position > 0 && key === featureKeys[position - 1]);
}

export interface PresentationStepView extends PresentationScenarioRef {
  featureId: number | null;
  featureDisplayName: string;
  context: string;
  action: string;
  outcome: string;
  evidence: unknown;
  /** 指向规格工作台对应场景；引用解析失败时为 null。 */
  href: string | null;
}

export interface PresentationJourneyView extends PresentationJourney {
  steps: PresentationStepView[];
  resolvedSteps: number;
  /** 全部步骤都能解析到当前规格。 */
  intact: boolean;
  startingPoint: string | null;
  finalOutcome: string | null;
  featureCount: number;
  href: string;
}

export interface PresentationJourneyGroup {
  /** headline = 跨能力的全局典型场景；ungrouped = 不归属任何能力分组的旅程。 */
  kind: "headline" | "capability" | "ungrouped";
  /** 页内锚点 id；能力分组与总览 AI 能力卡的跳转目标一致。 */
  key: string;
  name: string | null;
  /** 在本组完整展示的旅程。全局典型场景只在全局组；能力场景归入它出发的能力（第一个标签）。 */
  journeys: PresentationJourneyView[];
  /** 途经本能力、但在别处完整展示的旅程：只给链接，不重复画卡。 */
  related: PresentationJourneyView[];
}

export interface ProductPresentationView {
  row: ProductPresentationRow;
  journeys: PresentationJourneyView[];
  intactJourneys: PresentationJourneyView[];
  staleJourneys: PresentationJourneyView[];
  /** 引用已全部失效、无法展示的旅程数（如实披露，不静默消失）。 */
  brokenJourneys: number;
  /** 页面上实际展示的旅程 = 完好、不罗列同一功能的多条场景、且功能组合互不重复。计数、精简卡、覆盖率都以它为准。 */
  visibleJourneys: PresentationJourneyView[];
  /** 引用完好但未展示的旅程：与已展示旅程经过同一组功能，或把同一功能的多条场景首尾相接（较早的生成规则留下的）。 */
  foldedJourneys: PresentationJourneyView[];
  groups: PresentationJourneyGroup[];
  /** 成员解析到当前活跃行的能力分组（总览 AI 能力卡与页内分组共用，锚点一致）。 */
  capabilities: PresentationCapabilityView[];
  coverage: PresentationCoverage;
  featuresTotal: number;
}

/**
 * 旅程视图投影：把引用链解析到当前活跃的功能与场景。步骤解析失败的旅程保留并标 stale
 * （说明「引用的场景已变更」），不静默丢弃；引用全部失效的只计数。
 * 展示前再过一遍当前的两条规则——落库内容可能出自较早的规则，或来自快照导入：罗列同一功能多条场景的、
 * 与已展示旅程经过同一组功能的都不展示，进 foldedJourneys 如实披露。每条旅程只完整展示一次：
 * 全局典型场景只在全局组，能力场景归入它出发的能力，途经的其他能力分组用链接引用它（每张能力卡点进来仍有落点）。
 */
export function buildProductPresentationView(input: {
  row: ProductPresentationRow;
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  productBase: string;
}): ProductPresentationView {
  const featureById = new Map(input.features.map((feature) => [feature.id, feature]));
  const domainParentIds = new Set(input.features.filter((feature) => input.features.some((child) => child.parentId === feature.id)).map((feature) => feature.id));
  const exact = new Map<string, ScenarioRow & { featureName: string; featureId: number }>();
  const normalized = new Map<string, ScenarioRow & { featureName: string; featureId: number }>();
  for (const scenario of input.scenarios) {
    const feature = featureById.get(scenario.featureId);
    if (!feature) continue;
    const entry = { ...scenario, featureName: feature.name, featureId: feature.id };
    exact.set(`${feature.name}\u0000${scenario.reference}`, entry);
    normalized.set(normalizedKey(feature.name, scenario.reference), entry);
  }
  const journeys: PresentationJourneyView[] = input.row.journeys.map((journey) => {
    const steps: PresentationStepView[] = journey.steps.map((ref) => {
      const scenario = exact.get(`${ref.featureName}\u0000${ref.reference}`) ?? normalized.get(normalizedKey(ref.featureName, ref.reference));
      const feature = scenario ? featureById.get(scenario.featureId) : undefined;
      return {
        featureName: ref.featureName,
        reference: ref.reference,
        featureId: scenario?.featureId ?? null,
        featureDisplayName: feature?.displayName || feature?.name || ref.featureName,
        context: scenario?.context ?? "",
        action: scenario?.action ?? "",
        outcome: scenario?.outcome ?? "",
        evidence: scenario?.evidence ?? null,
        href: scenario ? `${input.productBase}${featureHref(scenario.featureId)}#scenario-${scenario.reference}` : null,
      };
    });
    const resolved = steps.filter((step) => step.href !== null);
    return {
      ...journey,
      steps,
      resolvedSteps: resolved.length,
      intact: resolved.length === steps.length && steps.length > 0,
      startingPoint: resolved[0]?.context ?? null,
      finalOutcome: resolved.at(-1)?.outcome ?? null,
      featureCount: new Set(resolved.map((step) => step.featureId)).size,
      href: `${input.productBase}?view=journeys#${journey.id}`,
    };
  });
  const intactJourneys = journeys.filter((journey) => journey.intact);
  const staleJourneys = journeys.filter((journey) => !journey.intact && journey.resolvedSteps > 0);
  // 单功能产品的旅程只能在同一个功能里串场景，不算罗列（与写侧校验的豁免一致，按叶子功能数判断）
  const multiFeature = input.features.filter((feature) => !domainParentIds.has(feature.id)).length > 1;
  const chains = new Set(intactJourneys.filter((journey) => multiFeature && chainsScenariosOfOneFeature(journey.steps.map((step) => step.featureId))));
  // 判重按解析到的功能（而非功能名）：改名后仍能认出是同一个功能组合
  const { kept: visibleJourneys, duplicates } = splitDuplicateJourneys(
    intactJourneys.filter((journey) => !chains.has(journey)),
    (step) => (step.featureId === null ? `name:${step.featureName.trim().toLowerCase()}` : `id:${step.featureId}`),
  );
  // 未展示的按落库顺序排列（引用完好的那部分才参与）
  const foldedJourneys = intactJourneys.filter((journey) => chains.has(journey) || duplicates.includes(journey));
  const featuresInJourneys = new Set(visibleJourneys.flatMap((journey) => journey.steps.map((step) => step.featureId))).size;
  // 能力分组：成员解析到当前活跃行的才出卡（空壳分组不出现）；页内锚点与总览 AI 能力卡一致。
  const capabilityViews = buildPresentationCapabilities({ capabilities: input.row.capabilities, features: input.features, scenarios: input.scenarios, productBase: input.productBase });
  const groupNames = capabilityViews.map((capability) => capability.name);
  for (const journey of visibleJourneys) {
    for (const name of journey.capabilityNames) if (!groupNames.includes(name)) groupNames.push(name);
  }
  const headlineJourneys = visibleJourneys.filter((journey) => journey.tier === "headline");
  const capabilityJourneys = visibleJourneys.filter((journey) => journey.tier !== "headline");
  // 分组里只放完好且未重复的旅程（失效的在「待更新」组里单独披露）。
  const passes = (journey: PresentationJourneyView, name: string) => journey.capabilityNames.includes(name);
  const groups: PresentationJourneyGroup[] = [
    { kind: "headline", key: "headline", name: null, journeys: headlineJourneys, related: [] },
    ...groupNames.map((name, order) => {
      const starting = capabilityJourneys.filter((journey) => journey.capabilityNames[0] === name);
      return {
        kind: "capability" as const,
        key: capabilityViews.find((capability) => capability.name === name)?.id ?? `capability-extra-${order}`,
        name,
        journeys: starting,
        related: visibleJourneys.filter((journey) => passes(journey, name) && !starting.includes(journey)),
      };
    }),
    { kind: "ungrouped", key: "ungrouped", name: null, journeys: capabilityJourneys.filter((journey) => journey.capabilityNames.length === 0), related: [] },
  ];
  return {
    row: input.row,
    journeys,
    intactJourneys,
    staleJourneys,
    brokenJourneys: journeys.filter((journey) => !journey.intact && journey.resolvedSteps === 0).length,
    visibleJourneys,
    foldedJourneys,
    groups: groups.filter((group) => group.journeys.length > 0 || group.related.length > 0),
    capabilities: capabilityViews,
    coverage: {
      featuresTotal: input.features.filter((feature) => !domainParentIds.has(feature.id)).length,
      featuresInJourneys,
      scenariosInJourneys: new Set(visibleJourneys.flatMap((journey) => journey.steps.map((step) => step.href))).size,
    },
    featuresTotal: input.features.length,
  };
}

/** 能力卡片视图：成员功能解析到当前行（解析不到的名字剔除，不让卡片链到不存在的功能）。 */
export interface PresentationCapabilityView extends PresentationCapability {
  features: Array<{ id: number; name: string; displayName: string; href: string }>;
  scenarioCount: number;
}

export function buildPresentationCapabilities(input: {
  capabilities: PresentationCapability[];
  features: FeatureRow[];
  scenarios: ScenarioRow[];
  productBase: string;
}): PresentationCapabilityView[] {
  const byName = new Map(input.features.map((feature) => [feature.name, feature]));
  const normalizedByName = new Map(input.features.map((feature) => [feature.name.trim().toLowerCase().replace(/\s+/g, " "), feature]));
  const scenarioCountByFeature = new Map<number, number>();
  for (const scenario of input.scenarios) scenarioCountByFeature.set(scenario.featureId, (scenarioCountByFeature.get(scenario.featureId) ?? 0) + 1);
  return input.capabilities.map((capability) => {
    const members = capability.featureNames.flatMap((name) => {
      const feature = byName.get(name) ?? normalizedByName.get(name.trim().toLowerCase().replace(/\s+/g, " "));
      return feature ? [feature] : [];
    });
    return {
      ...capability,
      features: members.map((feature) => ({
        id: feature.id,
        name: feature.name,
        displayName: feature.displayName || feature.name,
        href: `${input.productBase}${featureHref(feature.id)}`,
      })),
      scenarioCount: members.reduce((total, feature) => total + (scenarioCountByFeature.get(feature.id) ?? 0), 0),
    };
  }).filter((capability) => capability.features.length > 0);
}

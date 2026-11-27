import { requestStructuredCompletion, type AnalysisResult, type LlmBillingContext } from "./ai";
import { MODEL_CONFIGURED_SQL } from "./analysis-executor";
import { currentOrganizationModel, withOrganizationModel } from "./organization-model";
import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { parseJsonValue } from "./json";
import { presentationMaxJourneys, presentationMaxPasses, presentationRefreshIntervalHours } from "./env";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "./llm-client";
import { createSnapshotPresentation, JOURNEY_OUTPUT_SHAPE, journeyMiningPrompt, parseJourneyCandidates, type JourneyCandidate } from "./snapshot/presentation";
import {
  chainsScenariosOfOneFeature,
  parsePresentationPayload,
  presentationFingerprint,
  presentationLanguage,
  sameJourneyFeatures,
  type PresentationCapability,
  type PresentationCoverage,
  type PresentationJourney,
  type PresentationLanguage,
  type PresentationScenarioRef,
  type PresentationStatus,
} from "./product-presentation";

/**
 * 产品理解层写侧：生成（能力归纳 + 典型使用场景）、落库与节流调度。
 *
 * - 能力归纳：有人工确认的业务域时直接投影（零 AI）；否则复用 Radar 的归组生成器
 *   （每个功能恰好归属一次，校验不过整体放弃，总览回退平铺卡片）。
 * - 使用场景：Radar 只给 ≤5 条全局典型旅程；这里在其后按能力域分窗多趟深挖，逐条校验、去重，
 *   并受调用次数与旅程总数两个成本闸门约束。
 * - 调度：规格指纹未变不调用模型；变了但距上次成功生成不足节流间隔的只标记待更新，
 *   由 sweep 到期后重算。分析钩子 / sweep / 手动触发三路经行级租约互斥。
 *
 * 红线同 Radar：只重组已有规格，不新增事实——旅程每一步都必须指向一条已有的 happy 场景。
 */

export const PRESENTATION_CALL_KIND = "product_presentation";

/** 生成租约：进程崩溃后最迟这么久可被 sweep 重新领取。 */
const LEASE_MINUTES = 30;
/** 生成失败后的重试退避：从未成功过的产品 1 小时后重试，至多这么多次；已有内容的产品每天至多重试一次。 */
const FAILURE_RETRY_MINUTES = 60;
const FAST_FAILURE_RETRIES = 3;
/** 深挖窗口：每趟送入的功能数、每功能候选 happy 场景数、每趟最多旅程数。 */
const WINDOW_FEATURES = 40;
const SCENARIOS_PER_FEATURE = 3;
const JOURNEYS_PER_PASS = 6;
const HEADLINE_MAX_JOURNEYS = 5;
/** 全局典型旅程的候选采样：每个能力桶均匀取这么多功能。 */
const HEADLINE_FEATURES_PER_BUCKET = 8;
/** 全局采样的功能数上限：每个功能只带一条场景，所以多覆盖功能比多带场景更有用。 */
const HEADLINE_UNGROUPED_FEATURES = 40;
const HEADLINE_MAX_FEATURES = 80;
const PASS_CONCURRENCY = 3;
/** 深挖的轮数上限：第一轮全覆盖，之后只针对仍未覆盖的功能再挖，至多三轮。 */
const MINING_ROUNDS = 3;
/**
 * 分桶挖掘的窗口规划（生产实测 2026-11-24：620 功能的产品有 31 个人工业务域，其中 13 个只有 1 个功能；
 * 每个小域各占一整趟调用时，16 趟预算被它们吃掉，占产品 88% 的 545 个未分组功能几乎没被挖到）。
 * - 预算按「送进模型的功能量」计：maxPasses × WINDOW_FEATURES 个功能位——一趟只送 3 个功能不该和
 *   一趟送 40 个功能等价；另设调用次数硬上限，约束每趟的固定开销。
 * - 桶大到单独成窗时按窗口切；小桶在「不合并就放不进调用上限」时合并成打包窗口一起挖。
 */
const SMALL_BUCKET_FEATURES = 8;
/** 一个打包窗口最多容纳的分组数与要求的旅程数上限。 */
const PACKED_WINDOW_BUCKETS = 10;
const PACKED_MAX_JOURNEYS = 12;

export interface PresentationLedgerFeature {
  id: number;
  name: string;
  displayName: string;
  summary: string;
  parentId: number | null;
}

export interface PresentationLedgerScenario {
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  step: number | null;
  evidence: unknown;
}

export interface PresentationLedger {
  productId: number;
  name: string;
  description: string;
  /** 产品由谁来分析（products.analysis_executor）。client 的产品，理解层随客户端的提案一起交上来。缺省按托管。 */
  analysisExecutor?: "server" | "client";
  /** 产品所属的工作区，和它有没有自己的模型配置：服务端只为配了自己的模型的工作区调模型。手搭的账本可以不带。 */
  organizationId?: number;
  modelConfigured?: boolean;
  language: PresentationLanguage;
  specVersionId: number | null;
  features: PresentationLedgerFeature[];
  scenarios: PresentationLedgerScenario[];
}

function payloadRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload) && Array.isArray(payload[0])) return payload[0] as T[];
  return (payload ?? []) as T[];
}

function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function loadPresentationLedger(execute: Execute, productId: number): Promise<PresentationLedger | null> {
  const product = payloadRows<{ name: string; description: string; output_language: string | null; analysis_executor?: string; organization_id: number; modelConfigured?: unknown }>(await execute(
    `SELECT p.name, p.description, p.output_language, p.analysis_executor, p.organization_id, ${MODEL_CONFIGURED_SQL} AS modelConfigured FROM products p WHERE p.id = ? LIMIT 1`,
    [productId],
  ))[0];
  if (!product) return null;
  const features = payloadRows<PresentationLedgerFeature>(await execute(
    "SELECT id, name, display_name AS displayName, summary, parent_id AS parentId FROM features WHERE product_id = ? AND active = 1 ORDER BY name",
    [productId],
  )).map((feature) => ({ ...feature, displayName: feature.displayName ?? "" }));
  const placeholders = features.map(() => "?").join(",");
  const scenarios = features.length === 0 ? [] : payloadRows<PresentationLedgerScenario>(await execute(
    `SELECT feature_id AS featureId, reference, context, action, outcome, category, step_order AS step, evidence
     FROM scenarios WHERE active = 1 AND feature_id IN (${placeholders}) ORDER BY reference`,
    features.map((feature) => feature.id),
  ));
  const latest = payloadRows<{ spec_version_id: number | null }>(await execute(
    "SELECT spec_version_id FROM releases WHERE product_id = ? AND spec_version_id IS NOT NULL ORDER BY committed_at DESC LIMIT 1",
    [productId],
  ))[0];
  return {
    productId,
    name: product.name,
    description: product.description ?? "",
    analysisExecutor: product.analysis_executor === "client" ? "client" : "server",
    organizationId: product.organization_id,
    modelConfigured: Number(product.modelConfigured ?? 0) === 1,
    language: presentationLanguage(product.output_language),
    specVersionId: latest?.spec_version_id ?? null,
    features,
    scenarios,
  };
}

export function presentationLedgerFingerprint(ledger: Pick<PresentationLedger, "features" | "scenarios" | "language">): string {
  return presentationFingerprint({ features: ledger.features, scenarios: ledger.scenarios, language: ledger.language });
}

// ── 生成 ──

interface RawJourney {
  name: string;
  steps: PresentationScenarioRef[];
}

/** 引用索引：把（功能名, 场景编号）解析成规范引用；只有 happy 场景可作旅程步骤。 */
function buildJourneyIndex(ledger: PresentationLedger) {
  const featureByKey = new Map(ledger.features.map((feature) => [normalize(feature.name), feature]));
  const happy = new Map<string, PresentationScenarioRef>();
  const featureOf = new Map<string, number>();
  for (const scenario of ledger.scenarios) {
    const feature = ledger.features.find((candidate) => candidate.id === scenario.featureId);
    if (!feature) continue;
    const key = normalize(`${feature.name}\u0000${scenario.reference}`);
    featureOf.set(key, feature.id);
    if (scenario.category === "happy") happy.set(key, { featureName: feature.name, reference: scenario.reference });
  }
  return {
    key: (featureName: string, reference: string) => normalize(`${featureName}\u0000${reference}`),
    featureIdOf: (featureName: string) => featureByKey.get(normalize(featureName))?.id ?? null,
    happy,
    featureOf,
  };
}

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function validJourney(journey: RawJourney, index: ReturnType<typeof buildJourneyIndex>, featureCount: number): boolean {
  if (journey.steps.length < 2 || journey.steps.length > 6) return false;
  const keys = journey.steps.map((step) => index.key(step.featureName, step.reference));
  if (new Set(keys).size !== keys.length) return false;
  if (keys.some((key) => !index.happy.has(key))) return false;
  // 只有一个功能的产品不强求跨功能；否则旅程必须连接至少两个功能（同功能内部步骤不是跨功能场景）。
  const featureIds = journey.steps.map((step) => index.featureOf.get(index.key(step.featureName, step.reference)));
  if (featureCount > 1 && new Set(featureIds).size < 2) return false;
  // 相邻两步不取自同一个功能（单功能产品除外）：同一功能的多条场景首尾相接是在罗列变体，不是用户旅程的后续步骤。
  // 首轮生成没有这条校验时，模型给出的 60 条旅程里有 22 条如此（如「知识健康统计 HP-1 → HP-2 → HP-3 → 知识健康面板」）。
  if (featureCount > 1 && chainsScenariosOfOneFeature(featureIds)) return false;
  return true;
}

/**
 * 旅程接纳器：逐条校验 + 去重的唯一实现（生成、合并、快照导入共用）。
 * 坏条目丢弃不连坐。判重口径是「经过的功能组合」（sameJourneyFeatures，与读侧投影同一份实现）——
 * 生产实测（2026-11-24）：按「功能 + 场景编号」判重时，模型会给同一对功能换着编号写三四条，
 * 11 个功能的产品挖出 20 条旅程只有 13 种走法。场景编号不同不算新场景；与已接纳旅程功能组合相同、
 * 高度相似、或只是其中一段（功能被完全包含）的丢弃；重名的也只留先到的一条。
 * 反过来，新旅程严格包含某条已接纳旅程（功能更多且涵盖其全部）时，更完整的那条胜出：原位替换，位置不变。
 * 接纳顺序即落库顺序，调用方必须按确定的顺序调用（与模型返回的先后无关）。
 */
function createJourneyAcceptor(index: ReturnType<typeof buildJourneyIndex>, featureCount: number, maxJourneys = Number.POSITIVE_INFINITY) {
  const accepted: Array<RawJourney & { tier: PresentationJourney["tier"]; capabilityNames: string[] }> = [];
  const seenFeatureSets: Array<Set<string>> = [];
  const seenNames: Array<string> = [];
  // 按功能 id 比较（validJourney 已保证每一步都解析得到）：功能名的写法差异不影响判重
  const featuresOf = (journey: RawJourney) => new Set(journey.steps.map((step) => String(index.featureOf.get(index.key(step.featureName, step.reference)))));
  const contains = (outer: Set<string>, inner: Set<string>) => [...inner].every((key) => outer.has(key));
  return {
    accepted,
    /** 接纳成功返回旅程在落库顺序中的位置（-1 = 被丢弃）。 */
    accept(journey: RawJourney, tier: PresentationJourney["tier"], capabilityNames: string[] = []): number {
      if (accepted.length >= maxJourneys) return -1;
      if (!validJourney(journey, index, featureCount)) return -1;
      const features = featuresOf(journey);
      // 严格包含某条已接纳旅程（功能更多且涵盖其全部）：更完整的这条胜出（原位替换），不因为「与它相似」被拒
      const replacedAt = seenFeatureSets.findIndex((set) => set.size < features.size && contains(features, set));
      // 与其他已接纳旅程是同一个场景（同功能组合 / 高度相似 / 只是其中一段）：丢弃
      if (seenFeatureSets.some((set, position) => position !== replacedAt && sameJourneyFeatures(set, features))) return -1;
      const nameKey = normalize(journey.name);
      if (nameKey === "" || (seenNames.includes(nameKey) && seenNames[replacedAt] !== nameKey)) return -1;
      const entry = { ...journey, tier, capabilityNames };
      if (replacedAt >= 0) {
        accepted.splice(replacedAt, 1, entry);
        seenFeatureSets.splice(replacedAt, 1, features);
        seenNames.splice(replacedAt, 1, nameKey);
        return replacedAt;
      }
      seenFeatureSets.push(features);
      seenNames.push(nameKey);
      accepted.push(entry);
      return accepted.length - 1;
    },
    /**
     * 把已接纳的旅程固化成落库形状：步骤存规范引用（与库里的功能名逐字一致），读侧直接按名解析。
     */
    finalize(): PresentationJourney[] {
      return accepted.map((journey, order) => ({
        id: `journey-${order + 1}`,
        name: journey.name,
        tier: journey.tier,
        capabilityNames: journey.capabilityNames,
        steps: journey.steps.map((step) => index.happy.get(index.key(step.featureName, step.reference))!),
      }));
    },
  };
}

/**
 * 功能 → 所属能力分组名（人工业务域或 AI 归组；未归组的功能没有条目）。返回的函数给一条旅程算标签：
 * 它的步骤实际触及了哪些能力（按首次出现排序、去重）。标签在每次生成 / 合并时按当前分组重算，
 * 所以归组变化后旧旅程的标签自动跟上；第一个标签是旅程出发的能力，读侧据此决定它的完整卡片放在哪个分组。
 */
function capabilityLabels(index: ReturnType<typeof buildJourneyIndex>, capabilities: PresentationCapability[]): (steps: PresentationScenarioRef[]) => string[] {
  const namesByFeatureId = new Map<number, string[]>();
  for (const capability of capabilities) {
    for (const name of capability.featureNames) {
      const id = index.featureIdOf(name);
      if (id !== null) namesByFeatureId.set(id, [...(namesByFeatureId.get(id) ?? []), capability.name]);
    }
  }
  return (steps) => {
    const names: string[] = [];
    for (const step of steps) {
      const featureId = index.featureOf.get(index.key(step.featureName, step.reference));
      for (const name of featureId === undefined ? [] : namesByFeatureId.get(featureId) ?? []) if (!names.includes(name)) names.push(name);
    }
    return names;
  };
}

/** 业务域父节点是分组本身，不作为旅程候选（其子级才是）；没有分组的产品全部功能都是叶子。 */
function leafFeaturesOf(ledger: PresentationLedger): PresentationLedgerFeature[] {
  const parentIds = new Set(ledger.features.flatMap((feature) => (feature.parentId === null ? [] : [feature.parentId])));
  return ledger.features.filter((feature) => !parentIds.has(feature.id));
}

/**
 * 与上一版合并（只增不减）。模型输出逐次有波动——生产实测同一个 122 功能的产品连续两次生成
 * 得到 45 条 / 35 条旅程、覆盖 80 / 62 个功能——直接覆盖会让「重新生成」越点越少。
 * 这里先保留上一版里在当前规则下仍然成立的旅程——规格变化后失效的、罗列同一功能多条场景的会被校验剔除——
 * 再并入本次新产出的旅程，按同一套判重口径（功能组合）去重，因此覆盖率不会下降。
 * 两版的全局典型场景先于能力场景接纳：同一走法若上一版是能力场景、这次挖成了典型场景，留下的是典型场景。
 * 上一版最多占三分之二名额，给新旅程留出进入空间；被某条新旅程完全包含的旧旅程让位给更完整的那条。
 */
export function mergePresentation(input: { previous: { capabilities: PresentationCapability[]; journeys: PresentationJourney[]; tagline?: string }; next: GeneratedPresentation; ledger: PresentationLedger; maxJourneys?: number }): GeneratedPresentation {
  const maxJourneys = input.maxJourneys ?? presentationMaxJourneys();
  const leafFeatures = leafFeaturesOf(input.ledger);
  const capabilities = input.next.capabilities.length > 0 ? input.next.capabilities : input.previous.capabilities;
  const index = buildJourneyIndex(input.ledger);
  const labelOf = capabilityLabels(index, capabilities);
  const acceptor = createJourneyAcceptor(index, leafFeatures.length, maxJourneys);
  // 标签按当前归组重算：上一版旅程带的是旧分组的名字
  const take = (journeys: PresentationJourney[]) => {
    for (const journey of journeys) acceptor.accept({ name: journey.name, steps: journey.steps }, journey.tier, labelOf(journey.steps));
  };
  const isHeadline = (journey: PresentationJourney) => journey.tier === "headline";
  const previousBudget = Math.floor(maxJourneys * 2 / 3);
  let previousTaken = 0;
  // 只有真正接纳的上一版旅程才占名额：被校验或判重剔除的不占
  const takePrevious = (tier: PresentationJourney["tier"]) => {
    for (const journey of input.previous.journeys.filter((item) => item.tier === tier)) {
      if (previousTaken >= previousBudget) return;
      if (acceptor.accept({ name: journey.name, steps: journey.steps }, journey.tier, labelOf(journey.steps)) >= 0) previousTaken += 1;
    }
  };
  takePrevious("headline");
  take(input.next.journeys.filter(isHeadline));
  takePrevious("capability");
  take(input.next.journeys.filter((journey) => !isHeadline(journey)));
  const journeys = acceptor.finalize();
  const tagline = input.next.tagline ?? input.previous.tagline;
  return {
    status: capabilities.length > 0 && journeys.length > 0 ? "generated" : "partial",
    language: input.next.language,
    ...(tagline ? { tagline } : {}),
    capabilities,
    journeys,
    coverage: journeyCoverage(input.ledger, journeys, leafFeatures.length),
    passes: input.next.passes,
  };
}

/**
 * 快照导入用：校验一批外部生成的旅程引用链（Radar 快照里的典型使用场景），全部按全局典型层登记。
 * 引用必须落在导入进来的 happy 场景上，否则丢弃。
 */
export function acceptImportedJourneys(input: { ledger: PresentationLedger; journeys: Array<{ name: string; steps: PresentationScenarioRef[] }>; capabilities?: PresentationCapability[] }): PresentationJourney[] {
  const index = buildJourneyIndex(input.ledger);
  const labelOf = capabilityLabels(index, input.capabilities ?? []);
  const acceptor = createJourneyAcceptor(index, input.ledger.features.length);
  for (const journey of input.journeys) acceptor.accept(journey, "headline", labelOf(journey.steps));
  return acceptor.finalize();
}

function completionClient(billing?: LlmBillingContext): StructuredCompletionClient {
  return {
    async complete(messages) {
      return requestStructuredCompletion(messages as StructuredCompletionMessage[], billing ? { ...billing, callKind: PRESENTATION_CALL_KIND } : undefined);
    },
  };
}

function toAnalysisResult(ledger: PresentationLedger, features: PresentationLedgerFeature[]): AnalysisResult {
  const scenariosByFeature = new Map<number, PresentationLedgerScenario[]>();
  for (const scenario of ledger.scenarios) {
    const list = scenariosByFeature.get(scenario.featureId) ?? [];
    list.push(scenario);
    scenariosByFeature.set(scenario.featureId, list);
  }
  return {
    product: { description: ledger.description, evidence: [] },
    release: { title: "", summary: "" },
    changes: [],
    features: features.map((feature) => ({
      name: feature.name,
      summary: feature.summary,
      scenarios: (scenariosByFeature.get(feature.id) ?? []).map((scenario) => ({
        reference: scenario.reference,
        context: scenario.context,
        action: scenario.action,
        outcome: scenario.outcome,
        category: scenario.category,
        step: scenario.step,
        evidence: evidenceItems(scenario.evidence) as AnalysisResult["features"][number]["scenarios"][number]["evidence"],
      })),
    })),
  } as AnalysisResult;
}

/** 挖掘桶：一趟能力域深挖的功能集合；name 为 null 表示不归属任何能力分组的功能。 */
interface Bucket {
  name: string | null;
  features: PresentationLedgerFeature[];
}

/** 一个挖掘窗口：scope 是提示词里的单一能力名（打包窗口为 null）；groups 是窗口涉及的分组及其成员功能（打包窗口 ≥ 2 个）。 */
interface MiningWindow {
  scope: string | null;
  groups: Array<{ name: string; features: string[] }>;
  features: PresentationLedgerFeature[];
}

type PendingBucket = { bucket: Bucket; features: PresentationLedgerFeature[] };

/**
 * 把各桶的待挖功能规划成窗口，按优先级排好返回：
 * - 大桶（≥ SMALL_BUCKET_FEATURES）单独成窗，按功能数降序；
 * - 小桶在「各自成窗就放不进剩余调用额度」时合并成打包窗口（≤ PACKED_WINDOW_BUCKETS 个分组、≤ WINDOW_FEATURES 个功能）；
 *   否则各自成窗——额度不紧张时单独成窗对每个能力更聚焦，也挖得更多；
 * - 只有一个功能的桶永远并入打包窗口：它单独成窗挖不出跨功能场景，并进去才有机会作为某一步出现，
 *   它所属的能力也才有落点。
 * 打包窗口排在最前：一趟就给很多小分组各一次出场机会。窗口带着「分组 → 成员功能」的归属，
 * 提示词据此让模型为每个分组构造场景。
 */
function planWindows(remaining: PendingBucket[], remainingCalls: number): MiningWindow[] {
  // 桶大的优先；同样大小时保持声明顺序（能力分组的顺序，未归组功能在最后）。
  const ordered = remaining.map((part, order) => ({ part, order })).sort((a, b) => b.part.features.length - a.part.features.length || a.order - b.order).map(({ part }) => part);
  const own = (part: PendingBucket, features = part.features): MiningWindow => ({
    scope: part.bucket.name,
    groups: part.bucket.name === null ? [] : [{ name: part.bucket.name, features: features.map((feature) => feature.name) }],
    features,
  });
  const singles: MiningWindow[] = [];
  const small: PendingBucket[] = [];
  const orphans: PendingBucket[] = [];
  for (const part of ordered) {
    if (part.features.length >= SMALL_BUCKET_FEATURES) {
      const chunks: PresentationLedgerFeature[][] = [];
      for (let start = 0; start < part.features.length; start += WINDOW_FEATURES) chunks.push(part.features.slice(start, start + WINDOW_FEATURES));
      // 末窗只剩一个功能时并入前一窗（旅程至少要两个功能，单功能窗口挖不出东西）
      if (chunks.length > 1 && chunks.at(-1)!.length === 1) chunks.at(-2)!.push(...chunks.pop()!);
      for (const features of chunks) singles.push(own(part, features));
    } else if (part.features.length > 1) small.push(part);
    else orphans.push(part);
  }
  // 与「剩余」调用额度比较（不是总上限）：前面各轮已经用掉的调用不再可用。
  const packSmall = singles.length + small.length > remainingCalls;
  const packed: MiningWindow[] = [];
  const empty = (): MiningWindow => ({ scope: null, groups: [], features: [] });
  let current = empty();
  for (const part of [...(packSmall ? small : []), ...orphans]) {
    const addsGroup = part.bucket.name !== null && !current.groups.some((group) => group.name === part.bucket.name);
    if (current.features.length > 0 && ((addsGroup && current.groups.length >= PACKED_WINDOW_BUCKETS) || current.features.length + part.features.length > WINDOW_FEATURES)) {
      packed.push(current);
      current = empty();
    }
    const names = part.features.map((feature) => feature.name);
    // 未归组功能（name 为 null）并入打包窗口，但不占用分组名额
    if (part.bucket.name !== null) {
      const existing = current.groups.find((group) => group.name === part.bucket.name);
      if (existing) existing.features.push(...names);
      else current.groups.push({ name: part.bucket.name, features: names });
    }
    current.features.push(...part.features);
  }
  if (!packSmall) singles.push(...small.map((part) => own(part)));
  if (current.features.length === 1) {
    // 打包到最后只剩孤零零一个功能：并入第一个还有余量的单桶窗口，别让它落单
    // （单功能窗口挖不出跨功能场景，会被下面的过滤丢掉，这个功能就永远没机会出现）。
    const host = singles.find((window) => window.features.length < WINDOW_FEATURES);
    if (host) {
      host.features.push(...current.features);
      current = empty();
    }
  }
  if (current.features.length > 0) packed.push(current);
  return [...packed, ...singles];
}
/** 窗口候选：每个功能取前 perFeature 条 happy 场景，只带叙述所需的最小字段（引用链之外不携带任何事实）。 */
function happyCandidates(ledger: PresentationLedger, features: PresentationLedgerFeature[], perFeature: number): JourneyCandidate[] {
  const scenariosByFeature = new Map<number, PresentationLedgerScenario[]>();
  for (const scenario of ledger.scenarios) {
    if (scenario.category !== "happy") continue;
    const list = scenariosByFeature.get(scenario.featureId) ?? [];
    list.push(scenario);
    scenariosByFeature.set(scenario.featureId, list);
  }
  return features.flatMap((feature) => (scenariosByFeature.get(feature.id) ?? []).slice(0, perFeature).map((scenario) => ({
    featureName: feature.name,
    reference: scenario.reference,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
  })));
}

/**
 * 一趟挖掘最多发两次请求：生产实测模型会把 JSON 要求忽略成 Markdown 叙事，
 * 首次输出不是 JSON 时带着原输出要求纠正一次，仍不行则该趟按空结果处理（不连坐其他趟）。
 */
async function mineJourneys(options: { client: StructuredCompletionClient; language: PresentationLanguage; description: string; scope: string | null; groups?: Array<{ name: string; features: string[] }>; maxJourneys: number; candidates: JourneyCandidate[] }): Promise<{ journeys: RawJourney[]; calls: number }> {
  if (options.candidates.length === 0) return { journeys: [], calls: 0 };
  const english = options.language === "en";
  const messages: StructuredCompletionMessage[] = [
    { role: "system", content: english ? "You reorganize existing scenarios into user journeys without adding facts. Output exactly one JSON object and nothing else. Use English for the journey names." : "你把已有场景重组成用户旅程，不新增事实。只输出一个 JSON 对象，不输出任何其他内容。旅程名称使用简体中文。" },
    { role: "user", content: journeyMiningPrompt({ productDescription: options.description, capabilityName: options.scope, groups: options.groups, maxJourneys: options.maxJourneys, candidates: options.candidates }, options.language) },
  ];
  const first = await options.client.complete(messages);
  try {
    return { journeys: parseJourneyCandidates(first), calls: 1 };
  } catch (error) {
    console.warn("[product-presentation] journey pass output is not JSON; asking for JSON once", { scope: options.scope, groups: options.groups?.length, message: errorMessage(error) });
  }
  const corrected = await options.client.complete([
    ...messages,
    { role: "assistant", content: first },
    { role: "user", content: english
      ? `The previous output is not JSON. Return exactly one JSON object and nothing else — no Markdown, headings, numbered lists or explanations — with this shape: ${JOURNEY_OUTPUT_SHAPE}. Copy every step verbatim (featureName and reference) from the candidate list.`
      : `上一次输出不是 JSON。只返回一个 JSON 对象，不要 Markdown、标题、编号列表或任何解释，结构为：${JOURNEY_OUTPUT_SHAPE}；步骤必须逐字取自候选列表（featureName 与 reference 完全一致）。` },
  ]);
  try {
    return { journeys: parseJourneyCandidates(corrected), calls: 2 };
  } catch (error) {
    console.warn("[product-presentation] journey pass output still unparsable after one correction", { scope: options.scope, groups: options.groups?.length, message: errorMessage(error) });
    return { journeys: [], calls: 2 };
  }
}

export interface GeneratedPresentation {
  status: PresentationStatus;
  language: PresentationLanguage;
  tagline?: string;
  capabilities: PresentationCapability[];
  journeys: PresentationJourney[];
  coverage: PresentationCoverage;
  /** 实际发出的模型调用数（Radar 归组路径按其内部调用数估算）。 */
  passes: number;
}

export async function generateProductPresentation(input: { ledger: PresentationLedger; billing?: LlmBillingContext; client?: StructuredCompletionClient; maxPasses?: number; maxJourneys?: number }): Promise<GeneratedPresentation> {
  const client = input.client ?? completionClient(input.billing);
  const language = input.ledger.language;
  const maxPasses = input.maxPasses ?? presentationMaxPasses();
  const maxJourneys = input.maxJourneys ?? presentationMaxJourneys();
  const ledger = input.ledger;
  const featureById = new Map(ledger.features.map((feature) => [feature.id, feature]));
  const childrenByParent = new Map<number, PresentationLedgerFeature[]>();
  for (const feature of ledger.features) {
    if (feature.parentId === null || !featureById.has(feature.parentId)) continue;
    const siblings = childrenByParent.get(feature.parentId) ?? [];
    siblings.push(feature);
    childrenByParent.set(feature.parentId, siblings);
  }
  const leafFeatures = leafFeaturesOf(ledger);
  const index = buildJourneyIndex(ledger);
  // passes = 实际发出的模型调用总数（归组 + 挖掘，供成本核对）；maxPasses 只约束挖掘调用——
  // 能力归组的调用数由功能数自然界定（约 功能数/50 + 2），若与挖掘共用一个上限，大产品光归组就会
  // 用光预算、一趟深挖都做不了。
  let passes = 0;
  let miningCalls = 0;

  // 1) 能力归纳：人工业务域优先；没有则复用 Radar 归组（失败只放弃分组，旅程照常）。
  let capabilities: PresentationCapability[] = [];
  let headline: RawJourney[] = [];
  let tagline: string | undefined;
  if (childrenByParent.size > 0) {
    const scenarioCount = new Map<number, number>();
    for (const scenario of ledger.scenarios) scenarioCount.set(scenario.featureId, (scenarioCount.get(scenario.featureId) ?? 0) + 1);
    const count = (feature: PresentationLedgerFeature) => scenarioCount.get(feature.id) ?? 0;
    capabilities = [...childrenByParent.entries()]
      .map(([parentId, children]) => {
        const parent = featureById.get(parentId)!;
        return { parent, children, weight: children.reduce((total, child) => total + count(child), 0) + count(parent) };
      })
      .sort((a, b) => b.weight - a.weight || a.parent.name.localeCompare(b.parent.name))
      .map(({ parent, children }, order) => ({
        id: `capability-${order + 1}`,
        name: parent.displayName || parent.name,
        summary: parent.summary,
        featureNames: children.map((child) => child.name),
      }));
  } else if (leafFeatures.length > 0) {
    try {
    // relax：真实模型经常超出 Radar 小产品路径的数量上限（如每个能力给出 4–6 条示例引用），
    // 严格模式会让整份归组作废；站内逐条 salvage，只保「每个功能恰好归属一次」这条硬约束。
    const radar = await createSnapshotPresentation({ result: toAnalysisResult(ledger, leafFeatures), language, client, relax: true });
      passes += leafFeatures.length > 40 ? 2 + Math.ceil(leafFeatures.length / 50) : 1;
      capabilities = radar.coreCapabilities.map((capability, order) => ({ id: `capability-${order + 1}`, name: capability.name, summary: capability.summary, featureNames: capability.featureNames }));
      headline = radar.journeys.map((journey) => ({ name: journey.name, steps: journey.steps.map((step) => ({ featureName: step.featureName, reference: step.reference })) }));
      tagline = radar.tagline;
    } catch (error) {
      console.warn("[product-presentation] capability grouping failed; falling back to flat cards", { productId: ledger.productId, message: errorMessage(error) });
    }
  }

  const groupedIds = new Set(capabilities.flatMap((capability) => capability.featureNames.map((name) => index.featureIdOf(name)).filter((id): id is number => id !== null)));
  // 单功能的能力分组也留在桶里：它单独成窗挖不出跨功能场景，但并进打包窗口后有机会作为某一步出现。
  const buckets: Bucket[] = [
    ...capabilities.map((capability) => ({ name: capability.name, features: capability.featureNames.flatMap((name) => { const id = index.featureIdOf(name); const feature = id === null ? undefined : featureById.get(id); return feature && leafFeatures.includes(feature) ? [feature] : []; }) })),
    { name: null, features: leafFeatures.filter((feature) => !groupedIds.has(feature.id)) },
  ].filter((bucket) => bucket.features.length > 0);

  // 2) 全局典型旅程：Radar 归组路径已带出；业务域路径（或归组失败）补一趟跨桶采样。
  if (headline.length === 0 && leafFeatures.length > 1) {
    // 每个功能只带一条场景：带两条时，模型会把同一功能的两步首尾相接当成「旅程」（生产实测 5 条里 4 条如此），
    // 这些不跨功能的链会被校验拒掉；把额度用在覆盖更多功能上，才能得到真正的全局典型场景。
    const sample = evenlySample([
      ...buckets.filter((bucket) => bucket.name !== null).flatMap((bucket) => evenlySample(bucket.features, HEADLINE_FEATURES_PER_BUCKET)),
      ...buckets.filter((bucket) => bucket.name === null).flatMap((bucket) => evenlySample(bucket.features, HEADLINE_UNGROUPED_FEATURES)),
    ], HEADLINE_MAX_FEATURES);
    const description = tagline ?? ledger.description;
    const mined = await mineJourneys({ client, language, description, scope: null, maxJourneys: HEADLINE_MAX_JOURNEYS, candidates: happyCandidates(ledger, sample, 1) });
    headline = mined.journeys;
    miningCalls += mined.calls;
    passes += mined.calls;
  }

  // 标签 = 旅程实际触及的能力（按步骤所属功能对照当前归组算出），与它在哪个窗口被挖出来无关。
  const labelOf = capabilityLabels(index, capabilities);
  const acceptor = createJourneyAcceptor(index, leafFeatures.length, maxJourneys);
  for (const journey of headline) acceptor.accept(journey, "headline", labelOf(journey.steps));

  // 3) 深挖（逐轮收敛）：每轮把尚未被任何旅程覆盖的功能规划成窗口（见 planWindows），直到预算用完、
  //    旅程数到上限、一轮下来没有新增，或已没有可挖的功能。
  //    预算按「送进模型的功能量」计（featureBudget）——一趟只送 3 个功能不该和一趟送 40 个功能等价；
  //    调用次数另设硬上限（callCap）约束每趟的固定开销。全局典型场景那一趟计入调用上限。
  const happyCount = new Map<number, number>();
  for (const scenario of ledger.scenarios) if (scenario.category === "happy") happyCount.set(scenario.featureId, (happyCount.get(scenario.featureId) ?? 0) + 1);
  const featureBudget = maxPasses * WINDOW_FEATURES;
  const callCap = maxPasses * 2;
  let featuresSent = 0;
  let remaining: PendingBucket[] = buckets.map((bucket) => ({ bucket, features: [...bucket.features].sort((a, b) => (happyCount.get(b.id) ?? 0) - (happyCount.get(a.id) ?? 0) || a.name.localeCompare(b.name)) }));
  for (let round = 0; round < MINING_ROUNDS && acceptor.accepted.length < maxJourneys && miningCalls < callCap && featuresSent < featureBudget; round += 1) {
    const toRun: MiningWindow[] = [];
    for (const window of planWindows(remaining, callCap - miningCalls)) {
      if (window.features.length < 2) continue;
      if (featuresSent + window.features.length > featureBudget || miningCalls + toRun.length >= callCap) break;
      toRun.push(window);
      featuresSent += window.features.length;
    }
    if (toRun.length === 0) break;
    const results: Array<RawJourney[] | null> = new Array(toRun.length).fill(null);
    let cursor = 0;
    let calls = 0;
    // 并发只加速请求；结果的校验、去重与接纳严格按窗口顺序进行，产出顺序确定。
    const worker = async () => {
      while (cursor < toRun.length) {
        const passIndex = cursor++;
        const pass = toRun[passIndex];
        const packed = pass.groups.length > 1;
        try {
          const mined = await mineJourneys({
            client, language, description: tagline ?? ledger.description, scope: pass.scope, groups: packed ? pass.groups : undefined,
            // 打包窗口涉及多个分组：多要几条，才够每个分组都有一条
            maxJourneys: packed ? Math.min(PACKED_MAX_JOURNEYS, Math.max(JOURNEYS_PER_PASS, pass.groups.length)) : JOURNEYS_PER_PASS,
            candidates: happyCandidates(ledger, pass.features, SCENARIOS_PER_FEATURE),
          });
          results[passIndex] = mined.journeys;
          calls += mined.calls;
        } catch (error) {
          console.error("[product-presentation] journey pass failed", { productId: ledger.productId, scope: pass.scope, groups: pass.groups.length, message: errorMessage(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PASS_CONCURRENCY, toRun.length) }, () => worker()));
    miningCalls += calls;
    passes += calls;
    // 严格按窗口顺序接纳（产出顺序确定，不随请求完成先后变化）。
    const before = acceptor.accepted.length;
    for (const result of results) {
      if (acceptor.accepted.length >= maxJourneys) break;
      for (const journey of result ?? []) acceptor.accept(journey, "capability", labelOf(journey.steps));
    }
    // 一轮下来没有新增就停：同样的输入再挖一轮也不会有新东西。
    if (acceptor.accepted.length === before) break;
    const covered = new Set(acceptor.accepted.flatMap((journey) => journey.steps.map((step) => index.featureOf.get(index.key(step.featureName, step.reference)))));
    remaining = remaining
      .map(({ bucket, features }) => ({ bucket, features: features.filter((feature) => !covered.has(feature.id)) }))
      .filter(({ features }) => features.length > 0);
    if (remaining.length === 0) break;
  }

  const journeys = acceptor.finalize();
  return {
    status: capabilities.length > 0 && journeys.length > 0 ? "generated" : capabilities.length > 0 || journeys.length > 0 ? "partial" : "failed",
    language,
    ...(tagline ? { tagline } : {}),
    capabilities,
    journeys,
    coverage: journeyCoverage(ledger, journeys, leafFeatures.length),
    passes,
  };
}

/** 旅程覆盖率：被至少一条旅程引用的功能数 / 场景数（按规范引用统计）。featuresTotal 缺省为全部功能。 */
export function journeyCoverage(ledger: PresentationLedger, journeys: PresentationJourney[], featuresTotal = ledger.features.length): PresentationCoverage {
  const nameById = new Map(ledger.features.map((feature) => [feature.id, feature.name]));
  const featureOf = new Map(ledger.scenarios.map((scenario) => [normalize(`${nameById.get(scenario.featureId) ?? ""}\u0000${scenario.reference}`), scenario.featureId]));
  const keys = journeys.flatMap((journey) => journey.steps.map((step) => normalize(`${step.featureName}\u0000${step.reference}`)));
  return {
    featuresTotal,
    featuresInJourneys: new Set(keys.map((key) => featureOf.get(key)).filter((id): id is number => id !== undefined)).size,
    scenariosInJourneys: new Set(keys).size,
  };
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * items.length / limit)]);
}

// ── 落库与调度 ──

/** 理解层落库（每产品一行）：生成期间若规格又变了（pending_fingerprint 与本次指纹不同）则保持待更新并排期。 */
export async function saveProductPresentation(execute: Execute, input: { productId: number; specVersionId: number | null; source: "generated" | "ai_snapshot_import" | "client_generated"; fingerprint: string; payload: GeneratedPresentation; modelName?: string | null }) {
  await execute(
    `INSERT INTO product_presentations (product_id, spec_version_id, language, status, source, tagline, capabilities_json, journeys_json, coverage_json, fingerprint, model_name, passes, last_error, last_attempt_at, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       spec_version_id = VALUES(spec_version_id), language = VALUES(language), status = VALUES(status), source = VALUES(source),
       tagline = VALUES(tagline), capabilities_json = VALUES(capabilities_json), journeys_json = VALUES(journeys_json),
       coverage_json = VALUES(coverage_json), fingerprint = VALUES(fingerprint), model_name = VALUES(model_name), passes = VALUES(passes),
       last_error = NULL, last_attempt_at = CURRENT_TIMESTAMP(3), generated_at = CURRENT_TIMESTAMP(3), failure_count = 0,
       pending = IF(pending_fingerprint IS NULL OR pending_fingerprint = VALUES(fingerprint), 0, 1),
       next_attempt_at = IF(pending = 1, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR), NULL),
       pending_fingerprint = IF(pending = 1, pending_fingerprint, NULL),
       lease_until = NULL`,
    [
      input.productId, input.specVersionId, input.payload.language, input.payload.status, input.source, input.payload.tagline ?? null,
      JSON.stringify(input.payload.capabilities.map((capability) => ({ name: capability.name, summary: capability.summary, featureNames: capability.featureNames }))),
      JSON.stringify(input.payload.journeys.map((journey) => ({ name: journey.name, tier: journey.tier, capabilityNames: journey.capabilityNames, steps: journey.steps }))),
      JSON.stringify(input.payload.coverage), input.fingerprint, input.modelName ?? null, input.payload.passes,
      presentationRefreshIntervalHours(),
    ],
  );
}

async function ensurePresentationRow(execute: Execute, productId: number) {
  await execute(
    "INSERT INTO product_presentations (product_id, capabilities_json, journeys_json) VALUES (?, '[]', '[]') ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
    [productId],
  );
}

export type PresentationRefreshOutcome = "skipped" | "unchanged" | "generating" | "generated" | "failed" | "deferred";

export interface PresentationRefreshResult {
  outcome: PresentationRefreshOutcome;
  reason?: string;
  detail?: Record<string, unknown>;
}

export function standalonePresentationBilling(): LlmBillingContext {
  return { runId: null, accountId: null, chargeComponent: "main", callKind: PRESENTATION_CALL_KIND };
}

/**
 * 执行一次生成，与上一版合并（手动强制时可能直接替换）后落库。自身不抛错。
 * - 自动刷新走合并，只增不减（见 mergePresentation）：使用场景不会变少；规格变化后失效的、罗列同一功能多条场景的旧旅程被剔除；
 * - 手动强制（replace）时，全新结果的覆盖面不输「上一版在当前规则下仍然成立的部分」就直接替换上一版：
 *   手动「重新生成」要的是按当前规则重来一遍，不是往旧内容上叠加；这次挖得更少时仍走合并；
 * - 本次什么都没产出（能力与旅程都为空）视为失败，不落库——已有内容原样保留；
 * - 失败时保留旧内容、释放租约并安排重试：从未成功过的产品前 3 次 1 小时后重试、之后每天一次；已有内容的每天至多一次。
 */
export async function runPresentationGeneration(input: { ledger: PresentationLedger; specVersionId?: number | null; billing?: LlmBillingContext; client?: StructuredCompletionClient; execute?: Execute; replace?: boolean }): Promise<PresentationRefreshResult> {
  const execute = input.execute ?? defaultExecute;
  const productId = input.ledger.productId;
  const fingerprint = presentationLedgerFingerprint(input.ledger);
  const fail = async (reason: string): Promise<PresentationRefreshResult> => {
    console.error("[product-presentation] generation failed", { productId, message: reason });
    await execute(
      // 赋值顺序有意义（MySQL 自左向右求值）：next_attempt_at 先按「含本次的失败次数」选退避档，failure_count 再自增。
      `UPDATE product_presentations
       SET next_attempt_at = IF(pending = 1, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL IF(generated_at IS NULL AND failure_count + 1 <= ?, ?, ? * 60) MINUTE), NULL),
           failure_count = failure_count + 1,
           status = IF(generated_at IS NULL, 'failed', status), last_error = ?, last_attempt_at = CURRENT_TIMESTAMP(3), lease_until = NULL
       WHERE product_id = ?`,
      [FAST_FAILURE_RETRIES, FAILURE_RETRY_MINUTES, presentationRefreshIntervalHours(), reason, productId],
    ).catch((writeError) => console.error("[product-presentation] failure record failed", { productId, message: errorMessage(writeError) }));
    return { outcome: "failed", reason };
  };
  try {
    // 整个生成都在产品所属工作区自己的模型里跑（lib/organization-model.ts）。工作区的配置读不到，就在这里抛出：
    // 记成一次失败并留下原因，不会退回 CoDelphi 自己的模型。
    const organizationId = input.ledger.organizationId;
    if (organizationId === undefined) return await fail("model_not_configured: the product's workspace is unknown, so there is no model to generate with");
    let usedModel: string | null = null;
    const next = await withOrganizationModel(organizationId, async () => {
      const generated = await generateProductPresentation({ ledger: input.ledger, billing: input.billing, client: input.client });
      // 落库要记实际用的模型：只有在这个范围里才读得到，出去就没了。
      usedModel = currentOrganizationModel()?.model ?? process.env.AI_MODEL ?? null;
      return generated;
    }, execute);
    if (next.capabilities.length === 0 && next.journeys.length === 0) return await fail("NO_VALID_OUTPUT: the model produced no valid capability group or journey");
    const stored = payloadRows<{ capabilities_json: unknown; journeys_json: unknown; tagline: string | null }>(await execute(
      "SELECT capabilities_json, journeys_json, tagline FROM product_presentations WHERE product_id = ? LIMIT 1",
      [productId],
    ))[0];
    const previous = stored
      ? parsePresentationPayload({ status: "generated", capabilities: parseJsonValue(stored.capabilities_json), journeys: parseJsonValue(stored.journeys_json), coverage: undefined })
      : { capabilities: [], journeys: [] };
    const previousInput = { ...previous, tagline: stored?.tagline ?? undefined };
    // 全新结果的覆盖面不输「上一版在当前规则下仍然成立的部分」→ 不带入上一版（上一版只留能力分组与 tagline 作兜底）。
    // 上一版里罗列同一功能多条场景、或互相重复的条目已被当前规则剔除，不会因为「曾经有过」而压住全新的结果。
    const replaced = input.replace === true && next.journeys.length > 0
      && next.coverage.featuresInJourneys >= mergePresentation({ previous: previousInput, next: { ...next, journeys: [] }, ledger: input.ledger }).coverage.featuresInJourneys;
    const payload = replaced
      ? mergePresentation({ previous: { ...previousInput, journeys: [] }, next, ledger: input.ledger })
      : mergePresentation({ previous: previousInput, next, ledger: input.ledger });
    await saveProductPresentation(execute, {
      productId,
      specVersionId: input.specVersionId === undefined ? input.ledger.specVersionId : input.specVersionId,
      source: "generated",
      fingerprint,
      payload,
      modelName: usedModel,
    });
    const detail = { status: payload.status, capabilities: payload.capabilities.length, journeys: payload.journeys.length, replaced, keptFromPrevious: previous.journeys.length, freshlyGenerated: next.journeys.length, passes: payload.passes, coveredFeatures: payload.coverage.featuresInJourneys, featuresTotal: payload.coverage.featuresTotal };
    console.log("[product-presentation] generated", { productId, ...detail });
    return { outcome: "generated", detail };
  } catch (error) {
    return fail(errorMessage(error));
  }
}

/**
 * 节流调度：指纹未变 → unchanged（零模型调用）；首次或已过间隔 → 立即生成；否则只标记待更新；
 * 从未成功且连续失败达上限的产品按排期退避重试。
 * 时间比较全部在 SQL 侧用墙钟完成（DATETIME 列与 JS 侧比较存在时区偏移，见既有教训）。
 * background=false 时同步等待生成并返回其结果（sweep 与测试用）。
 */
export async function schedulePresentationRefresh(options: {
  productId: number;
  specVersionId?: number | null;
  billing?: LlmBillingContext;
  /** 手动触发：无视节流间隔立即生成。 */
  force?: boolean;
  background?: boolean;
  execute?: Execute;
  client?: StructuredCompletionClient;
}): Promise<PresentationRefreshResult> {
  const execute = options.execute ?? defaultExecute;
  const ledger = await loadPresentationLedger(execute, options.productId);
  if (!ledger) return { outcome: "skipped", reason: "product_not_found" };
  // 客户端分析的产品：理解层随提案一起交上来，服务端不为它调模型（定时清扫和手动刷新都走这里）。
  if (ledger.analysisExecutor === "client") return { outcome: "skipped", reason: "client_analysed" };
  if (ledger.features.length === 0) return { outcome: "skipped", reason: "no_features" };
  // 工作区没有自己的模型：CoDelphi 不替用户付模型费用，同样不生成。
  if (!ledger.modelConfigured) return { outcome: "skipped", reason: "model_not_configured" };
  const fingerprint = presentationLedgerFingerprint(ledger);
  await ensurePresentationRow(execute, options.productId);
  const state = payloadRows<{ fingerprint: string; pending: number; interval_elapsed: number | null; never_generated: number | null; failure_count: number | null; retry_due: number | null }>(await execute(
    `SELECT fingerprint, pending, generated_at IS NULL AS never_generated, failure_count,
            (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP(3)) AS retry_due,
            (generated_at IS NULL OR generated_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)) AS interval_elapsed
     FROM product_presentations WHERE product_id = ? LIMIT 1`,
    [presentationRefreshIntervalHours(), options.productId],
  ))[0];
  const specVersionId = options.specVersionId === undefined ? ledger.specVersionId : options.specVersionId;
  const launch = async (): Promise<PresentationRefreshResult> => {
    const result = runPresentationGeneration({ ledger, specVersionId, billing: options.billing, client: options.client, execute, replace: options.force === true });
    if (options.background === false) return result;
    void result.catch((error) => console.error("[product-presentation] background refresh crashed", { productId: options.productId, message: errorMessage(error) }));
    return { outcome: "generating" };
  };
  if (!options.force && state && state.fingerprint === fingerprint) {
    // 规格与已落库的理解层一致：没有需要重算的东西。待更新标记若还在（规格改回原样），一并清掉。
    if (Number(state.pending) === 1) {
      await execute("UPDATE product_presentations SET pending = 0, pending_fingerprint = NULL, next_attempt_at = NULL WHERE product_id = ? AND pending = 1", [options.productId]);
    }
    return { outcome: "unchanged" };
  }
  // 到期判定（时间比较都在上面的 SQL 里完成）：
  // - 已有内容：距上次成功生成满间隔才重算；
  // - 从未成功：默认立即尝试；连续失败达到 FAST_FAILURE_RETRIES 后退避，只在排定的重试时间到期后再试——
  //   否则持续失败的产品会在每次分析推送和每轮 sweep 上无上限地重花模型调用。
  const neverGenerated = Number(state?.never_generated ?? 1) === 1;
  const throttled = Boolean(state) && neverGenerated && Number(state!.failure_count ?? 0) >= FAST_FAILURE_RETRIES;
  const due = options.force === true || !state || (neverGenerated ? !throttled || Number(state!.retry_due) === 1 : Number(state!.interval_elapsed) === 1);
  if (!due) {
    // 已排定的重试时间不往后推：否则高频推送的产品会一直等不到重试。
    await execute(
      `UPDATE product_presentations SET pending = 1, pending_fingerprint = ?,
         next_attempt_at = COALESCE(next_attempt_at, DATE_ADD(COALESCE(generated_at, CURRENT_TIMESTAMP(3)), INTERVAL ? HOUR))
       WHERE product_id = ?`,
      [fingerprint, presentationRefreshIntervalHours(), options.productId],
    );
    return { outcome: "deferred", reason: throttled ? "failure_backoff" : "within_refresh_interval" };
  }
  const claimed = affectedRows(await execute(
    `UPDATE product_presentations
     SET lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE), pending = 1, pending_fingerprint = ?, last_attempt_at = CURRENT_TIMESTAMP(3)
     WHERE product_id = ? AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))`,
    [LEASE_MINUTES, fingerprint, options.productId],
  )) === 1;
  if (!claimed) return { outcome: "deferred", reason: "generation_in_progress" };
  return launch();
}

/** sweep 作业：领取到期（或没有排期）的待更新产品，逐个重算；每轮至多 2 个，成本有界。 */
export async function runPresentationRefreshSweepOnce(options: { execute?: Execute; client?: StructuredCompletionClient; limit?: number } = {}): Promise<{ due: number; generated: number; failed: number; deferred: number }> {
  const execute = options.execute ?? defaultExecute;
  const due = payloadRows<{ product_id: number }>(await execute(
    `SELECT product_id FROM product_presentations
     WHERE pending = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP(3))
       AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))
       AND product_id NOT IN (SELECT id FROM products WHERE analysis_executor = 'client')
       AND EXISTS(SELECT 1 FROM products p WHERE p.id = product_presentations.product_id AND ${MODEL_CONFIGURED_SQL})
     ORDER BY next_attempt_at IS NULL DESC, next_attempt_at LIMIT ?`,
    [options.limit ?? 2],
  ));
  const summary = { due: due.length, generated: 0, failed: 0, deferred: 0 };
  for (const row of due) {
    const result = await schedulePresentationRefresh({ productId: Number(row.product_id), billing: standalonePresentationBilling(), background: false, execute, client: options.client });
    if (result.outcome === "generated") summary.generated += 1;
    else if (result.outcome === "failed") summary.failed += 1;
    else summary.deferred += 1;
  }
  return summary;
}

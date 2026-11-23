import { requestStructuredCompletion, type AnalysisResult, type LlmBillingContext } from "./ai";
import { defaultExecute, type Execute } from "./db";
import { evidenceItems } from "./evidence";
import { parseJsonValue } from "./json";
import { presentationMaxJourneys, presentationMaxPasses, presentationRefreshIntervalHours } from "./env";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "./llm-client";
import { createSnapshotPresentation, JOURNEY_OUTPUT_SHAPE, journeyMiningPrompt, parseJourneyCandidates, type JourneyCandidate } from "./snapshot/presentation";
import {
  parsePresentationPayload,
  presentationFingerprint,
  presentationLanguage,
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
const HEADLINE_FEATURES_PER_BUCKET = 12;
const PASS_CONCURRENCY = 3;
const JOURNEY_SIMILARITY_THRESHOLD = 0.6;
/** 深挖的轮数上限：第一轮全覆盖，之后只针对仍未覆盖的功能再挖，至多三轮。 */
const MINING_ROUNDS = 3;

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
  const product = payloadRows<{ name: string; description: string; output_language: string | null }>(await execute(
    "SELECT name, description, output_language FROM products WHERE id = ? LIMIT 1",
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
  if (featureCount > 1 && new Set(keys.map((key) => index.featureOf.get(key))).size < 2) return false;
  return true;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 旅程接纳器：逐条校验 + 去重的唯一实现（生成、合并、快照导入共用）。
 * 坏条目丢弃不连坐；步骤集合相同或 Jaccard ≥ 0.6 的旅程、重名的旅程只保留先到的一条；
 * 步骤被某条已接纳旅程完全包含的也丢弃——它只是更长场景的一个子片段，对读者没有增量
 * （生产实测：全局典型场景「从登录到添加产品并生成首版规格」之下会挖出它的前两步单独成条）。
 * 反过来，新旅程严格包含某条已接纳旅程时，更完整的那条胜出：原位替换，位置不变。
 * 接纳顺序即落库顺序，调用方必须按确定的顺序调用（与模型返回的先后无关）。
 */
function createJourneyAcceptor(index: ReturnType<typeof buildJourneyIndex>, featureCount: number, maxJourneys = Number.POSITIVE_INFINITY) {
  const accepted: Array<RawJourney & { tier: PresentationJourney["tier"]; capabilityName: string | null }> = [];
  const seenStepSets: Array<Set<string>> = [];
  const seenNames: Array<string> = [];
  const contains = (outer: Set<string>, inner: Set<string>) => [...inner].every((key) => outer.has(key));
  return {
    accepted,
    /** 接纳成功返回旅程在落库顺序中的位置（-1 = 被丢弃）。 */
    accept(journey: RawJourney, tier: PresentationJourney["tier"], capabilityName: string | null): number {
      if (accepted.length >= maxJourneys) return -1;
      if (!validJourney(journey, index, featureCount)) return -1;
      const keys = new Set(journey.steps.map((step) => index.key(step.featureName, step.reference)));
      // 严格包含某条已接纳旅程（步骤更多且涵盖其全部）：更完整的这条胜出（原位替换），不因为「与它相似」被拒；
      // 步骤集合完全相同的不算包含，仍按重复处理。
      const replacedAt = seenStepSets.findIndex((set) => set.size < keys.size && contains(keys, set));
      // 与其他已接纳旅程高度相似、或只是其中一条的子片段：丢弃
      if (seenStepSets.some((set, position) => position !== replacedAt && (jaccard(set, keys) >= JOURNEY_SIMILARITY_THRESHOLD || contains(set, keys)))) return -1;
      const nameKey = normalize(journey.name);
      if (nameKey === "" || (seenNames.includes(nameKey) && seenNames[replacedAt] !== nameKey)) return -1;
      const entry = { ...journey, tier, capabilityName };
      if (replacedAt >= 0) {
        accepted.splice(replacedAt, 1, entry);
        seenStepSets.splice(replacedAt, 1, keys);
        seenNames.splice(replacedAt, 1, nameKey);
        return replacedAt;
      }
      seenStepSets.push(keys);
      seenNames.push(nameKey);
      accepted.push(entry);
      return accepted.length - 1;
    },
    /** 把已接纳的旅程固化成落库形状：步骤存规范引用（与库里的功能名逐字一致），读侧直接按名解析。 */
    finalize(): PresentationJourney[] {
      return accepted.map((journey, order) => ({
        id: `journey-${order + 1}`,
        name: journey.name,
        tier: journey.tier,
        capabilityName: journey.capabilityName,
        steps: journey.steps.map((step) => index.happy.get(index.key(step.featureName, step.reference))!),
      }));
    },
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
 * 这里先保留上一版里引用在当前规格中仍然成立的旅程（规格变化后失效的会被校验自然剔除），
 * 再并入本次新产出的旅程，同名 / 高度相似 / 子片段按同一套规则去重，因此覆盖率不会下降。
 * 上一版最多占三分之二名额，给新功能留出进入空间；被某条新旅程完全包含的旧旅程让位给更完整的那条。
 */
export function mergePresentation(input: { previous: { capabilities: PresentationCapability[]; journeys: PresentationJourney[]; tagline?: string }; next: GeneratedPresentation; ledger: PresentationLedger; maxJourneys?: number }): GeneratedPresentation {
  const maxJourneys = input.maxJourneys ?? presentationMaxJourneys();
  const leafFeatures = leafFeaturesOf(input.ledger);
  const acceptor = createJourneyAcceptor(buildJourneyIndex(input.ledger), leafFeatures.length, maxJourneys);
  const take = (journeys: PresentationJourney[], budget: number) => {
    for (const journey of journeys.slice(0, budget)) acceptor.accept({ name: journey.name, steps: journey.steps }, journey.tier, journey.capabilityName);
  };
  take(input.previous.journeys, Math.floor(maxJourneys * 2 / 3));
  take(input.next.journeys, maxJourneys);
  const journeys = acceptor.finalize();
  const capabilities = input.next.capabilities.length > 0 ? input.next.capabilities : input.previous.capabilities;
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
export function acceptImportedJourneys(input: { ledger: PresentationLedger; journeys: Array<{ name: string; steps: PresentationScenarioRef[] }> }): PresentationJourney[] {
  const acceptor = createJourneyAcceptor(buildJourneyIndex(input.ledger), input.ledger.features.length);
  for (const journey of input.journeys) acceptor.accept(journey, "headline", null);
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
async function mineJourneys(options: { client: StructuredCompletionClient; language: PresentationLanguage; description: string; capabilityName: string | null; maxJourneys: number; candidates: JourneyCandidate[] }): Promise<{ journeys: RawJourney[]; calls: number }> {
  if (options.candidates.length === 0) return { journeys: [], calls: 0 };
  const english = options.language === "en";
  const messages: StructuredCompletionMessage[] = [
    { role: "system", content: english ? "You reorganize existing scenarios into user journeys without adding facts. Output exactly one JSON object and nothing else. Use English for the journey names." : "你把已有场景重组成用户旅程，不新增事实。只输出一个 JSON 对象，不输出任何其他内容。旅程名称使用简体中文。" },
    { role: "user", content: journeyMiningPrompt({ productDescription: options.description, capabilityName: options.capabilityName, maxJourneys: options.maxJourneys, candidates: options.candidates }, options.language) },
  ];
  const first = await options.client.complete(messages);
  try {
    return { journeys: parseJourneyCandidates(first), calls: 1 };
  } catch (error) {
    console.warn("[product-presentation] journey pass output is not JSON; asking for JSON once", { capability: options.capabilityName, message: errorMessage(error) });
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
    console.warn("[product-presentation] journey pass output still unparsable after one correction", { capability: options.capabilityName, message: errorMessage(error) });
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

  const grouped = new Set(capabilities.flatMap((capability) => capability.featureNames.map((name) => index.featureIdOf(name)).filter((id): id is number => id !== null)));
  const buckets: Bucket[] = [
    ...capabilities.map((capability) => ({ name: capability.name, features: capability.featureNames.flatMap((name) => { const id = index.featureIdOf(name); const feature = id === null ? undefined : featureById.get(id); return feature && leafFeatures.includes(feature) ? [feature] : []; }) })),
    { name: null, features: leafFeatures.filter((feature) => !grouped.has(feature.id)) },
  ].filter((bucket) => bucket.features.length > 1);

  // 2) 全局典型旅程：Radar 归组路径已带出；业务域路径（或归组失败）补一趟跨桶采样。
  if (headline.length === 0 && leafFeatures.length > 1) {
    const sample = buckets.flatMap((bucket) => evenlySample(bucket.features, HEADLINE_FEATURES_PER_BUCKET));
    const description = tagline ?? ledger.description;
    const mined = await mineJourneys({ client, language, description, capabilityName: null, maxJourneys: HEADLINE_MAX_JOURNEYS, candidates: happyCandidates(ledger, sample, 2) });
    headline = mined.journeys;
    miningCalls += mined.calls;
    passes += mined.calls;
  }

  const acceptor = createJourneyAcceptor(index, leafFeatures.length, maxJourneys);
  const accept = acceptor.accept;
  for (const journey of headline) accept(journey, "headline", null);

  // 3) 深挖（逐轮收敛）：第一轮每个桶内功能按 happy 场景数定序后切成连续窗口（每个功能只进一个窗口）；
  //    之后的轮次只送「仍未被任何旅程覆盖」的功能，直到挖掘预算用完、旅程数到上限、一轮下来没有新增，
  //    或已没有含两个以上未覆盖功能的桶。成本由 maxPasses（仅计挖掘调用）/ maxJourneys 封顶。
  const happyCount = new Map<number, number>();
  for (const scenario of ledger.scenarios) if (scenario.category === "happy") happyCount.set(scenario.featureId, (happyCount.get(scenario.featureId) ?? 0) + 1);
  let remaining = buckets.map((bucket) => ({ bucket, features: [...bucket.features].sort((a, b) => (happyCount.get(b.id) ?? 0) - (happyCount.get(a.id) ?? 0) || a.name.localeCompare(b.name)) }));
  for (let round = 0; round < MINING_ROUNDS && acceptor.accepted.length < maxJourneys && miningCalls < maxPasses; round += 1) {
    const windows: Array<{ bucket: Bucket; features: PresentationLedgerFeature[] }> = [];
    for (const { bucket, features } of remaining) {
      for (let start = 0; start < features.length; start += WINDOW_FEATURES) windows.push({ bucket, features: features.slice(start, start + WINDOW_FEATURES) });
      // 末窗只剩一个功能时并入前一窗（旅程至少要两个功能，单功能窗口挖不出东西）
      const last = windows.at(-1)!;
      if (windows.length > 1 && last.features.length === 1 && windows.at(-2)!.bucket === bucket) {
        windows.splice(windows.length - 1, 1);
        windows.at(-1)!.features.push(...last.features);
      }
    }
    const toRun = windows.filter((window) => window.features.length > 1).slice(0, maxPasses - miningCalls);
    if (toRun.length === 0) break;
    const results: Array<RawJourney[] | null> = new Array(toRun.length).fill(null);
    let cursor = 0;
    let calls = 0;
    // 并发只加速请求；结果的校验、去重与接纳严格按窗口顺序进行，产出顺序确定。
    const worker = async () => {
      while (cursor < toRun.length) {
        const passIndex = cursor++;
        const pass = toRun[passIndex];
        try {
          const mined = await mineJourneys({ client, language, description: tagline ?? ledger.description, capabilityName: pass.bucket.name, maxJourneys: JOURNEYS_PER_PASS, candidates: happyCandidates(ledger, pass.features, SCENARIOS_PER_FEATURE) });
          results[passIndex] = mined.journeys;
          calls += mined.calls;
        } catch (error) {
          console.error("[product-presentation] journey pass failed", { productId: ledger.productId, capability: pass.bucket.name, message: errorMessage(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PASS_CONCURRENCY, toRun.length) }, () => worker()));
    miningCalls += calls;
    passes += calls;
    // 严格按窗口顺序接纳（产出顺序确定，不随请求完成先后变化）。
    const before = acceptor.accepted.length;
    for (const [passIndex, result] of results.entries()) {
      if (acceptor.accepted.length >= maxJourneys) break;
      for (const journey of result ?? []) accept(journey, "capability", toRun[passIndex].bucket.name);
    }
    // 一轮下来没有新增就停：同样的输入再挖一轮也不会有新东西。
    if (acceptor.accepted.length === before) break;
    const covered = new Set(acceptor.accepted.flatMap((journey) => journey.steps.map((step) => index.featureOf.get(index.key(step.featureName, step.reference)))));
    remaining = remaining
      .map(({ bucket, features }) => ({ bucket, features: features.filter((feature) => !covered.has(feature.id)) }))
      .filter(({ features }) => features.length > 1);
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
export async function saveProductPresentation(execute: Execute, input: { productId: number; specVersionId: number | null; source: "generated" | "ai_snapshot_import"; fingerprint: string; payload: GeneratedPresentation; modelName?: string | null }) {
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
      JSON.stringify(input.payload.journeys.map((journey) => ({ name: journey.name, tier: journey.tier, capabilityName: journey.capabilityName, steps: journey.steps }))),
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
 * 执行一次生成并与上一版合并后落库。自身不抛错。
 * - 合并只增不减（见 mergePresentation）：重新生成不会让使用场景变少；规格变化后失效的旧旅程被剔除；
 * - 本次什么都没产出（能力与旅程都为空）视为失败，不落库——已有内容原样保留；
 * - 失败时保留旧内容、释放租约并安排重试：从未成功过的产品前 3 次 1 小时后重试、之后每天一次；已有内容的每天至多一次。
 */
export async function runPresentationGeneration(input: { ledger: PresentationLedger; specVersionId?: number | null; billing?: LlmBillingContext; client?: StructuredCompletionClient; execute?: Execute }): Promise<PresentationRefreshResult> {
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
    const next = await generateProductPresentation({ ledger: input.ledger, billing: input.billing, client: input.client });
    if (next.capabilities.length === 0 && next.journeys.length === 0) return await fail("NO_VALID_OUTPUT: the model produced no valid capability group or journey");
    const stored = payloadRows<{ capabilities_json: unknown; journeys_json: unknown; tagline: string | null }>(await execute(
      "SELECT capabilities_json, journeys_json, tagline FROM product_presentations WHERE product_id = ? LIMIT 1",
      [productId],
    ))[0];
    const previous = stored
      ? parsePresentationPayload({ status: "generated", capabilities: parseJsonValue(stored.capabilities_json), journeys: parseJsonValue(stored.journeys_json), coverage: undefined })
      : { capabilities: [], journeys: [] };
    const payload = mergePresentation({ previous: { ...previous, tagline: stored?.tagline ?? undefined }, next, ledger: input.ledger });
    await saveProductPresentation(execute, {
      productId,
      specVersionId: input.specVersionId === undefined ? input.ledger.specVersionId : input.specVersionId,
      source: "generated",
      fingerprint,
      payload,
      modelName: process.env.AI_MODEL ?? null,
    });
    const detail = { status: payload.status, capabilities: payload.capabilities.length, journeys: payload.journeys.length, keptFromPrevious: previous.journeys.length, freshlyGenerated: next.journeys.length, passes: payload.passes, coveredFeatures: payload.coverage.featuresInJourneys, featuresTotal: payload.coverage.featuresTotal };
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
  if (ledger.features.length === 0) return { outcome: "skipped", reason: "no_features" };
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
    const result = runPresentationGeneration({ ledger, specVersionId, billing: options.billing, client: options.client, execute });
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

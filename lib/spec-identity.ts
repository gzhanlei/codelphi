import { specFeatureKey } from "./spec-diff";

/**
 * 规格身份层（规格《客户端增量分析与 Delta Merge Contract 设计》§9.2、§20）：给一个版本里的功能和场景
 * 分配跨版本稳定的身份键。名称键是当版的键，改名就会变；身份键不会。
 *
 * 纯函数：不查库，不读时钟。每次发布的写入路径和回填脚本跑的是同一套规则，所以回填出来的身份和之后
 * 发布写出来的身份在同一条版本链上是连续的。
 *
 * 规则：
 * - 功能的身份键取它首次出现时的名称键。两个版本里名称键相同的功能是同一个身份。
 * - 场景的身份键由（所属功能身份，编号）确定，编号就是场景的 reference。
 * - 一个身份上一版就在，是沿用（continued）；只在登记表里有，是恢复（restored）；两处都没有，是新建（minted）。
 *   上一版有、这一版没有的身份退休。
 * - 拿不准就报错，不猜：同一版里两个条目落到同一个身份，或者上一版和登记表说法不一，都是错误。
 */

export type SpecIdentityErrorCode = "identity_input_invalid" | "identity_registry_conflict" | "identity_conflict";

/** 发布一个版本时算身份得到的全部东西：算出来的计划，和它依据的上一版身份与登记表。 */
export interface VersionIdentityContext {
  plan: VersionIdentityPlan;
  previous: VersionIdentities;
  registry: IdentityRegistry;
}

export class SpecIdentityError extends Error {
  constructor(public readonly code: SpecIdentityErrorCode, message: string) {
    super(message);
    this.name = "SpecIdentityError";
  }
}

export type IdentityOrigin = "continued" | "restored" | "minted";

/** 身份分配只看三样东西：功能的名称、父功能的名称键、它的场景编号。 */
export interface IdentityFeatureInput {
  name: string;
  parentKey?: string | null;
  references: readonly string[];
}

/**
 * 名称键 → 功能身份；功能身份 → （编号 → 场景身份）。
 * 上一版的身份和产品级的登记表是同一种形状，区别只在范围：登记表是这条版本链上出现过的全部身份。
 */
export interface IdentityMaps {
  features: ReadonlyMap<string, string>;
  scenarios: ReadonlyMap<string, ReadonlyMap<string, string>>;
}
export type VersionIdentities = IdentityMaps;
export type IdentityRegistry = IdentityMaps;

/** 规格对象里和身份有关的三个字段。发布时把最终的功能清单这样交进来。 */
export function identityInputOf(feature: { name: string; parentKey?: string | null; scenarios: ReadonlyArray<{ reference: string }> }): IdentityFeatureInput {
  return { name: feature.name, parentKey: feature.parentKey ?? null, references: feature.scenarios.map((scenario) => scenario.reference) };
}

export interface ScenarioIdentityPlan {
  identityKey: string;
  origin: IdentityOrigin;
}

export interface FeatureIdentityPlan {
  /** 本版的名称键。 */
  key: string;
  identityKey: string;
  origin: IdentityOrigin;
  /** 父功能的身份。顶层功能为 null。父名称键不在本版里时也是 null，这时 parentResolved 是 false。 */
  parentIdentityKey: string | null;
  parentResolved: boolean;
  /** 编号 → 场景身份。 */
  scenarios: ReadonlyMap<string, ScenarioIdentityPlan>;
}

export interface MintedFeatureIdentity {
  identityKey: string;
  /** 首次出现时的展示名，给人看的。 */
  firstName: string;
}

/** 场景身份的三部分：编码后的身份键，和它由之而来的功能身份与编号。 */
export interface ScenarioIdentityRef {
  identityKey: string;
  featureIdentityKey: string;
  reference: string;
}

export interface ScenarioIdentityAssignment extends ScenarioIdentityRef {
  origin: IdentityOrigin;
}

export interface VersionIdentityPlan {
  /** 名称键 → 功能身份计划，顺序与输入一致。 */
  features: ReadonlyMap<string, FeatureIdentityPlan>;
  /** 要写进登记表的新身份。 */
  minted: { features: readonly MintedFeatureIdentity[]; scenarios: readonly ScenarioIdentityRef[] };
  /** 上一版有、这一版没有的身份。功能退休时，它名下的场景身份一并退休。 */
  retired: { features: readonly string[]; scenarios: readonly ScenarioIdentityRef[] };
}

/**
 * 场景身份键的编码：功能身份和编号的 JSON 数组。直接拼接会在名称含分隔符时撞车，JSON 的转义没有这个问题。
 * 登记表里另外两列原样存这两个部分，所以按功能找场景时不必解析它。
 */
export function scenarioIdentityKey(featureIdentityKey: string, reference: string): string {
  return JSON.stringify([featureIdentityKey, reference]);
}

/** 可写的空映射。调用方可以往里填，再把它当作只读的上一版或登记表传进来。 */
export interface MutableIdentityMaps {
  features: Map<string, string>;
  scenarios: Map<string, Map<string, string>>;
}

export function emptyIdentityMaps(): MutableIdentityMaps {
  return { features: new Map(), scenarios: new Map() };
}

interface Resolved {
  identityKey: string;
  origin: IdentityOrigin;
}

/**
 * 一个名称在这版里的身份。上一版和登记表都认得它时两处必须说同一个身份；只有一处认得就用那一处的，
 * 归属看这个身份上一版在不在；两处都不认得，新建。
 */
function resolveIdentity(input: {
  label: string;
  key: string;
  previous: ReadonlyMap<string, string> | undefined;
  registry: ReadonlyMap<string, string> | undefined;
  inPrevious: (identityKey: string) => boolean;
  mint: () => string;
}): Resolved {
  const fromPrevious = input.previous?.get(input.key);
  const fromRegistry = input.registry?.get(input.key);
  if (fromPrevious !== undefined && fromRegistry !== undefined && fromRegistry !== fromPrevious) {
    throw new SpecIdentityError("identity_registry_conflict", `${input.label}：上一版的身份是 ${fromPrevious}，登记表里是 ${fromRegistry}`);
  }
  const identityKey = fromPrevious ?? fromRegistry;
  if (identityKey === undefined) return { identityKey: input.mint(), origin: "minted" };
  return { identityKey, origin: input.inPrevious(identityKey) ? "continued" : "restored" };
}

/** `label` 和登记在先的条目都带着「」，方便一眼看出是哪两个撞了。 */
function claimIdentity(label: string, identityKey: string, claimedBy: Map<string, string>): void {
  const other = claimedBy.get(identityKey);
  if (other !== undefined) throw new SpecIdentityError("identity_conflict", `${label}和${other}落到了同一个身份 ${identityKey}`);
  claimedBy.set(identityKey, label);
}

function planScenarios(
  references: readonly string[],
  featureKey: string,
  featureIdentityKey: string,
  input: { previous: VersionIdentities; registry: IdentityRegistry },
  minted: ScenarioIdentityRef[],
): Map<string, ScenarioIdentityPlan> {
  const previousByReference = input.previous.scenarios.get(featureIdentityKey);
  const previousIdentities = new Set(previousByReference?.values() ?? []);
  const registryByReference = input.registry.scenarios.get(featureIdentityKey);
  const scenarios = new Map<string, ScenarioIdentityPlan>();
  const claimedBy = new Map<string, string>();
  for (const reference of references) {
    if (scenarios.has(reference)) throw new SpecIdentityError("identity_input_invalid", `功能「${featureKey}」里编号 ${reference} 出现了两次`);
    const resolved = resolveIdentity({
      label: `功能「${featureKey}」的 ${reference}`,
      key: reference,
      previous: previousByReference,
      registry: registryByReference,
      inPrevious: (identityKey) => previousIdentities.has(identityKey),
      mint: () => scenarioIdentityKey(featureIdentityKey, reference),
    });
    claimIdentity(`功能「${featureKey}」的 ${reference}`, resolved.identityKey, claimedBy);
    scenarios.set(reference, resolved);
    if (resolved.origin === "minted") minted.push({ identityKey: resolved.identityKey, featureIdentityKey, reference });
  }
  return scenarios;
}

/** 父功能的名称键统一成名称键规则；空的父键按顶层算。 */
function parentNameKey(parentKey: string | null | undefined): string | null {
  const trimmed = parentKey?.trim() ?? "";
  return trimmed === "" ? null : specFeatureKey(trimmed);
}

function resolveParents(inputs: readonly IdentityFeatureInput[], plans: readonly FeatureIdentityPlan[], byKey: ReadonlyMap<string, FeatureIdentityPlan>): void {
  inputs.forEach((input, index) => {
    const parentKey = parentNameKey(input.parentKey);
    const parent = parentKey === null ? undefined : byKey.get(parentKey);
    plans[index].parentIdentityKey = parent?.identityKey ?? null;
    plans[index].parentResolved = parentKey === null || parent !== undefined;
  });
}

function retireAbsent(
  previous: VersionIdentities,
  presentFeatures: ReadonlySet<string>,
  presentScenarios: (featureIdentityKey: string) => Set<string>,
): VersionIdentityPlan["retired"] {
  const features: string[] = [];
  const scenarios: ScenarioIdentityRef[] = [];
  for (const [identityKey, previousScenarios] of previous.scenarios) {
    const kept = presentScenarios(identityKey);
    for (const [reference, scenarioIdentityKey] of previousScenarios) {
      if (!kept.has(scenarioIdentityKey)) scenarios.push({ identityKey: scenarioIdentityKey, featureIdentityKey: identityKey, reference });
    }
  }
  for (const identityKey of previous.features.values()) if (!presentFeatures.has(identityKey)) features.push(identityKey);
  return { features: features.sort(), scenarios: sortScenarioRefs(scenarios) };
}

/** 按码点序排，不依赖运行环境的地区设置。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortScenarioRefs(refs: readonly ScenarioIdentityRef[]): ScenarioIdentityRef[] {
  return [...refs].sort((a, b) => compareStrings(a.featureIdentityKey, b.featureIdentityKey) || compareStrings(a.reference, b.reference));
}

/**
 * 给一个版本的功能和场景分配身份。
 *
 * @param input.features 本版最终的功能清单，自动和人工条目都在内
 * @param input.previous 上一版的身份。首版传空映射
 * @param input.registry 产品级的身份登记表：这条版本链上出现过的全部身份
 */
export function planVersionIdentities(input: { features: readonly IdentityFeatureInput[]; previous: VersionIdentities; registry: IdentityRegistry }): VersionIdentityPlan {
  const previousFeatureIdentities = new Set(input.previous.features.values());
  const mintedFeatures: MintedFeatureIdentity[] = [];
  const mintedScenarios: ScenarioIdentityRef[] = [];
  const claimedBy = new Map<string, string>();
  const plans: FeatureIdentityPlan[] = [];
  const keys = new Set<string>();
  for (const candidate of input.features) {
    const key = specFeatureKey(candidate.name);
    if (keys.has(key)) throw new SpecIdentityError("identity_input_invalid", `一个版本里有两个功能的名称键相同：${key}`);
    keys.add(key);
    const resolved = resolveIdentity({
      label: `功能「${key}」`,
      key,
      previous: input.previous.features,
      registry: input.registry.features,
      inPrevious: (identityKey) => previousFeatureIdentities.has(identityKey),
      mint: () => key,
    });
    claimIdentity(`功能「${key}」`, resolved.identityKey, claimedBy);
    if (resolved.origin === "minted") mintedFeatures.push({ identityKey: resolved.identityKey, firstName: candidate.name.trim() });
    const scenarios = planScenarios(candidate.references, key, resolved.identityKey, input, mintedScenarios);
    plans.push({ key, identityKey: resolved.identityKey, origin: resolved.origin, parentIdentityKey: null, parentResolved: false, scenarios });
  }
  const byKey = new Map(plans.map((plan) => [plan.key, plan]));
  resolveParents(input.features, plans, byKey);
  const scenarioIdentities = new Map(plans.map((feature) => [feature.identityKey, new Set([...feature.scenarios.values()].map((scenario) => scenario.identityKey))]));
  return {
    features: byKey,
    minted: { features: mintedFeatures, scenarios: mintedScenarios },
    retired: retireAbsent(input.previous, new Set(claimedBy.keys()), (featureIdentityKey) => scenarioIdentities.get(featureIdentityKey) ?? new Set()),
  };
}

/** 本版的全部场景身份，先是功能顺序，再是编号顺序。 */
export function scenarioAssignments(plan: VersionIdentityPlan): ScenarioIdentityAssignment[] {
  return [...plan.features.values()].flatMap((feature) =>
    [...feature.scenarios].map(([reference, scenario]) => ({ featureIdentityKey: feature.identityKey, reference, identityKey: scenario.identityKey, origin: scenario.origin })),
  );
}

export function restoredFeatures(plan: VersionIdentityPlan): string[] {
  return [...plan.features.values()].filter((feature) => feature.origin === "restored").map((feature) => feature.identityKey).sort();
}

export function restoredScenarios(plan: VersionIdentityPlan): string[] {
  return scenarioAssignments(plan).filter((scenario) => scenario.origin === "restored").map((scenario) => scenario.identityKey).sort();
}

/** 几个候选里第一个不是 null 的；都是 null 就是 null。 */
function firstKnown(candidates: readonly (string | null)[]): string | null {
  return candidates.find((candidate) => candidate !== null) ?? null;
}

/** 上一版或登记表认得的名称键对应的功能身份；不认得就是 null。 */
function knownFeatureIdentity(maps: IdentityMaps, key: string): string | null {
  return maps.features.get(key) ?? null;
}

/** 上一版或登记表里，某个功能身份下某个编号的场景身份；没有就是 null。 */
function knownScenarioIdentity(maps: IdentityMaps, featureIdentityKey: string, reference: string): string | null {
  return maps.scenarios.get(featureIdentityKey)?.get(reference) ?? null;
}

/**
 * 一条变化记录的身份。以本版为准；本版没有的条目（被移除的）退到上一版，再退到登记表。
 * 三处都找不到就留空。这里不按名称现造一个身份：变化记录要的是那个条目当时的身份。
 */
export function resolveChangeIdentity(
  change: { featureKey: string; scenarioReference: string | null },
  plan: VersionIdentityPlan,
  previous: VersionIdentities,
  registry: IdentityRegistry,
): { featureIdentityKey: string | null; scenarioIdentityKey: string | null } {
  const key = specFeatureKey(change.featureKey);
  const inPlan = plan.features.get(key);
  const featureIdentityKey = firstKnown([inPlan?.identityKey ?? null, knownFeatureIdentity(previous, key), knownFeatureIdentity(registry, key)]);
  const reference = change.scenarioReference;
  if (reference === null || featureIdentityKey === null) return { featureIdentityKey, scenarioIdentityKey: null };
  return {
    featureIdentityKey,
    scenarioIdentityKey: firstKnown([
      inPlan?.scenarios.get(reference)?.identityKey ?? null,
      knownScenarioIdentity(previous, featureIdentityKey, reference),
      knownScenarioIdentity(registry, featureIdentityKey, reference),
    ]),
  };
}

/**
 * spec_changes 行上的写法：功能级记录的编号是空串，不是 null。这里把空串归一成“没有编号”，
 * 其余与 resolveChangeIdentity 相同。回填的报告和写入路径都用它，两边数出来的才是同一批行。
 */
export function changeRowIdentity(
  change: { featureKey: string; scenarioReference: string },
  plan: VersionIdentityPlan,
  previous: VersionIdentities,
  registry: IdentityRegistry,
): { featureIdentityKey: string | null; scenarioIdentityKey: string | null } {
  return resolveChangeIdentity({ featureKey: change.featureKey, scenarioReference: change.scenarioReference === "" ? null : change.scenarioReference }, plan, previous, registry);
}

/**
 * 下面几个是写入路径取“这一行接在哪两个身份值后面”的地方。抽出来是为了让拼 INSERT 的那几个函数
 * 不必各自带一串可选链：它们的圈复杂度本来就不低。
 */

/** 这份上下文里的计划。身份层关着时没有上下文，也就没有计划。 */
export function planOf(identity: VersionIdentityContext | null): VersionIdentityPlan | null {
  return identity?.plan ?? null;
}

/** 写一行 spec_features 时接在参数末尾的两个值：功能身份、父功能身份。 */
export function featureIdentityColumns(plan: VersionIdentityPlan | null, name: string): [string | null, string | null] {
  const feature = plan?.features.get(specFeatureKey(name)) ?? null;
  return [feature?.identityKey ?? null, feature?.parentIdentityKey ?? null];
}

/** 某个功能在这一版的身份键。工作台的 features 行只存这一个。 */
export function featureIdentityColumn(plan: VersionIdentityPlan | null, name: string): string | null {
  return plan?.features.get(specFeatureKey(name))?.identityKey ?? null;
}

/** 某个场景在这一版的身份键。写 spec_scenarios 行时接在参数末尾的就是它，工作台的 scenarios 行也只存这一个。 */
export function scenarioIdentityColumn(plan: VersionIdentityPlan | null, featureName: string, reference: string): string | null {
  return plan?.features.get(specFeatureKey(featureName))?.scenarios.get(reference)?.identityKey ?? null;
}

/** 写一行 spec_changes 时接在参数末尾的两个值：功能身份、场景身份。 */
export function changeIdentityColumns(
  identity: VersionIdentityContext | null,
  change: { featureName: string; scenarioReference: string | null },
): [string | null, string | null] {
  if (identity === null) return [null, null];
  const row = changeRowIdentity({ featureKey: change.featureName, scenarioReference: change.scenarioReference ?? "" }, identity.plan, identity.previous, identity.registry);
  return [row.featureIdentityKey, row.scenarioIdentityKey];
}

/** 下一版从这份身份出发。 */
export function toVersionIdentities(plan: VersionIdentityPlan): VersionIdentities {
  return {
    features: new Map([...plan.features].map(([key, feature]) => [key, feature.identityKey])),
    scenarios: new Map([...plan.features.values()].map((feature) => [feature.identityKey, new Map([...feature.scenarios].map(([reference, scenario]) => [reference, scenario.identityKey]))])),
  };
}

/** 把这一版新建的身份记进登记表。名称一旦指向某个身份就不再改，退休的身份也留着，将来同名出现时恢复。不改动传入的登记表。 */
export function foldRegistry(registry: IdentityRegistry, plan: VersionIdentityPlan): IdentityRegistry {
  const features = new Map(registry.features);
  const scenarios = new Map([...registry.scenarios].map(([featureIdentityKey, references]) => [featureIdentityKey, new Map(references)]));
  for (const feature of plan.minted.features) features.set(feature.identityKey, feature.identityKey);
  for (const scenario of plan.minted.scenarios) {
    const references = scenarios.get(scenario.featureIdentityKey) ?? new Map<string, string>();
    references.set(scenario.reference, scenario.identityKey);
    scenarios.set(scenario.featureIdentityKey, references);
  }
  return { features, scenarios };
}

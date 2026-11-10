import { evidenceKind } from "./evidence";
import type { Evidence } from "./types";

export interface SpecScenario {
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  evidence: Evidence[];
  source?: "generated" | "manual";
}

export interface SpecFeature {
  name: string;
  summary: string;
  parentKey?: string | null;
  scenarios: SpecScenario[];
  source?: "generated" | "manual";
}

export interface SpecChange {
  kind: "added" | "changed" | "removed";
  entityType: "feature" | "scenario";
  featureName: string;
  scenarioReference: string | null;
  summary: string;
  before: SpecFeature | SpecScenario | null;
  after: SpecFeature | SpecScenario | null;
}

/** 被等价判定折叠的差异：wording=行为等价但原文不同；renumber=同功能内场景换编号；tests-only=新增功能的证据全部来自测试/文档（行为性证据不足）。仅供审计展示，不落库。 */
export interface FoldedSpecChange {
  reason: "wording" | "renumber" | "tests-only";
  entityType: "feature" | "scenario";
  featureName: string;
  scenarioReference: string | null;
  before: SpecFeature | SpecScenario | null;
  after: SpecFeature | SpecScenario | null;
}

export function specFeatureKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 规格文本归一化：NFKC（全半角/标点宽度）+ 空白折叠。仅用于变化判定，不改写落库文本。 */
export function normalizeSpecText(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 比较用内容串：去掉空白与标点，只留承载语义的字符（比较用途，不影响落库）。 */
function specContent(text: string) {
  return normalizeSpecText(text).replace(/[\p{P}\p{S}\s]/gu, "");
}

function tokenSignature(text: string) {
  return [...text.toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => match[0]).sort().join(",");
}

function negationCount(text: string) {
  return (text.match(/[不无没未非莫勿]/g) ?? []).length;
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftChar] of [...left].entries()) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;
    for (const [rightIndex, rightChar] of [...right].entries()) {
      const above = previous[rightIndex + 1];
      previous[rightIndex + 1] = Math.min(above + 1, previous[rightIndex] + 1, diagonal + (leftChar === rightChar ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

/**
 * 规格文本等价判定：全量重建时 LLM 的措辞漂移（同义改写、标点/空白/全半角差异）不应被计为行为变化。
 * 保守设计（同 spec-rename 的 C-lite 哲学），三重守护，任一不过即视为行为变化：
 * 1. 数字与英文词 token 必须完全一致——「返回 404」≠「返回 400」、「邀请 A」≠「邀请 B」；
 * 2. 否定词（不/无/没/未/非…）计数必须一致——「可以重试」≠「不可以重试」；
 * 3. 长度归一化编辑距离：短文本（<10 字）阈值 0.85、其余 0.8——「返回列表」→「返回空列表」
 *    （0.8 < 0.85）不被折叠，而「…当前产品」→「…该产品」（0.83，12 字）被折叠。
 * 真实中文行为变化通常替换关键字符（成功→失败 0.5、允许→禁止 0.33），远低于阈值。
 */
export function specTextEquivalent(before: string, after: string) {
  const left = specContent(before);
  const right = specContent(after);
  if (left === right) return true;
  if (left === "" || right === "") return false;
  if (tokenSignature(left) !== tokenSignature(right)) return false;
  if (negationCount(left) !== negationCount(right)) return false;
  const distance = editDistance(left, right);
  const longest = Math.max(left.length, right.length);
  const similarity = 1 - distance / longest;
  return similarity >= (longest < 10 ? 0.85 : 0.8);
}

function featureBehaviorChanged(before: SpecFeature, after: SpecFeature) {
  // parentKey 必须 ?? null 归一化：AI 输出的树上字段缺失是 undefined，落库/回放树上是 null，
  // 严格 !== 会把 null !== undefined 判成身份变化——superset 盲评 12/13 误报即此一处比较。
  return before.name !== after.name
    || (before.parentKey ?? null) !== (after.parentKey ?? null)
    || !specTextEquivalent(before.summary, after.summary);
}

function scenarioBehaviorChanged(before: SpecScenario, after: SpecScenario) {
  return before.category !== after.category
    || !specTextEquivalent(before.context, after.context)
    || !specTextEquivalent(before.action, after.action)
    || !specTextEquivalent(before.outcome, after.outcome);
}

function scenarioMap(feature: SpecFeature) {
  return new Map(feature.scenarios.map((scenario) => [scenario.reference, scenario]));
}

function mergedSortedKeys(left: Map<string, unknown>, right: Map<string, unknown>) {
  return [...new Set([...left.keys(), ...right.keys()])].sort();
}

function changeSummary(kind: SpecChange["kind"], entityType: SpecChange["entityType"], featureName: string, reference: string | null) {
  const action = { added: "新增", changed: "更新", removed: "移除" }[kind];
  return entityType === "feature" ? `${action}功能「${featureName}」` : `「${featureName}」${action}场景 ${reference}`;
}

function featureChange(kind: "added" | "removed" | "changed", feature: SpecFeature, before: SpecFeature | null, after: SpecFeature | null): SpecChange {
  return { kind, entityType: "feature", featureName: feature.name, scenarioReference: null, summary: changeSummary(kind, "feature", feature.name, null), before, after };
}

export function scenarioBehaviorEqual(previous: SpecScenario, current: SpecScenario) {
  // BM-5（benchmark bm1-incremental-blind-eval §3 F3）：同一触发/操作/结果即同一行为，
  // category（happy/edge/error）是呈现标签——同文重复被标成不同 category（run 64：
  // SQL 编辑器 ER-1=error 与 EC-5=edge 逐字同文并存）不构成新场景，等价时保留先到者。
  return specTextEquivalent(previous.context, current.context)
    && specTextEquivalent(previous.action, current.action)
    && specTextEquivalent(previous.outcome, current.outcome);
}

function isScenarioShape(value: unknown): value is SpecScenario {
  return typeof value === "object" && value !== null
    && typeof (value as SpecScenario).context === "string"
    && typeof (value as SpecScenario).action === "string"
    && typeof (value as SpecScenario).outcome === "string";
}

function isFeatureShape(value: unknown): value is SpecFeature {
  return typeof value === "object" && value !== null
    && typeof (value as SpecFeature).name === "string"
    && typeof (value as SpecFeature).summary === "string";
}

/**
 * 落库行级的仅措辞判定（历史回填用，与 diffSpec 的分析时判定同口径）：
 * 对 spec_changes 的 before_json/after_json 主体按行为字段做等价判定。
 * added/removed 行没有对侧主体，恒为 false——换编号抖动的配对由回填脚本另行处理。
 */
export function specChangeWordingOnly(before: unknown, after: unknown) {
  if (!before || !after) return false;
  if (isScenarioShape(before) && isScenarioShape(after)) return scenarioBehaviorEqual(before, after);
  if (isFeatureShape(before) && isFeatureShape(after)) {
    if (before.name !== after.name || (before.parentKey ?? null) !== (after.parentKey ?? null)) return false;
    if (specTextEquivalent(before.summary, after.summary)) return true;
    // 身份未变且场景集（行为单元）等价时，整段摘要重写同样仅措辞——与运行时 diffFeature 折叠同口径。
    return featureScenarioSetChanges(before, after).length === 0;
  }
  return false;
}

interface DiffOutcome {
  changes: SpecChange[];
  folded: FoldedSpecChange[];
}

/** 折叠判定的可选上下文：本发布中确有行为性行变更的文件路径集（lib/patch-scan 产出）。 */
export interface DiffSpecOptions {
  behavioralChangePaths?: ReadonlySet<string>;
}

function scenarioChanges(before: SpecFeature, after: SpecFeature, outcome: DiffOutcome) {
  const beforeScenarios = scenarioMap(before);
  const afterScenarios = scenarioMap(after);
  const changes: SpecChange[] = [];

  for (const reference of mergedSortedKeys(beforeScenarios, afterScenarios)) {
    const previous = beforeScenarios.get(reference);
    const current = afterScenarios.get(reference);
    const kind = previous ? current ? "changed" : "removed" : "added";
    if (previous && current && !scenarioBehaviorChanged(previous, current)) {
      // 行为等价不落变化行；若原文确有差异，记入折叠明细供审计（完全相同的文本没有审计价值）。
      if (previous.context !== current.context || previous.action !== current.action || previous.outcome !== current.outcome) {
        outcome.folded.push({ reason: "wording", entityType: "scenario", featureName: after.name, scenarioReference: reference, before: previous, after: current });
      }
      continue;
    }
    changes.push({
      kind,
      entityType: "scenario",
      featureName: after.name,
      scenarioReference: reference,
      summary: changeSummary(kind, "scenario", after.name, reference),
      before: previous === undefined ? null : previous,
      after: current === undefined ? null : current,
    });
  }

  // 边界抖动折叠：同功能内 removed↔added 且行为字段逐项等价 → 同一行为换了编号，不产生变化行。
  const droppedIndexes = new Set<number>();
  for (const [removedIndex, removed] of changes.entries()) {
    if (removed.kind !== "removed") continue;
    for (const [addedIndex, added] of changes.entries()) {
      if (added.kind !== "added" || droppedIndexes.has(addedIndex)) continue;
      const previous = removed.before as SpecScenario;
      const current = added.after as SpecScenario;
      if (!scenarioBehaviorEqual(previous, current)) continue;
      droppedIndexes.add(removedIndex);
      droppedIndexes.add(addedIndex);
      outcome.folded.push({ reason: "renumber", entityType: "scenario", featureName: after.name, scenarioReference: current.reference, before: previous, after: current });
      break;
    }
  }
  for (const [index, change] of changes.entries()) if (!droppedIndexes.has(index)) outcome.changes.push(change);
}

/** 场景集（行为单元）差异：运行时折叠判定与历史回填共用同一口径。旧行 JSON 缺 scenarios 时按空集处理。 */
/**
 * 新增功能的证伪门禁：仅当功能**主张了实现证据、且每条主张都被证伪**时折叠——
 * 实现证据文件本次无行为性行变更（仅注释/空白）或不在本发布行为变更集内
 * （superset 盲评 #1009：实现文件仅 JSDoc 变动的覆盖补录型新增）。折叠供审计，
 * 不落行为变化。
 *
 * 无行为集、或功能未主张任何实现证据（全部场景只引测试/文档）时**不折叠**：
 * 随代码一起交付文档的真功能（盲评「查看者宽松模式」，证据全为文档但实现真实存在）
 * 会被误杀——无法证伪的主张保留可见，交人工核实，而不是静默吞掉。
 */
function featureEvidenceNonBehavioral(feature: SpecFeature, behavioral?: ReadonlySet<string>) {
  if (!behavioral) return false;
  if (feature.scenarios.length === 0) return false;
  const implementationPaths = feature.scenarios
    .flatMap((scenario) => scenario.evidence.filter((item) => evidenceKind(item.path) === "implementation").map((item) => item.path));
  if (implementationPaths.length === 0) return false;
  return implementationPaths.every((path) => !behavioral.has(path));
}

function featureScenarioSetChanges(before: SpecFeature, after: SpecFeature): SpecChange[] {
  const outcome: DiffOutcome = { changes: [], folded: [] };
  scenarioChanges(
    { ...before, scenarios: before.scenarios ?? [] },
    { ...after, scenarios: after.scenarios ?? [] },
    outcome,
  );
  return outcome.changes;
}

function diffFeature(previous: SpecFeature | undefined, current: SpecFeature | undefined, outcome: DiffOutcome, options?: DiffSpecOptions) {
  if (!previous && current) {
    if (featureEvidenceNonBehavioral(current, options?.behavioralChangePaths)) {
      outcome.folded.push({ reason: "tests-only", entityType: "feature", featureName: current.name, scenarioReference: null, before: null, after: current });
    } else {
      outcome.changes.push(featureChange("added", current, null, current));
    }
    return;
  }
  if (previous && !current) {
    outcome.changes.push(featureChange("removed", previous, previous, null));
    return;
  }
  if (!previous || !current) return;

  const scenarioOutcome: DiffOutcome = { changes: [], folded: [] };
  scenarioChanges(previous, current, scenarioOutcome);

  if (featureBehaviorChanged(previous, current)) {
    const identityChanged = previous.name !== current.name || (previous.parentKey ?? null) !== (current.parentKey ?? null);
    if (!identityChanged && scenarioOutcome.changes.length === 0) {
      // 行为单元（场景集）与身份均未变：摘要被整段重写只是同一行为面的表述漂移，不构成行为变化
      // （superset 第三方盲评 12/13 误报即此模式——token 签名完全不同的重写过不了 specTextEquivalent，
      // 但场景一个没动）。折叠供审计，落库文本仍采用新版。
      outcome.folded.push({ reason: "wording", entityType: "feature", featureName: current.name, scenarioReference: null, before: previous, after: current });
    } else {
      outcome.changes.push({ kind: "changed", entityType: "feature", featureName: current.name, scenarioReference: null, summary: changeSummary("changed", "feature", current.name, null), before: previous, after: current });
    }
  } else if (previous.summary !== current.summary) {
    outcome.folded.push({ reason: "wording", entityType: "feature", featureName: current.name, scenarioReference: null, before: previous, after: current });
  }
  outcome.changes.push(...scenarioOutcome.changes);
  outcome.folded.push(...scenarioOutcome.folded);
}

export function diffSpec(before: SpecFeature[] | null, after: SpecFeature[], options?: DiffSpecOptions): SpecChange[] {
  return diffSpecWithFolded(before, after, options).changes;
}

/** 与 diffSpec 同判定的折叠报告版：changes 之外同时返回被等价判定吞掉的差异明细。 */
export function diffSpecWithFolded(before: SpecFeature[] | null, after: SpecFeature[], options?: DiffSpecOptions): DiffOutcome {
  const outcome: DiffOutcome = { changes: [], folded: [] };
  if (!before) return outcome;
  const beforeFeatures = new Map(before.map((feature) => [specFeatureKey(feature.name), feature]));
  const afterFeatures = new Map(after.map((feature) => [specFeatureKey(feature.name), feature]));

  for (const key of mergedSortedKeys(beforeFeatures, afterFeatures)) diffFeature(beforeFeatures.get(key), afterFeatures.get(key), outcome, options);
  return outcome;
}

export interface SpecTombstones {
  featureKeys: ReadonlySet<string>;
  scenarioKeys: ReadonlySet<string>;
}

export function specScenarioKey(featureName: string, reference: string) {
  return `${specFeatureKey(featureName)}:${reference}`;
}

export function mergeSpecSources(generated: SpecFeature[], manual: SpecFeature[], tombstones: SpecTombstones = { featureKeys: new Set<string>(), scenarioKeys: new Set<string>() }, carried: SpecFeature[] = []) {
  const merged = new Map<string, SpecFeature>();
  for (const feature of carried) {
    const key = specFeatureKey(feature.name);
    if (tombstones.featureKeys.has(key)) continue;
    const scenarios = feature.scenarios.filter((scenario) => !tombstones.scenarioKeys.has(specScenarioKey(feature.name, scenario.reference)));
    merged.set(key, { ...feature, scenarios });
  }
  for (const feature of generated) {
    const key = specFeatureKey(feature.name);
    if (tombstones.featureKeys.has(key)) continue;
    const scenarios = feature.scenarios.filter((scenario) => !tombstones.scenarioKeys.has(specScenarioKey(feature.name, scenario.reference)));
    merged.set(key, { ...feature, scenarios });
  }
  for (const feature of manual) {
    const key = specFeatureKey(feature.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, feature);
      continue;
    }
    const scenarios = scenarioMap(existing);
    for (const scenario of feature.scenarios) scenarios.set(scenario.reference, scenario);
    const mergedFeature = feature.source === "generated" ? { ...feature, summary: existing.summary } : feature;
    merged.set(key, { ...mergedFeature, scenarios: [...scenarios.values()] });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

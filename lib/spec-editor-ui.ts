import type { FeatureTreeItem } from "./feature-tree";
import { pick, type LocaleEntry, type UiLocale } from "./ui-locale";
import { SPEC_EDITOR } from "./ui-strings/product";
import type { FeatureRow, ScenarioRow } from "./types";

function textOrEmpty(value?: string) {
  return value === undefined ? "" : value;
}

export function scenarioFormState(scenario?: ScenarioRow) {
  return {
    context: textOrEmpty(scenario?.context),
    action: textOrEmpty(scenario?.action),
    outcome: textOrEmpty(scenario?.outcome),
    category: scenario ? scenario.category : "happy" as const,
  };
}

export function scenarioFormTitle(scenario: ScenarioRow | undefined, locale: UiLocale = "zh-CN") {
  return scenario ? pick(locale, SPEC_EDITOR.scenarioEditTitle).replace("{reference}", scenario.reference) : pick(locale, SPEC_EDITOR.scenarioNewTitle);
}

export function featureFormState(feature?: FeatureRow) {
  return { name: textOrEmpty(feature?.name), summary: textOrEmpty(feature?.summary) };
}

export function featureFormTitle(feature: FeatureRow | undefined, parentId: number | null, locale: UiLocale = "zh-CN") {
  if (feature) return pick(locale, SPEC_EDITOR.featureEditTitle);
  return parentId === null ? pick(locale, SPEC_EDITOR.featureNewTopTitle) : pick(locale, SPEC_EDITOR.featureNewChildTitle);
}

export function editorSubmitLabel(pending: boolean, label: string, locale: UiLocale = "zh-CN") {
  return pending ? pick(locale, SPEC_EDITOR.saving) : label;
}

export function featureMatches(feature: FeatureTreeItem, query: string) {
  const normalized = query.trim().toLowerCase();
  return feature.name.toLowerCase().includes(normalized) || feature.children.some((child) => child.name.toLowerCase().includes(normalized));
}

export function scenariosForFeature(scenarios: ScenarioRow[], feature?: FeatureRow) {
  return feature ? scenarios.filter((scenario) => scenario.featureId === feature.id) : [];
}

/** 选中功能及其子功能的全部场景（实现分布聚合用；不影响场景 Tab 的计数口径）。 */
export function scenariosForFeatureTree(scenarios: ScenarioRow[], feature: FeatureRow | undefined, tree: FeatureTreeItem[]) {
  if (!feature) return [];
  const item = tree.find((node) => node.id === feature.id);
  const ids = new Set([feature.id, ...(item?.children ?? []).map((child) => child.id)]);
  return scenarios.filter((scenario) => ids.has(scenario.featureId));
}

export function selectedClass(selected: boolean) {
  return selected ? "selected" : "";
}

export function featureTabClass(mode: string, target: string) {
  return selectedClass(mode === target);
}

/** 规格工作台内指向某个功能的查询串，供功能树、详情页与保存后的跳转共用。 */
export function featureHref(featureId: number, mode?: string) {
  return mode ? `?view=spec&feature=${featureId}&mode=${mode}` : `?view=spec&feature=${featureId}`;
}

const scenarioCategoryEntries: Record<string, LocaleEntry> = {
  happy: SPEC_EDITOR.categoryHappy,
  edge: SPEC_EDITOR.categoryEdge,
  error: SPEC_EDITOR.categoryError,
};

export function scenarioCategoryLabel(category: string, locale: UiLocale = "zh-CN") {
  const entry = scenarioCategoryEntries[category];
  return entry ? pick(locale, entry) : undefined;
}

function editorParentId(editor: "root" | "child" | "edit" | null, feature?: FeatureRow) {
  if (editor === "edit") return feature ? feature.parentId : null;
  if (editor !== "child") return null;
  return feature ? feature.id : null;
}

export function featureEditorKey(editor: "root" | "child" | "edit" | null, feature: FeatureRow | undefined, parentId: number | null) {
  if (editor === "edit" && feature) return `${editor}:${feature.id}`;
  return `${editor}:new:${parentId === null ? "root" : parentId}`;
}

export function scenarioEditorKey(editing: ScenarioRow | "new" | null | undefined, featureId: number) {
  return editing && editing !== "new" ? `scenario:${editing.id}` : `new:${featureId}`;
}

export function featureNameLocked(feature?: FeatureRow) {
  return feature?.source === "generated";
}

export function canCreateChild(feature: FeatureRow) {
  return feature.parentId === null;
}

export function featureEditorProps(editor: "root" | "child" | "edit" | null, feature?: FeatureRow) {
  return { feature: editor === "edit" ? feature : undefined, parentId: editorParentId(editor, feature) };
}

export function entityId(entity?: { id: number }) {
  return entity?.id;
}

export function scenarioBeingEdited(editing: ScenarioRow | "new" | null | undefined) {
  return editing && editing !== "new" ? editing : undefined;
}

export function scenarioFilterLabel(category: ScenarioRow["category"] | undefined, locale: UiLocale = "zh-CN") {
  return category ? scenarioCategoryLabel(category, locale) : pick(locale, SPEC_EDITOR.filterAll);
}

export function scenarioFilterCount(scenarios: ScenarioRow[], category?: ScenarioRow["category"]) {
  return category ? scenarios.filter((scenario) => scenario.category === category).length : scenarios.length;
}

export function featureSourceLabel(source: "generated" | "manual", locale: UiLocale = "zh-CN") {
  return source === "manual" ? pick(locale, SPEC_EDITOR.sourceManual) : pick(locale, SPEC_EDITOR.sourceGenerated);
}

// P1 核实状态：由 verified_at × stale_since 推导（不存状态列，见 docs/spec-verification-lifecycle-design.md）。
export type VerificationState = "unverified" | "verified" | "stale-verified";

export const verificationLabels: Record<VerificationState, string> = { unverified: "未核实", verified: "已核实", "stale-verified": "待重新核实" };

const verificationEntries: Record<VerificationState, LocaleEntry> = {
  unverified: SPEC_EDITOR.verificationUnverified,
  verified: SPEC_EDITOR.verificationVerified,
  "stale-verified": SPEC_EDITOR.verificationStale,
};

/** 按 locale 取核实状态标签（缺省 zh-CN 与 verificationLabels 一致）。 */
export function verificationLabel(state: VerificationState, locale: UiLocale = "zh-CN") {
  return pick(locale, verificationEntries[state]);
}

export function verificationState(item: { verifiedAt?: Date | string | null; staleSince?: Date | string | null }): VerificationState {
  if (!item.verifiedAt) return "unverified";
  return item.staleSince ? "stale-verified" : "verified";
}

export function verificationMatches(item: { verifiedAt?: Date | string | null; staleSince?: Date | string | null }, filter: string) {
  return filter === "all" || verificationState(item) === filter;
}

/** 漂移横幅的跳转目标：优先第一个过时功能，否则第一个过时场景所在的功能（核实入口在其详情页）。 */
export function driftTargetFeatureId(features: FeatureRow[], scenarios: ScenarioRow[]) {
  return features.find((feature) => feature.staleSince)?.id ?? scenarios.find((scenario) => scenario.staleSince)?.featureId;
}

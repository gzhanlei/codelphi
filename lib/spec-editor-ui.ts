import type { FeatureTreeItem } from "./feature-tree";
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

export function scenarioFormTitle(scenario?: ScenarioRow) {
  return scenario ? `编辑场景 ${scenario.reference}` : "新建场景";
}

export function featureFormState(feature?: FeatureRow) {
  return { name: textOrEmpty(feature?.name), summary: textOrEmpty(feature?.summary) };
}

export function featureFormTitle(feature: FeatureRow | undefined, parentId: number | null) {
  if (feature) return "编辑功能";
  return parentId === null ? "新建顶级功能" : "新建子功能";
}

export function editorSubmitLabel(pending: boolean, label: string) {
  return pending ? "保存中…" : label;
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

const scenarioCategoryLabels: Record<string, string> = { happy: "正常路径", edge: "边界情况", error: "错误路径" };

export function scenarioCategoryLabel(category: string) {
  return scenarioCategoryLabels[category];
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

export function scenarioFilterLabel(category?: ScenarioRow["category"]) {
  return category ? scenarioCategoryLabel(category) : "全部";
}

export function scenarioFilterCount(scenarios: ScenarioRow[], category?: ScenarioRow["category"]) {
  return category ? scenarios.filter((scenario) => scenario.category === category).length : scenarios.length;
}

export function featureSourceLabel(source: "generated" | "manual") {
  return source === "manual" ? "人工维护" : "代码生成";
}

import { featureHref } from "./spec-editor-ui";
import type { FeatureRow, ScenarioRow } from "./types";

/**
 * Task 1：业务分组投影（纯函数，只读数据、不查库、不调 AI）。
 * 有「父节点 + 直接子级」功能树的产品把父级投影为业务卡片并聚合场景；
 * 没有任何父子分组的产品返回空数组，调用方回退现有平铺能力卡片。
 * 只认直接子级，不递归第三层；父级自身场景与子级场景各计一次。
 */

export interface BusinessDomainCard {
  id: number;
  /** 原始功能名（问答检索身份不变）。 */
  canonicalName: string;
  /** 首页显示名（displayName || name）。 */
  name: string;
  summary: string;
  source: string;
  scenarioCount: number;
  href: string;
}

export function buildBusinessDomainCards(features: FeatureRow[], scenarios: ScenarioRow[], productBase: string): BusinessDomainCard[] {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const childrenByParent = new Map<number, FeatureRow[]>();
  for (const feature of features) {
    if (feature.parentId !== null && byId.has(feature.parentId)) {
      const siblings = childrenByParent.get(feature.parentId) ?? [];
      siblings.push(feature);
      childrenByParent.set(feature.parentId, siblings);
    }
  }
  const scenarioCountByFeature = new Map<number, number>();
  for (const scenario of scenarios) {
    scenarioCountByFeature.set(scenario.featureId, (scenarioCountByFeature.get(scenario.featureId) ?? 0) + 1);
  }
  const cards: BusinessDomainCard[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const childCount = children.reduce((total, child) => total + (scenarioCountByFeature.get(child.id) ?? 0), 0);
    cards.push({
      id: parent.id,
      canonicalName: parent.name,
      name: parent.displayName || parent.name,
      summary: parent.summary,
      source: parent.source,
      scenarioCount: childCount + (scenarioCountByFeature.get(parent.id) ?? 0),
      href: `${productBase}${featureHref(parent.id)}`,
    });
  }
  return cards.sort((a, b) => (b.scenarioCount - a.scenarioCount) || a.canonicalName.localeCompare(b.canonicalName));
}

/**
 * 主动提示口径：push 分析新增的平铺功能不会自动归入业务域（upsert 从不写 parent_id）。
 * 「新」= created_at 晚于最晚业务父节点（分组建立之后出现的）；故意不分组的存量功能
 * 不误报。无分组、或父节点缺时间戳（无法判定）时返回 null——提示保持沉默。
 */
export function countNewUngroupedFeatures(features: FeatureRow[]): number | null {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const parentIds = new Set<number>();
  for (const feature of features) {
    if (feature.parentId !== null && byId.has(feature.parentId)) parentIds.add(feature.parentId);
  }
  if (parentIds.size === 0) return null;
  const parentCreatedAt = [...parentIds].map((id) => byId.get(id)!.createdAt).filter((value): value is Date | string => value !== undefined && value !== null);
  if (parentCreatedAt.length === 0) return null;
  const since = Math.max(...parentCreatedAt.map((value) => new Date(value).getTime()));
  if (!Number.isFinite(since)) return null;
  return features.filter((feature) => feature.parentId === null && !parentIds.has(feature.id) && feature.createdAt !== undefined && feature.createdAt !== null && new Date(feature.createdAt).getTime() > since).length;
}

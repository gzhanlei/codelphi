import type { FeatureRow, ScenarioRow } from "./types";

export interface FeatureTreeItem extends FeatureRow {
  children: FeatureRow[];
}

export function buildFeatureTree(features: FeatureRow[]): FeatureTreeItem[] {
  const ids = new Set(features.map((feature) => feature.id));
  return features
    .filter((feature) => feature.parentId === null || !ids.has(feature.parentId))
    .map((feature) => ({
      ...feature,
      children: features.filter((child) => child.parentId === feature.id).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function selectFeature(features: FeatureRow[], featureId?: number) {
  if (featureId) return features.find((feature) => feature.id === featureId);
  const root = features.find((feature) => feature.parentId === null);
  return root === undefined ? features[0] : root;
}

export function scenarioMatches(scenario: ScenarioRow, query: string, category: string) {
  if (category !== "all" && scenario.category !== category) return false;
  const text = `${scenario.context} ${scenario.action} ${scenario.outcome}`.toLowerCase();
  return text.includes(query.trim().toLowerCase());
}

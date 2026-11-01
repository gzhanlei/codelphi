import type { Evidence } from "./types";

export interface SpecScenario {
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  evidence: Evidence[];
}

export interface SpecFeature {
  name: string;
  summary: string;
  parentKey?: string | null;
  scenarios: SpecScenario[];
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

function featureKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function featureBehaviorChanged(before: SpecFeature, after: SpecFeature) {
  return before.name !== after.name || before.summary !== after.summary || before.parentKey !== after.parentKey;
}

function scenarioBehaviorChanged(before: SpecScenario, after: SpecScenario) {
  return before.context !== after.context || before.action !== after.action || before.outcome !== after.outcome || before.category !== after.category;
}

function scenarioMap(feature: SpecFeature) {
  return new Map(feature.scenarios.map((scenario) => [scenario.reference, scenario]));
}

function changeSummary(kind: SpecChange["kind"], entityType: SpecChange["entityType"], featureName: string, reference: string | null) {
  const action = { added: "新增", changed: "更新", removed: "移除" }[kind];
  return entityType === "feature" ? `${action}功能「${featureName}」` : `「${featureName}」${action}场景 ${reference}`;
}

function scenarioChanges(before: SpecFeature, after: SpecFeature): SpecChange[] {
  const beforeScenarios = scenarioMap(before);
  const afterScenarios = scenarioMap(after);
  const references = [...new Set([...beforeScenarios.keys(), ...afterScenarios.keys()])].sort();
  const changes: SpecChange[] = [];

  for (const reference of references) {
    const previous = beforeScenarios.get(reference);
    const current = afterScenarios.get(reference);
    const kind = previous ? current ? "changed" : "removed" : "added";
    if (previous && current && !scenarioBehaviorChanged(previous, current)) continue;
    changes.push({
      kind,
      entityType: "scenario",
      featureName: after.name,
      scenarioReference: reference,
      summary: changeSummary(kind, "scenario", after.name, reference),
      before: previous ?? null,
      after: current ?? null,
    });
  }
  return changes;
}

export function diffSpec(before: SpecFeature[] | null, after: SpecFeature[]): SpecChange[] {
  if (!before) return [];
  const beforeFeatures = new Map(before.map((feature) => [featureKey(feature.name), feature]));
  const afterFeatures = new Map(after.map((feature) => [featureKey(feature.name), feature]));
  const keys = [...new Set([...beforeFeatures.keys(), ...afterFeatures.keys()])].sort();
  const changes: SpecChange[] = [];

  for (const key of keys) {
    const previous = beforeFeatures.get(key);
    const current = afterFeatures.get(key);
    if (!previous || !current) {
      const feature = current ?? previous!;
      const kind = current ? "added" : "removed";
      changes.push({ kind, entityType: "feature", featureName: feature.name, scenarioReference: null, summary: changeSummary(kind, "feature", feature.name, null), before: previous ?? null, after: current ?? null });
      continue;
    }

    if (featureBehaviorChanged(previous, current)) {
      changes.push({ kind: "changed", entityType: "feature", featureName: current.name, scenarioReference: null, summary: changeSummary("changed", "feature", current.name, null), before: previous, after: current });
    }
    changes.push(...scenarioChanges(previous, current));
  }
  return changes;
}

export function mergeSpecSources(generated: SpecFeature[], manual: SpecFeature[]) {
  const merged = new Map(generated.map((feature) => [featureKey(feature.name), feature]));
  for (const feature of manual) {
    const key = featureKey(feature.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, feature);
      continue;
    }
    const scenarios = scenarioMap(existing);
    for (const scenario of feature.scenarios) scenarios.set(scenario.reference, scenario);
    merged.set(key, { ...feature, scenarios: [...scenarios.values()] });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

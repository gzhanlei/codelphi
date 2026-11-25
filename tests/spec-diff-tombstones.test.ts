import { describe, expect, it } from "vitest";
import { diffSpec, preserveUncertainDisappearances, specScenarioKey, type SpecChange, type SpecFeature, type SpecScenario } from "../lib/spec-diff";

const scenario = (reference: string) => ({ reference, context: "User", action: "Does", outcome: "Works", category: "happy" as const, evidence: [] });
const feature = (name: string, references: readonly string[]): SpecFeature => ({ name, summary: `Summary of ${name}`, scenarios: references.map(scenario) });
const none = () => ({ featureKeys: new Set<string>(), scenarioKeys: new Set<string>() });
const referencesOf = (features: readonly SpecFeature[]) => features.map((item) => `${item.name}:${item.scenarios.map((item) => item.reference).join(",")}`).sort();

/** 没有移除证据时，消失的条目都是“不确定”。 */
function uncertainChanges(previous: readonly SpecFeature[], current: readonly SpecFeature[]): SpecChange[] {
  return diffSpec([...previous], [...current]).filter((change) => change.kind === "uncertain");
}

describe("preserveUncertainDisappearances with tombstones", () => {
  const previous = [feature("A", ["HP-1", "HP-2"]), feature("B", ["HP-1"])];

  it("still restores what merely went missing when nothing is switched off", () => {
    expect(referencesOf(preserveUncertainDisappearances(previous, [], uncertainChanges(previous, []), none()))).toEqual(["A:HP-1,HP-2", "B:HP-1"]);
    expect(referencesOf(preserveUncertainDisappearances(previous, [], uncertainChanges(previous, [])))).toEqual(["A:HP-1,HP-2", "B:HP-1"]);
  });

  it("still pushes back a scenario that merely went missing into a feature that is still there", () => {
    const current = [feature("A", ["HP-1"])];
    const changes = uncertainChanges(previous, current);
    expect(changes.map((change) => change.entityType).sort()).toEqual(["feature", "scenario"]);

    expect(referencesOf(preserveUncertainDisappearances(previous, current, changes, none()))).toEqual(["A:HP-1,HP-2", "B:HP-1"]);
  });

  it("does not restore a feature a person switched off, even though its removal is uncertain", () => {
    const changes = uncertainChanges(previous, []);

    expect(referencesOf(preserveUncertainDisappearances(previous, [], changes, { featureKeys: new Set(["a"]), scenarioKeys: new Set<string>() }))).toEqual(["B:HP-1"]);
  });

  it("does not push a switched-off scenario back into a feature that is still there", () => {
    const current = [feature("A", ["HP-1"])];
    const changes = uncertainChanges(previous, current);

    expect(referencesOf(preserveUncertainDisappearances(previous, current, changes, { featureKeys: new Set<string>(), scenarioKeys: new Set([specScenarioKey("A", "HP-2")]) }))).toEqual(["A:HP-1", "B:HP-1"]);
  });

  it("restores a missing feature without the scenario that was switched off, whichever change comes first", () => {
    // 整个功能没了的时候 diff 只出功能级的变化，所以这里手工排一个场景级的变化在前面。
    const uncertain = (entityType: "feature" | "scenario", featureName: string, before: SpecFeature | SpecScenario): SpecChange => ({ kind: "uncertain", entityType, featureName, scenarioReference: null, summary: "", before, after: null });
    const tombstones = { featureKeys: new Set<string>(), scenarioKeys: new Set([specScenarioKey("A", "HP-2")]) };
    const changes: SpecChange[] = [uncertain("scenario", "A", scenario("HP-2")), uncertain("feature", "A", previous[0]), uncertain("feature", "B", previous[1])];

    expect(referencesOf(preserveUncertainDisappearances(previous, [], changes, tombstones))).toEqual(["A:HP-1", "B:HP-1"]);
    expect(referencesOf(preserveUncertainDisappearances(previous, [], [changes[1], changes[0], changes[2]], tombstones))).toEqual(["A:HP-1", "B:HP-1"]);
  });
});

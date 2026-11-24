import { describe, expect, it } from "vitest";
import { dedupeExactScenarioProjections, diffSpec, preserveExactScenarioIdentities, type SpecFeature } from "../lib/spec-diff";

function feature(name: string, outcome = "进入发布流程"): SpecFeature {
  return {
    name,
    summary: "发布能力",
    scenarios: [{
      reference: "HP-1",
      context: "用户打开发布页",
      action: "点击发布",
      outcome,
      category: "happy",
      evidence: [{ path: "components/publish.tsx", startLine: 10 }],
    }],
  };
}

const removalProof = {
  originalImplementationChecked: true,
  alternativePathsChecked: true,
  behaviorBoundaryVerified: true,
  evidence: [{ path: "components/publish.tsx", startLine: 10 }],
};

describe("behavior ledger golden validation", () => {
  it("classifies a genuinely new behavior as Added", () => {
    const changes = diffSpec([], [feature("发布入口")]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "added", entityType: "feature", featureName: "发布入口" });
  });

  it("keeps identity for a semantic modification instead of Removed plus Added", () => {
    const changes = diffSpec([feature("发布入口")], [feature("发布入口", "进入审核流程")]);
    expect(changes.map((change) => change.kind)).toEqual(["changed"]);
    expect(changes.some((change) => change.kind === "removed")).toBe(false);
  });

  it("removes only a scenario with complete positive evidence and preserves the behavior", () => {
    const before = feature("发布入口");
    before.scenarios.push({ ...before.scenarios[0], reference: "HP-2", context: "管理员打开发布页" });
    const after = { ...before, scenarios: [before.scenarios[1]] };
    const removedProofs = new Map([["发布入口:HP-1", removalProof]]);

    const changes = diffSpec([before], [after], { removedProofs });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "removed", entityType: "scenario", scenarioReference: "HP-1", judgment: "confirmed" });
    expect(after.scenarios[0].reference).toBe("HP-2");
  });

  it("keeps an unproven disappearance Uncertain", () => {
    const before = feature("发布入口");
    const after = { ...before, scenarios: [] };
    const changes = diffSpec([before], [after]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "uncertain", judgment: "uncertain", evidenceState: "not_observed" });
  });

  it("produces the same final ledger and zero delta on repeated runs", () => {
    const previous = [feature("旧发布名称")];
    const current = [feature("新发布名称")];
    const first = dedupeExactScenarioProjections(preserveExactScenarioIdentities(previous, current));
    const second = dedupeExactScenarioProjections(preserveExactScenarioIdentities(previous, current));

    expect(second).toEqual(first);
    expect(diffSpec(first, second)).toEqual([]);
    expect(first[0].name).toBe("旧发布名称");
  });

  it("does not activate a duplicated generated projection", () => {
    const current = [feature("发布入口"), feature("发布入口")];
    const final = dedupeExactScenarioProjections(current);
    expect(final).toHaveLength(1);
    expect(final[0].scenarios).toHaveLength(1);
  });
});

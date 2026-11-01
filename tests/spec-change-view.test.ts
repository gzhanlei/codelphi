import { describe, expect, it } from "vitest";
import type { BehaviorChangeRow } from "../lib/types";
import { changeEvidence, changeSubject, isScenarioSubject } from "../lib/spec-change-view";

const scenario = { reference: "HP-1", context: "User", action: "Signs in", outcome: "Dashboard", category: "happy", evidence: [{ path: "app/login.tsx" }] };
const change: BehaviorChangeRow = { id: 1, releaseId: 2, kind: "changed", entityType: "scenario", featureName: "Auth", scenarioReference: "HP-1", summary: "Changed", before: scenario, after: { ...scenario, outcome: "Onboarding" } };

describe("behavior change presentation", () => {
  it("uses the new subject for additions and the old subject for removals", () => {
    expect(changeSubject(change)).toMatchObject({ outcome: "Onboarding" });
    expect(changeSubject({ ...change, kind: "removed", after: null })).toEqual(scenario);
    expect(changeEvidence(change)).toEqual(scenario.evidence);
    expect(changeEvidence({ ...change, before: null, after: null })).toEqual([]);
    expect(changeEvidence({ ...change, after: { name: "Feature without evidence" } })).toEqual([]);
  });

  it("distinguishes scenarios from feature subjects", () => {
    expect(isScenarioSubject(scenario)).toBe(true);
    expect(isScenarioSubject({ name: "Authentication" })).toBe(false);
    expect(isScenarioSubject(null)).toBe(false);
  });
});

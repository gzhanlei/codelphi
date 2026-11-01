import { describe, expect, it } from "vitest";
import type { FeatureRow, ScenarioRow } from "../lib/types";
import { buildFeatureTree, scenarioMatches } from "../lib/feature-tree";

const root: FeatureRow = { id: 1, name: "Authentication", summary: "", parentId: null, source: "generated" };
const child: FeatureRow = { id: 2, name: "OAuth", summary: "", parentId: 1, source: "manual" };
const other: FeatureRow = { id: 3, name: "Billing", summary: "", parentId: null, source: "generated" };
const scenario: ScenarioRow = { id: 1, featureId: 1, reference: "HP-1", context: "Visitor", action: "Uses OAuth", outcome: "Dashboard", category: "happy", source: "generated", evidence: [] };

describe("feature tree and scenario filters", () => {
  it("groups children under their real parents", () => {
    const tree = buildFeatureTree([child, root, other]);
    expect(tree.map((feature) => feature.name)).toEqual(["Authentication", "Billing"]);
    expect(tree[0].children.map((feature) => feature.name)).toEqual(["OAuth"]);
  });

  it("keeps manually preserved features visible when their parent is no longer present", () => {
    const orphan: FeatureRow = { id: 9, name: "Manual child", summary: "", parentId: 999, source: "manual" };
    expect(buildFeatureTree([orphan]).map((feature) => feature.name)).toEqual(["Manual child"]);
  });

  it("filters by category and all three scenario fields", () => {
    expect(scenarioMatches(scenario, "oauth", "all")).toBe(true);
    expect(scenarioMatches(scenario, "visitor", "happy")).toBe(true);
    expect(scenarioMatches(scenario, "dashboard", "happy")).toBe(true);
    expect(scenarioMatches(scenario, "oauth", "error")).toBe(false);
    expect(scenarioMatches(scenario, "missing", "all")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { canAssignParent, featureInputSchema, nextScenarioReference, scenarioInputSchema, assertFeatureParent } from "../lib/spec-editor";

describe("spec editor rules", () => {
  it("allows only two levels and rejects self-parenting or deeper nesting", () => {
    const features = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: null }, { id: 5, parentId: 1 }];
    expect(canAssignParent(features, null, 1)).toBe(true);
    expect(canAssignParent(features, null, 2)).toBe(false);
    expect(canAssignParent(features, 1, 1)).toBe(false);
    expect(canAssignParent(features, 4, 4)).toBe(false);
    expect(canAssignParent(features, 2, 3)).toBe(false);
    expect(canAssignParent(features, 3, null)).toBe(true);
    expect(canAssignParent(features, 1, 4)).toBe(false);
    expect(canAssignParent(features, 2, 4)).toBe(false);
    expect(canAssignParent(features, 5, 4)).toBe(true);
    expect(canAssignParent(features, 4, 1)).toBe(true);
  });

  it("rejects invalid parents before any database write", () => {
    const features = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }];
    expect(() => assertFeatureParent(features, null, 2)).toThrow("父功能必须是顶级功能");
    expect(() => assertFeatureParent(features, null, 1)).not.toThrow();
  });

  it("allocates category-specific scenario references naturally", () => {
    expect(nextScenarioReference("happy", ["HP-1", "HP-2", "HP-10"])).toBe("HP-11");
    expect(nextScenarioReference("edge", ["EC-1", "EC-3"])).toBe("EC-4");
    expect(nextScenarioReference("error", [])).toBe("ER-1");
  });

  it("validates feature and scenario input at the boundary", () => {
    expect(featureInputSchema.parse({ name: "Authentication", summary: "OAuth", parentId: null }).name).toBe("Authentication");
    expect(() => featureInputSchema.parse({ name: "", summary: "Missing", parentId: null })).toThrow();
    expect(scenarioInputSchema.parse({ context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" }).category).toBe("happy");
    expect(() => scenarioInputSchema.parse({ context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "unknown" })).toThrow();
  });
});

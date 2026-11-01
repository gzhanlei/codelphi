import { describe, expect, it } from "vitest";
import { featureEndpoint, featureIdFromParam } from "../lib/spec-editor-client";
import { selectFeature } from "../lib/feature-tree";

describe("spec editor routing helpers", () => {
  it("builds feature endpoints without hardcoded product slugs", () => {
    expect(featureEndpoint("salesbuddy", undefined)).toBe("/api/products/salesbuddy/features");
    expect(featureEndpoint("salesbuddy", 7)).toBe("/api/features/7");
  });

  it("parses optional feature ids and selects real features", () => {
    expect(featureIdFromParam(undefined)).toBeUndefined();
    expect(featureIdFromParam("9")).toBe(9);
    expect(featureIdFromParam("1")).toBe(1);
    expect(featureIdFromParam("abc")).toBeUndefined();
    expect(featureIdFromParam("0")).toBeUndefined();
    expect(featureIdFromParam("-1")).toBeUndefined();
    expect(featureIdFromParam("1.5")).toBeUndefined();
    expect(featureIdFromParam("")).toBeUndefined();
    const features = [{ id: 1, name: "Root", summary: "", source: "generated" as const, parentId: null }, { id: 2, name: "Child", summary: "", source: "generated" as const, parentId: 1 }, { id: 3, name: "Other", summary: "", source: "generated" as const, parentId: null }];
    expect(selectFeature(features, 2)?.id).toBe(2);
    expect(selectFeature(features, undefined)?.id).toBe(1);
    expect(selectFeature(features, 99)).toBeUndefined();
    expect(selectFeature([features[1], { ...features[2], parentId: 1 }], undefined)?.id).toBe(2);
  });
});

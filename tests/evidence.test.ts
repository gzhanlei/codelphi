import { describe, expect, it } from "vitest";
import { evidenceItems, evidenceLabel } from "../lib/evidence";

describe("evidence parsing", () => {
  it("accepts database JSON values and serialized JSON", () => {
    const evidence = [{ path: "lib/spec.ts", startLine: 12 }];
    expect(evidenceItems(evidence)).toEqual(evidence);
    expect(evidenceItems(JSON.stringify(evidence))).toEqual(evidence);
  });

  it("fails closed for missing or malformed values", () => {
    expect(evidenceItems(undefined)).toEqual([]);
    expect(evidenceItems("not-json")).toEqual([]);
    expect(evidenceItems({ path: "not-an-array" })).toEqual([]);
  });

  it("formats source paths with optional line numbers", () => {
    expect(evidenceLabel({ path: "lib/spec.ts" })).toBe("lib/spec.ts");
    expect(evidenceLabel({ path: "lib/spec.ts", startLine: 12 })).toBe("lib/spec.ts:12");
  });
});

import { describe, expect, it } from "vitest";
import { mergeExclusions, summarizeExclusions } from "../lib/slice-planner/exclusions";
import type { SliceExclusion } from "../lib/slice-planner/types";

describe("exclusion records", () => {
  it("merges what every pass reports again and summarises by kind in a fixed order", () => {
    const merged = new Map<string, SliceExclusion>();
    mergeExclusions(merged, [
      { kind: "vendored", path: "jni/libopus", detail: "foreign_license" },
      { kind: "vendored", path: "b/x.c", detail: "jni/libopus" },
    ]);
    mergeExclusions(merged, [
      { kind: "vendored", path: "jni/libopus", detail: "foreign_license" },
      { kind: "tooling", path: "scripts/migrate.ts", detail: "scripts" },
      { kind: "generated", path: "api/user.pb.ts" },
    ]);
    mergeExclusions(merged, undefined);
    expect([...merged.values()]).toEqual([
      { kind: "vendored", path: "jni/libopus", detail: "foreign_license" },
      { kind: "vendored", path: "b/x.c", detail: "jni/libopus" },
      { kind: "tooling", path: "scripts/migrate.ts", detail: "scripts" },
      { kind: "generated", path: "api/user.pb.ts" },
    ]);
    expect(summarizeExclusions([...merged.values()])).toEqual([
      { kind: "vendored", count: 2, reasons: ["foreign_license", "jni/libopus"] },
      { kind: "tooling", count: 1, reasons: ["scripts"] },
      { kind: "generated", count: 1, reasons: [] },
    ]);
    expect(summarizeExclusions([])).toEqual([]);
  });
});

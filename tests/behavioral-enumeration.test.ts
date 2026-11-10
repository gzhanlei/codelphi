import { describe, expect, it } from "vitest";
import { behavioralChangePaths } from "../lib/patch-scan";
import { changeFileHunkRanges, groupBehavioralTargets, hunkReadRanges, parsePatchHunks } from "../lib/behavioral-enumeration";
import type { ChangeFile } from "../lib/code-hosting/types";

describe("parsePatchHunks", () => {
  it("parses new-file ranges from @@ headers", () => {
    const patch = [
      "diff --git a/superset/utils/json.py b/superset/utils/json.py",
      "index 111..222 100644",
      "--- a/superset/utils/json.py",
      "+++ b/superset/utils/json.py",
      "@@ -290,7 +290,9 @@ def _mask(value):",
      "+    if value in (None, ''):",
      "+        return value",
      "@@ -402,6 +404,10 @@ def other():",
      "+    return 1",
    ].join("\n");
    expect(parsePatchHunks(patch)).toEqual([
      { newStart: 290, newLines: 9 },
      { newStart: 404, newLines: 10 },
    ]);
  });

  it("defaults newLines to 1 and accepts pure-deletion hunks", () => {
    expect(parsePatchHunks("@@ -12 +12 @@\n+ x")).toEqual([{ newStart: 12, newLines: 1 }]);
    expect(parsePatchHunks("@@ -30,4 +30,0 @@\n- gone")).toEqual([{ newStart: 30, newLines: 0 }]);
    expect(parsePatchHunks("index 111..222\nbinary diff")).toEqual([]);
  });
});

describe("hunkReadRanges", () => {
  it("expands hunks by context and merges overlapping ranges", () => {
    const hunks = [
      { newStart: 100, newLines: 10 },
      { newStart: 115, newLines: 5 },
      { newStart: 400, newLines: 3 },
    ];
    expect(hunkReadRanges(hunks, 30)).toEqual([
      { startLine: 70, endLine: 149 },
      { startLine: 370, endLine: 432 },
    ]);
  });

  it("clips to the file line count and keeps insertion-point hunks readable", () => {
    expect(hunkReadRanges([{ newStart: 640, newLines: 2 }], 30, 637)).toEqual([{ startLine: 610, endLine: 637 }]);
    expect(hunkReadRanges([{ newStart: 50, newLines: 0 }], 30, 200)).toEqual([{ startLine: 20, endLine: 80 }]);
  });
});

describe("changeFileHunkRanges", () => {
  it("returns empty ranges for patch-less files", () => {
    const file = { path: "superset/utils/json.py", status: "modified", patch: "" } as ChangeFile;
    expect(changeFileHunkRanges(file, 30, 422)).toEqual([]);
  });
});

describe("behavioralChangePaths feeds the enumeration (L8/L12/L15 files qualify)", () => {
  it("marks implementation files with code changes as behavioral", () => {
    const files = [
      { path: "superset/utils/oauth2.py", status: "modified", patch: "@@ -408,7 +408,9 @@\n+        if is_guest:\n+            return None" },
      { path: "superset/utils/json.py", status: "modified", patch: "@@ -296,7 +296,9 @@\n+        if value is None:\n+            return value" },
      { path: "superset-embedded-sdk/src/guestTokenRefresh.test.ts", status: "modified", patch: "@@ -1,3 +1,5 @@\n+ it('refresh')" },
      { path: "docs/config.md", status: "modified", patch: "@@ -1,3 +1,5 @@\n+ note" },
    ] as ChangeFile[];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.has("superset/utils/oauth2.py")).toBe(true);
    expect(behavioral.has("superset/utils/json.py")).toBe(true);
    expect(behavioral.has("superset-embedded-sdk/src/guestTokenRefresh.test.ts")).toBe(false);
    expect(behavioral.has("docs/config.md")).toBe(false);
  });
});

describe("groupBehavioralTargets", () => {
  it("splits sorted unique paths into stable groups", () => {
    expect(groupBehavioralTargets(["b.ts", "a.ts", "b.ts", "c.ts"], 2)).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
    expect(groupBehavioralTargets([], 6)).toEqual([]);
    expect(groupBehavioralTargets(["a.ts"], 6)).toEqual([["a.ts"]]);
  });
});

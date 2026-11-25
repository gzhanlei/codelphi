import { describe, expect, it, vi } from "vitest";
import { allocateHunkReads, enumerateBehavioralChunks } from "../lib/behavioral-enumeration";
import { behavioralChangePaths } from "../lib/patch-scan";
import { changeFileHunkRanges, groupBehavioralTargets, hunkReadRanges, parsePatchHunks } from "../lib/behavioral-enumeration";
import type { ChangeFile } from "../lib/code-hosting/types";

const { analyzeBehavioralGroup } = vi.hoisted(() => ({ analyzeBehavioralGroup: vi.fn() }));
// 只替换出网通道：真实模块还要从 ../lib/ai 取 analysisSchema。
vi.mock("../lib/ai", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/ai")>(), analyzeBehavioralGroup }));

describe("enumerateBehavioralChunks 的证据允许集", () => {
  const files = [
    { path: "lib/auth.ts", status: "modified", patch: "@@ -1,2 +1,2 @@\n-old\n+new" },
    { path: "migrations/090_add_gift_wallet.sql", status: "added", patch: "+CREATE TABLE gift_wallets (id BIGINT PRIMARY KEY);" },
  ] as ChangeFile[];

  it("does not let a group keep a scenario that is only proven by a migration script the window changed", async () => {
    analyzeBehavioralGroup.mockResolvedValue({
      product: { description: "", evidence: [] },
      release: { title: "t", summary: "s" },
      changes: [],
      features: [{
        name: "统一登录",
        summary: "s",
        scenarios: [
          { reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
          { reference: "HP-2", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "migrations/090_add_gift_wallet.sql", startLine: 1 }] },
        ],
      }],
    });
    const readLines = vi.fn(async () => ({ startLine: 1, endLine: 1, lineCount: 1, lines: ["new"] }));

    const outcome = await enumerateBehavioralChunks({
      behavioralPaths: ["lib/auth.ts"],
      files,
      index: { readLines } as never,
      change: { message: "feat: gift wallet", files },
      knownFeatureNames: [],
      billing: { runId: 1, accountId: 1, chargeComponent: "main" },
    });

    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.chunks[0].result.features[0].scenarios.map((scenario) => scenario.reference)).toEqual(["HP-1"]);
  });
});

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

describe("allocateHunkReads (R3 hunk 公平预算)", () => {
  const range = (start: number, end: number) => ({ startLine: start, endLine: end });
  const lines = (r: { startLine: number; endLine: number }) => r.endLine - r.startLine + 1;

  it("guarantees the core of every hunk before spending leftover budget", () => {
    // 5 个 hunk 各需 200 行，总预算 400：旧顺序逻辑只喂前 2 个；公平分配每 hunk 保底 30
    const ranges = [range(1, 200), range(300, 499), range(600, 799), range(900, 1099), range(1200, 1399)];
    const allocated = allocateHunkReads(ranges, 400, 30);
    // 等需求 hunk 等比分摊：(400-150 保底) / 剩余需求均分 → 每 hunk 80 行，全部截断但核心保住
    expect(allocated.map((item) => lines(item.allocated))).toEqual([80, 80, 80, 80, 80]);
    expect(allocated.every((item) => lines(item.allocated) >= 30)).toBe(true);
    expect(allocated.every((item) => item.truncated)).toBe(true);
  });

  it("satisfies small hunks fully and leaves no truncation when budget is sufficient", () => {
    const ranges = [range(1, 20), range(50, 90)];
    const allocated = allocateHunkReads(ranges, 400, 30);
    expect(allocated.map((item) => item.truncated)).toEqual([false, false]);
    expect(allocated.map((item) => lines(item.allocated))).toEqual([20, 41]);
  });

  it("respects the total budget exactly and never over-allocates", () => {
    const ranges = Array.from({ length: 12 }, (_, index) => range(index * 100 + 1, index * 100 + 80));
    const allocated = allocateHunkReads(ranges, 400, 30);
    const total = allocated.reduce((sum, item) => sum + lines(item.allocated), 0);
    expect(total).toBeLessThanOrEqual(400);
    // 保底不低于 30（预算允许时）
    expect(allocated.every((item) => lines(item.allocated) >= 30)).toBe(true);
  });

  it("marks the single overflowing hunk truncated and keeps it within budget", () => {
    const allocated = allocateHunkReads([range(1, 1000)], 400, 30);
    expect(allocated[0].truncated).toBe(true);
    expect(lines(allocated[0].allocated)).toBe(400);
  });

  it("never produces a zero-grant range when the budget can still afford one line per hunk", () => {
    // 15 个 hunk × 61 行需求 > 400 预算：旧逻辑第 13 个之后耗尽预算，尾部 hunk 拿 0 行，
    // allocated.endLine < startLine 会让 readLines 抛 invalid_line_range，整文件被当不可读丢弃。
    const ranges = Array.from({ length: 15 }, (_, index) => range(index * 100 + 1, index * 100 + 61));
    const allocated = allocateHunkReads(ranges, 400, 30);
    const total = allocated.reduce((sum, item) => sum + lines(item.allocated), 0);
    expect(total).toBeLessThanOrEqual(400);
    expect(allocated.every((item) => item.allocated.endLine >= item.allocated.startLine)).toBe(true);
    // 预算保得住 1 行/hunk 时不得出现 0-grant
    expect(allocated.every((item) => lines(item.allocated) >= 1)).toBe(true);
    expect(allocated.every((item) => item.truncated)).toBe(true);
  });
});

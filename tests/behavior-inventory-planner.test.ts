import { describe, expect, it } from "vitest";
import { buildBehaviorInventory } from "../lib/behavior-inventory";
import { evaluateInventoryCoverage } from "../lib/behavior-inventory/coverage";
import { makeAnchorKey, makeUnitKey } from "../lib/behavior-inventory/identity";
import {
  BEHAVIOR_SOURCE_BUDGETS,
  loadBehaviorTaskSources,
  planBehaviorExecutionTasks,
} from "../lib/behavior-inventory/planner";
import { unionRanges } from "../lib/behavior-inventory/ranges";
import type {
  BehaviorAnchor,
  BehaviorAnchorRole,
  BehaviorUnit,
  CodeRange,
  LineRange,
} from "../lib/behavior-inventory/types";
import type { OpenedRemoteSourceRevision, SourceLineRequest } from "../lib/remote-source-index";

function anchor(path: string, role: BehaviorAnchorRole, ranges: LineRange[], coarse = false): BehaviorAnchor {
  return {
    anchorKey: makeAnchorKey({ role, path, ranges }),
    role,
    ranges,
    evidence: [{ path, startLine: ranges[0].startLine }],
    coarse,
  };
}

function unit(
  path: string,
  primaryRanges: LineRange[] | null,
  anchors: BehaviorAnchor[],
  contextRanges: CodeRange[] = [],
): BehaviorUnit {
  return {
    unitKey: makeUnitKey({ kind: "file", path }),
    kind: "file",
    primaryPath: path,
    primaryRanges,
    contextRanges,
    anchors,
    detector: "test",
    detectorVersion: "1",
  };
}

/** 每行恰好 size 个 ASCII 字符（= size 字节），区间字节数 = 行数*size + (行数-1)。 */
function paddedLines(count: number, size = 14): string[] {
  return Array.from({ length: count }, (_, index) => `l${String(index + 1).padStart(size - 1, "0")}`);
}

function contentOf(lines: string[]): string {
  return lines.join("\n");
}

function rangeBytes(content: string, range: LineRange): number {
  const lines = content.split("\n").slice(range.startLine - 1, range.endLine);
  return Buffer.byteLength(lines.join("\n"), "utf8");
}

function fixtureIndex(files: Map<string, string>) {
  const reads: SourceLineRequest[] = [];
  const index = {
    async readLines(request: SourceLineRequest) {
      reads.push(request);
      const all = (files.get(request.path) ?? "").split("\n");
      const endLine = Math.min(request.endLine, all.length);
      const selected = all.slice(request.startLine - 1, endLine);
      return {
        path: request.path,
        blobSha: `sha-${request.path}`,
        treeEntrySha: `sha-${request.path}`,
        startLine: request.startLine,
        endLine,
        lines: selected,
        byteSize: selected.join("\n").length,
        lineCount: all.length,
        verified: true as const,
        cacheState: "fetched" as const,
        readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "now" },
      };
    },
  } as unknown as OpenedRemoteSourceRevision;
  return { index, reads };
}

describe("behavior execution task planning", () => {
  it("exposes the frozen source budgets", () => {
    expect(BEHAVIOR_SOURCE_BUDGETS).toEqual({ primaryBytes: 96_000, contextBytes: 32_000, totalBytes: 128_000 });
  });

  it("groups whole anchors into one task when they fit the primary budget", () => {
    const content = contentOf(paddedLines(6));
    const path = "src/small.ts";
    const behavior = anchor(path, "behavior", [{ startLine: 1, endLine: 2 }]);
    const review = anchor(path, "implicit_review", [{ startLine: 3, endLine: 6 }], true);
    const small = unit(path, [{ startLine: 1, endLine: 6 }], [behavior, review]);
    const tasks = planBehaviorExecutionTasks({
      units: [small],
      sources: [{ path, content }],
      budgets: { primaryBytes: 100, contextBytes: 20, totalBytes: 120 },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].unitKey).toBe(small.unitKey);
    expect(tasks[0].taskKey).toMatch(/^task\|/);
    expect(tasks[0].anchorFragments.map((fragment) => fragment.anchorKey).sort()).toEqual(
      [behavior.anchorKey, review.anchorKey].sort(),
    );
    for (const fragment of tasks[0].anchorFragments) {
      expect(fragment.anchorFragmentKey).toMatch(/^fragment\|/);
    }
  });

  it("splits an over-budget anchor into deterministic fragments without changing unit or anchor keys", () => {
    const lines = paddedLines(10);
    const content = contentOf(lines);
    const path = "src/big.ts";
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 10 }], true);
    const big = unit(path, [{ startLine: 1, endLine: 10 }], [review]);
    const tasks = planBehaviorExecutionTasks({
      units: [big],
      sources: [{ path, content }],
      budgets: { primaryBytes: 60, contextBytes: 20, totalBytes: 80 },
    });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const fragments = tasks.flatMap((task) => task.anchorFragments);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    // 超预算只新增 taskKey/anchorFragmentKey：引用的仍是原 unitKey/anchorKey
    expect(new Set(tasks.map((task) => task.unitKey))).toEqual(new Set([big.unitKey]));
    expect(new Set(fragments.map((fragment) => fragment.anchorKey))).toEqual(new Set([review.anchorKey]));
    expect(new Set(fragments.map((fragment) => fragment.anchorFragmentKey)).size).toBe(fragments.length);
    for (const task of tasks) expect(task.taskKey.startsWith("task|")).toBe(true);
    for (const task of tasks) expect(task.taskKey).toContain("src/big.ts");
    // 分片并集恰好等于原锚点区间，且不截断、不超预算
    const union = unionRanges(
      fragments.flatMap((fragment) => fragment.ranges.map((range) => ({ path, ...range }))),
    );
    expect(union).toEqual([{ path, startLine: 1, endLine: 10 }]);
    for (const fragment of fragments) {
      for (const range of fragment.ranges) {
        expect(rangeBytes(content, range)).toBeLessThanOrEqual(60);
      }
    }
  });

  it("never lets a split fragment cross the gap between disjoint anchor ranges", () => {
    // 声明区间 [1,5] 与 [10,15] 不相交；间隙行 6-9 不属于锚点，其中第 7 行是超长行。
    // 若拆分跨间隙合并出 [1,15]，既吞入间隙行虚增预算，也会让第 7 行误判为无法安全拆分。
    const lines = paddedLines(15);
    lines[6] = "y".repeat(500);
    const content = contentOf(lines);
    const path = "src/disjoint.ts";
    const review = anchor(
      path,
      "implicit_review",
      [
        { startLine: 1, endLine: 5 },
        { startLine: 10, endLine: 15 },
      ],
      true,
    );
    const disjoint = unit(path, [{ startLine: 1, endLine: 15 }], [review]);
    const tasks = planBehaviorExecutionTasks({
      units: [disjoint],
      sources: [{ path, content }],
      budgets: { primaryBytes: 45, contextBytes: 20, totalBytes: 80 },
    });
    // 间隙中的超长行不得触发「无法安全拆分」：单元照常排产
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const fragments = tasks.flatMap((task) => task.anchorFragments);
    expect(fragments.length).toBeGreaterThanOrEqual(2);
    // 全部 fragment 的并集恰好等于原锚点区间，既不是超集 [1,15] 也不丢行
    const union = unionRanges(
      fragments.flatMap((fragment) => fragment.ranges.map((range) => ({ path, ...range }))),
    );
    expect(union).toEqual([
      { path, startLine: 1, endLine: 5 },
      { path, startLine: 10, endLine: 15 },
    ]);
    // 任一 fragment 区间不得覆盖间隙行 6-9；字节只按实际锚点行计算且不超过预算
    for (const fragment of fragments) {
      for (const range of fragment.ranges) {
        expect(range.endLine < 6 || range.startLine > 9).toBe(true);
        expect(rangeBytes(content, range)).toBeLessThanOrEqual(45);
      }
    }
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path, startLine: 1, endLine: 15 }],
      units: [disjoint],
      tasks,
    });
    expect(coverage.diagnostics.unresolvedUnits).toEqual([]);
    expect(coverage.diagnostics.fragmentedAnchors).toEqual([review.anchorKey]);
  });

  it("spreads fragments of a split anchor across tasks so no single task settles the whole anchor", () => {
    const content = contentOf(paddedLines(10));
    const path = "src/big.ts";
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 10 }], true);
    const big = unit(path, [{ startLine: 1, endLine: 10 }], [review]);
    const tasks = planBehaviorExecutionTasks({
      units: [big],
      sources: [{ path, content }],
      budgets: { primaryBytes: 60, contextBytes: 20, totalBytes: 80 },
    });
    const byTask = new Map<string, LineRange[]>();
    for (const task of tasks) {
      for (const fragment of task.anchorFragments) {
        byTask.set(task.taskKey, [...(byTask.get(task.taskKey) ?? []), ...fragment.ranges]);
      }
    }
    // 同一锚点的分片分布在多个任务中
    expect(byTask.size).toBeGreaterThanOrEqual(2);
    for (const ranges of byTask.values()) {
      const union = unionRanges(ranges.map((range) => ({ path, ...range })));
      // 任一单任务持有的分片都只是锚点真子集，不能独立核销完整锚点
      expect(union).not.toEqual([{ path, startLine: 1, endLine: 10 }]);
    }
    // 未被拆分的锚点只出现在一个任务里，不允许两个任务独立核销同一完整锚点
    const smallPath = "src/small.ts";
    const smallContent = contentOf(paddedLines(4));
    const smallAnchor = anchor(smallPath, "behavior", [{ startLine: 1, endLine: 4 }]);
    const small = unit(smallPath, [{ startLine: 1, endLine: 4 }], [smallAnchor]);
    const smallTasks = planBehaviorExecutionTasks({
      units: [small],
      sources: [{ path: smallPath, content: smallContent }],
      budgets: { primaryBytes: 60, contextBytes: 20, totalBytes: 80 },
    });
    const appearances = smallTasks.flatMap((task) =>
      task.anchorFragments.filter((fragment) => fragment.anchorKey === smallAnchor.anchorKey),
    );
    expect(appearances).toHaveLength(1);
    expect(appearances[0].ranges).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it("does not schedule entry anchors as review fragments", () => {
    const content = contentOf(paddedLines(30));
    const path = "src/routed.ts";
    const entry = anchor(path, "entry", [{ startLine: 1, endLine: 1 }]);
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 30 }], true);
    const routed = unit(path, [{ startLine: 1, endLine: 30 }], [entry, review]);
    const tasks = planBehaviorExecutionTasks({ units: [routed], sources: [{ path, content }] });
    expect(tasks).toHaveLength(1);
    const keys = tasks[0].anchorFragments.map((fragment) => fragment.anchorKey);
    expect(keys).toContain(review.anchorKey);
    expect(keys).not.toContain(entry.anchorKey);
  });

  it("returns no tasks for a unit that cannot be split safely instead of truncating content", () => {
    const lines = ["short", "y".repeat(500), "short"];
    const content = contentOf(lines);
    const path = "src/minified.ts";
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 3 }], true);
    const stuck = unit(path, [{ startLine: 1, endLine: 3 }], [review]);
    const tasks = planBehaviorExecutionTasks({
      units: [stuck],
      sources: [{ path, content }],
      budgets: { primaryBytes: 100, contextBytes: 20, totalBytes: 120 },
    });
    expect(tasks).toEqual([]);
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path, startLine: 1, endLine: 3 }],
      units: [stuck],
      tasks,
    });
    expect(coverage.diagnostics.unresolvedUnits).toEqual([stuck.unitKey]);
    expect(coverage.diagnostics.unreadableUnits).toEqual([]);
    // 锚点区间覆盖本身完整，未决来自执行规划而非清单结构
    expect(coverage.anchorCoverage.complete).toBe(true);
  });

  it("fails a unit whose minimal context exceeds the context budget", () => {
    const content = contentOf(paddedLines(10));
    const shared = contentOf(paddedLines(50));
    const path = "src/route.ts";
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 10 }], true);
    const dependent = unit(
      path,
      [{ startLine: 1, endLine: 10 }],
      [review],
      [{ path: "src/shared.ts", startLine: 1, endLine: 50 }],
    );
    const tasks = planBehaviorExecutionTasks({
      units: [dependent],
      sources: [
        { path, content },
        { path: "src/shared.ts", content: shared },
      ],
      budgets: { primaryBytes: 200, contextBytes: 100, totalBytes: 300 },
    });
    expect(tasks).toEqual([]);
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path, startLine: 1, endLine: 10 }],
      units: [dependent],
      tasks,
    });
    expect(coverage.diagnostics.unresolvedUnits).toEqual([dependent.unitKey]);
  });

  it("treats whole-file placeholder units with null primary ranges as unreadable", () => {
    const placeholder = unit("src/unreadable.ts", null, []);
    const tasks = planBehaviorExecutionTasks({ units: [placeholder], sources: [] });
    expect(tasks).toEqual([]);
    const coverage = evaluateInventoryCoverage({ eligibleRanges: [], units: [placeholder], tasks });
    expect(coverage.diagnostics.unreadableUnits).toEqual([placeholder.unitKey]);
    expect(coverage.primaryCoverage.complete).toBe(false);
    expect(coverage.anchorCoverage.complete).toBe(false);
  });

  it("produces identical task plans for identical inputs regardless of unit order", () => {
    const pathA = "src/a.ts";
    const pathB = "src/b.ts";
    const contentA = contentOf(paddedLines(10));
    const contentB = contentOf(paddedLines(4));
    const unitA = unit(pathA, [{ startLine: 1, endLine: 10 }], [
      anchor(pathA, "implicit_review", [{ startLine: 1, endLine: 10 }], true),
    ]);
    const unitB = unit(pathB, [{ startLine: 1, endLine: 4 }], [
      anchor(pathB, "behavior", [{ startLine: 1, endLine: 4 }]),
    ]);
    const sources = [
      { path: pathA, content: contentA },
      { path: pathB, content: contentB },
    ];
    const budgets = { primaryBytes: 60, contextBytes: 20, totalBytes: 80 };
    const first = planBehaviorExecutionTasks({ units: [unitA, unitB], sources, budgets });
    const second = planBehaviorExecutionTasks({ units: [unitA, unitB], sources, budgets });
    const shuffled = planBehaviorExecutionTasks({ units: [unitB, unitA], sources, budgets });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });
});

describe("behavior task source loading", () => {
  it("loads only declared context ranges for shared services instead of whole files per route", async () => {
    const sharedLines = paddedLines(100);
    const routeLinesA = paddedLines(30);
    const routeLinesB = paddedLines(30);
    const files = new Map([
      ["services/orders.ts", contentOf(sharedLines)],
      ["app/routes/a.ts", contentOf(routeLinesA)],
      ["app/routes/b.ts", contentOf(routeLinesB)],
    ]);
    const contextRange: CodeRange = { path: "services/orders.ts", startLine: 40, endLine: 55 };
    const unitA = unit(
      "app/routes/a.ts",
      [{ startLine: 1, endLine: 30 }],
      [anchor("app/routes/a.ts", "implicit_review", [{ startLine: 1, endLine: 30 }], true)],
      [contextRange],
    );
    const unitB = unit(
      "app/routes/b.ts",
      [{ startLine: 1, endLine: 30 }],
      [anchor("app/routes/b.ts", "implicit_review", [{ startLine: 1, endLine: 30 }], true)],
      [contextRange],
    );
    const sources = [...files.entries()].map(([path, content]) => ({ path, content }));
    const tasks = planBehaviorExecutionTasks({ units: [unitA, unitB], sources });
    expect(tasks).toHaveLength(2);

    const { index, reads } = fixtureIndex(files);
    const taskA = tasks.find((task) => task.unitKey === unitA.unitKey)!;
    const taskB = tasks.find((task) => task.unitKey === unitB.unitKey)!;
    const sourcesA = await loadBehaviorTaskSources(index, taskA, unitA);
    const sourcesB = await loadBehaviorTaskSources(index, taskB, unitB);

    // 共享服务只读取相关签名/调用区间：两个 route 各读一次 [40,55]，从不读取整份服务文件
    const sharedReads = reads.filter((read) => read.path === "services/orders.ts");
    expect(sharedReads).toHaveLength(2);
    for (const read of sharedReads) {
      expect(read.startLine).toBe(40);
      expect(read.endLine).toBe(55);
    }
    const contextA = sourcesA.filter((source) => source.role === "context");
    expect(contextA).toEqual([
      {
        path: "services/orders.ts",
        content: contentOf(sharedLines.slice(39, 55)),
        startLine: 40,
        endLine: 55,
        role: "context",
      },
    ]);
    const primaryA = sourcesA.filter((source) => source.role === "primary");
    expect(primaryA).toEqual([
      {
        path: "app/routes/a.ts",
        content: contentOf(routeLinesA),
        startLine: 1,
        endLine: 30,
        role: "primary",
      },
    ]);
    expect(sourcesB.filter((source) => source.role === "context")[0].content).toBe(contextA[0].content);
  });

  it("unions overlapping fragment ranges when loading primary sources", async () => {
    const lines = paddedLines(60);
    const content = contentOf(lines);
    const path = "src/overlap.ts";
    const behavior = anchor(path, "behavior", [{ startLine: 1, endLine: 30 }]);
    const review = anchor(path, "implicit_review", [{ startLine: 25, endLine: 60 }], true);
    const overlap = unit(path, [{ startLine: 1, endLine: 60 }], [behavior, review]);
    const tasks = planBehaviorExecutionTasks({ units: [overlap], sources: [{ path, content }] });
    expect(tasks).toHaveLength(1);

    const { index, reads } = fixtureIndex(new Map([[path, content]]));
    const sources = await loadBehaviorTaskSources(index, tasks[0], overlap);
    const primaryReads = reads.filter((read) => read.path === path);
    expect(primaryReads).toHaveLength(1);
    expect(primaryReads[0].startLine).toBe(1);
    expect(primaryReads[0].endLine).toBe(60);
    const primary = sources.filter((source) => source.role === "primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].content.split("\n")).toHaveLength(60);
    expect(primary[0].content).toBe(content);
  });

  it("chunks long range reads so the index page limit never truncates content", async () => {
    const lines = paddedLines(900);
    const content = contentOf(lines);
    const path = "src/long.ts";
    const review = anchor(path, "implicit_review", [{ startLine: 1, endLine: 900 }], true);
    const long = unit(path, [{ startLine: 1, endLine: 900 }], [review]);
    const tasks = planBehaviorExecutionTasks({ units: [long], sources: [{ path, content }] });
    expect(tasks).toHaveLength(1);

    const { index, reads } = fixtureIndex(new Map([[path, content]]));
    const sources = await loadBehaviorTaskSources(index, tasks[0], long);
    const primaryReads = reads.filter((read) => read.path === path);
    expect(primaryReads.map((read) => [read.startLine, read.endLine])).toEqual([
      [1, 400],
      [401, 800],
      [801, 900],
    ]);
    const primary = sources.filter((source) => source.role === "primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].content).toBe(content);
    expect(primary[0].startLine).toBe(1);
    expect(primary[0].endLine).toBe(900);
  });
});

describe("inventory coverage gates", () => {
  it("computes anchor coverage as the unique-line union of behavior and implicit_review ranges", () => {
    const content = contentOf(paddedLines(60));
    const path = "src/overlap.ts";
    const behavior = anchor(path, "behavior", [{ startLine: 1, endLine: 30 }]);
    const review = anchor(path, "implicit_review", [{ startLine: 25, endLine: 60 }], true);
    const overlap = unit(path, [{ startLine: 1, endLine: 60 }], [behavior, review]);
    const tasks = planBehaviorExecutionTasks({ units: [overlap], sources: [{ path, content }] });
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path, startLine: 1, endLine: 60 }],
      units: [overlap],
      tasks,
    });
    // 重叠 behavior 与 implicit_review 的并集恰好等于 primary，唯一行数不重复计数
    expect(coverage.anchorCoverage.uniqueLinesCovered).toBe(60);
    expect(coverage.anchorCoverage.omittedRanges).toEqual([]);
    expect(coverage.anchorCoverage.complete).toBe(true);
    expect(coverage.primaryCoverage.uniqueLinesCovered).toBe(60);
    expect(coverage.primaryCoverage.uniqueLinesOmitted).toBe(0);
    expect(coverage.primaryCoverage.complete).toBe(true);
    expect(coverage.diagnostics.unresolvedUnits).toEqual([]);
    expect(coverage.diagnostics.unreadableUnits).toEqual([]);
  });

  it("reports primary omissions and fragmented anchors in diagnostics", () => {
    const path = "src/partial.ts";
    const content = contentOf(paddedLines(60));
    const covered = anchor(path, "behavior", [{ startLine: 1, endLine: 30 }]);
    const partial = unit(path, [{ startLine: 1, endLine: 60 }], [covered]);
    const tasks = planBehaviorExecutionTasks({ units: [partial], sources: [{ path, content }] });
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path, startLine: 1, endLine: 60 }],
      units: [partial],
      tasks,
    });
    expect(coverage.anchorCoverage.omittedRanges).toEqual([{ path, startLine: 31, endLine: 60 }]);
    expect(coverage.anchorCoverage.uniqueLinesOmitted).toBe(30);
    expect(coverage.anchorCoverage.complete).toBe(false);
    expect(coverage.primaryCoverage.complete).toBe(true);
    expect(coverage.diagnostics.unresolvedUnits).toEqual([]);

    // 分片锚点进入诊断审计面
    const splitPath = "src/split.ts";
    const splitContent = contentOf(paddedLines(10));
    const splitAnchor = anchor(splitPath, "implicit_review", [{ startLine: 1, endLine: 10 }], true);
    const split = unit(splitPath, [{ startLine: 1, endLine: 10 }], [splitAnchor]);
    const splitTasks = planBehaviorExecutionTasks({
      units: [split],
      sources: [{ path: splitPath, content: splitContent }],
      budgets: { primaryBytes: 60, contextBytes: 20, totalBytes: 80 },
    });
    const splitCoverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path: splitPath, startLine: 1, endLine: 10 }],
      units: [split],
      tasks: splitTasks,
    });
    expect(splitCoverage.diagnostics.fragmentedAnchors).toEqual([splitAnchor.anchorKey]);
    expect(splitCoverage.diagnostics.unresolvedUnits).toEqual([]);
  });

  it("passes both gates over a real detector inventory with planned tasks", () => {
    const route = [
      "export async function GET(request: Request) {",
      '  const auth = request.headers.get("authorization");',
      '  if (!auth) return new Response("unauthorized", { status: 401 });',
      "  return Response.json({ ok: true });",
      "}",
    ].join("\n");
    const source = { path: "app/orders/route.ts", content: route };
    const inventory = buildBehaviorInventory({ afterSha: "test-sha", sources: [source] });
    expect(inventory.units).toHaveLength(1);
    const tasks = planBehaviorExecutionTasks({ units: inventory.units, sources: [source] });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const unit = inventory.units[0];
    const anchorKeys = new Set(unit.anchors.map((entry) => entry.anchorKey));
    for (const task of tasks) {
      expect(task.unitKey).toBe(unit.unitKey);
      for (const fragment of task.anchorFragments) {
        expect(anchorKeys.has(fragment.anchorKey)).toBe(true);
      }
    }
    const coverage = evaluateInventoryCoverage({
      eligibleRanges: [{ path: source.path, startLine: 1, endLine: 5 }],
      units: inventory.units,
      tasks,
    });
    expect(coverage.primaryCoverage.complete).toBe(true);
    expect(coverage.anchorCoverage.complete).toBe(true);
    expect(coverage.diagnostics.unresolvedUnits).toEqual([]);
    expect(coverage.diagnostics.unreadableUnits).toEqual([]);
  });
});

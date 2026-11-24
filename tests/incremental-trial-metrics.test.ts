import { describe, expect, it } from "vitest";
import type { ChangedFile, FileImpact, GlobalReason, WindowImpact } from "../lib/impact-classification";
import {
  aggregateWindows,
  anchorFates,
  fastPathStale,
  incrementalReadPaths,
  measureWindow,
  reanalysisLoad,
  simulateStale,
  tokenSavings,
  type Anchor,
  type BaselineIndex,
  type LineRanges,
} from "../lib/incremental-trial-metrics";

/** 造“变更前的路径 → 被替换的行区间”映射。 */
const lines = (entries: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]>): LineRanges => new Map(entries);

type ChangedFileOverride = Partial<Omit<ChangedFile, "status" | "oldPath">> & Pick<ChangedFile, "path"> & Partial<Pick<ChangedFile, "status" | "oldPath">>;

const anchor = (featureKey: string, path: string, startLine: number | null, endLine: number | null = startLine): Anchor => ({ featureKey, path, startLine, endLine });
const GLOBAL_REASON_BY_PATH: Record<string, GlobalReason> = { "package.json": "dependency_manifest", "package-lock.json": "dependency_manifest", "migrations/1.sql": "schema_migration" };

function baseline(features: Record<string, string[]>, anchors: Anchor[] = []): BaselineIndex {
  const featurePaths = new Map(Object.entries(features));
  const pathFeatures = new Map<string, string[]>();
  for (const [key, paths] of featurePaths) for (const path of paths) pathFeatures.set(path, [...(pathFeatures.get(path) ?? []), key]);
  return { featurePaths, pathFeatures, featureKeys: [...featurePaths.keys()], anchors };
}

/** 造一个窗口结论：每个文件同一档。`lib/a.ts` 在索引里，证明功能 a。 */
function impactOf(files: ChangedFileOverride[], outcome: WindowImpact["outcome"], required: string[] = []): WindowImpact {
  const entries = files.map((file) => {
    const base = { path: file.path, oldPath: file.oldPath ?? null, status: file.status ?? ("modified" as const) };
    if (outcome === "global_unbounded") return { ...base, classification: "global_unbounded", reason: GLOBAL_REASON_BY_PATH[file.path] ?? ("dependency_manifest" as const) };
    if (outcome === "direct") {
      // 与真实分类器一致：文档即使在 direct 窗口里也是 no_behavior，不在读取范围内。
      if (/\.md$/.test(file.path)) return { ...base, classification: "no_behavior", reason: "document" };
      return { ...base, classification: "direct", reason: "indexed_implementation", directFeatureKeys: file.path === "lib/a.ts" ? ["a"] : [] };
    }
    if (outcome === "no_behavior") return { ...base, classification: "no_behavior", reason: "document" };
    if (outcome === "unknown") return { ...base, classification: "unknown", reason: "binary_content" };
    return file.status === "renamed"
      ? { ...base, classification: "no_detected_behavior_change", reason: "pure_rename", reanchorsTo: file.oldPath ?? "" }
      : { ...base, classification: "no_detected_behavior_change", reason: "test_code" };
  }) as FileImpact[];
  const globalReasons = [...new Set(entries.flatMap((entry) => (entry.classification === "global_unbounded" ? [entry.reason] : [])))].sort();
  return { outcome, files: entries, globalReasons, directFeatureKeys: required, requiredFeatureKeys: required };
}

const fourEqualFiles = { fullBytes: 4000, fullFiles: 4, bytesOf: () => 1000 };

describe("增量读取范围与重分析占比", () => {
  const index = baseline({ a: ["lib/a.ts", "lib/shared-util.ts"], b: ["lib/b.ts"], c: ["lib/c.ts"] });

  it("reads the changed implementation files plus the evidence of the features it must re-analyze", () => {
    const impact = impactOf([{ path: "lib/a.ts" }, { path: "lib/new.ts", status: "added" }, { path: "README.md" }], "direct", ["a"]);
    expect(incrementalReadPaths(index, impact)).toEqual(["lib/a.ts", "lib/new.ts", "lib/shared-util.ts"]);
  });

  it("does not read a deleted file's content, and reads nothing on a fast path or a full resync", () => {
    expect(incrementalReadPaths(index, impactOf([{ path: "lib/b.ts", status: "deleted" }], "direct", ["b"]))).toEqual(["lib/b.ts"]);
    expect(incrementalReadPaths(index, impactOf([{ path: "README.md" }], "no_behavior"))).toEqual([]);
    expect(incrementalReadPaths(index, impactOf([{ path: "package.json" }], "global_unbounded"))).toEqual([]);
  });

  it("reports a zero share when the baseline has no automatic features", () => {
    expect(reanalysisLoad(baseline({}), impactOf([{ path: "lib/a.ts" }], "direct", ["a"]))).toMatchObject({ reanalyzedFeatures: 1, featureShare: 0 });
  });

  it("counts each unindexed implementation file as one new feature", () => {
    const impact = impactOf([{ path: "lib/a.ts" }, { path: "lib/new.ts", status: "added" }, { path: "lib/another.ts", status: "added" }], "direct", ["a"]);
    expect(reanalysisLoad(index, impact)).toEqual({ reanalyzedFeatures: 3, featureShare: 1, newImplementationFiles: 2 });
    expect(reanalysisLoad(index, impactOf([{ path: "README.md" }], "no_behavior"))).toEqual({ reanalyzedFeatures: 0, featureShare: 0, newImplementationFiles: 0 });
  });
});

describe("token 节省率", () => {
  it("follows the pre-registered rule for each outcome", () => {
    expect(tokenSavings("direct", 250, 1000)).toEqual({ savings: 1 - 250 / 1000, exceedsFull: false });
    expect(tokenSavings("direct", 1200, 1000)).toEqual({ savings: 0, exceedsFull: true });
    expect(tokenSavings("no_behavior", 0, 1000)).toEqual({ savings: 1, exceedsFull: false });
    expect(tokenSavings("no_detected_behavior_change", 0, 1000)).toEqual({ savings: 1, exceedsFull: false });
    expect(tokenSavings("global_unbounded", 1000, 1000)).toEqual({ savings: 0, exceedsFull: false });
    expect(tokenSavings("unknown", 1000, 1000)).toEqual({ savings: 0, exceedsFull: false });
  });

  it("does not divide by zero when the repository has no implementation bytes", () => {
    expect(tokenSavings("direct", 0, 0)).toEqual({ savings: 1, exceedsFull: false });
    expect(tokenSavings("direct", 50, 0)).toEqual({ savings: 0, exceedsFull: true });
    expect(tokenSavings("direct", 1, 0)).toEqual({ savings: 0, exceedsFull: true });
  });
});

describe("快速路径的 stale 锚点", () => {
  it("marks an evidence anchor stale only when a changed line of a non-implementation file lands on it", () => {
    const index = baseline({}, [
      anchor("a", "tests/a.test.ts", 10, 12),
      anchor("a", "tests/a.test.ts", 40),
      anchor("b", "README.md", null, null),
      anchor("c", "docs/guide.md", 5),
      anchor("d", "lib/d.ts", 3),
      anchor("e", "tests/e.test.ts", null, null),
      anchor("f", "tests/f.test.ts", 10, null),
    ]);
    const impact = impactOf(
      [{ path: "tests/a.test.ts" }, { path: "README.md" }, { path: "docs/guide.md" }, { path: "lib/d.ts" }, { path: "tests/f.test.ts" }],
      "no_detected_behavior_change",
    );
    const removedLines = lines([
      ["tests/a.test.ts", [[11, 11]]],
      ["README.md", [[1, 1]]],
      ["lib/d.ts", [[3, 3]]],
      ["tests/f.test.ts", [[10, 10]]],
    ]);
    // 逐个锚点断言去向。只比总数的话，一个多判和一个漏判会互相抵消，测试照样通过。
    expect(anchorFates(index, impact, removedLines)).toEqual([
      "stale", // tests/a.test.ts 10–12 行：被改的行落在锚点上
      "remapped", // tests/a.test.ts 第 40 行：文件变了，锚点没被碰到
      "stale", // README.md：文件变了，锚点没有行号
      "remapped", // docs/guide.md：文件变了，但没有行被替换
      "nonbehavioral", // lib/d.ts：实现文件上的锚点
      "untouched", // tests/e.test.ts：文件没变
      "stale", // tests/f.test.ts：文件变了，锚点只有起始行
    ]);
    expect(fastPathStale(index, impact, removedLines)).toEqual({ stale: 3, touched: 5, nonBehavioralTouched: 1 });
  });

  it("marks every anchor of a deleted file stale and re-anchors a pure rename instead", () => {
    const index = baseline({}, [anchor("a", "tests/old.test.ts", 3), anchor("b", "tests/gone.test.ts", 7)]);
    const deleted = impactOf([{ path: "tests/gone.test.ts", status: "deleted" }], "no_detected_behavior_change");
    expect(fastPathStale(index, deleted, lines([["tests/gone.test.ts", [[1, 20]]]]))).toEqual({ stale: 1, touched: 1, nonBehavioralTouched: 0 });
    const renamed = impactOf([{ path: "tests/new.test.ts", oldPath: "tests/old.test.ts", status: "renamed" }], "no_detected_behavior_change");
    expect(fastPathStale(index, renamed, new Map())).toEqual({ stale: 0, touched: 0, nonBehavioralTouched: 0 });
  });

  it("does not apply to windows that are not fast paths", () => {
    const index = baseline({}, [anchor("a", "tests/a.test.ts", 10)]);
    expect(fastPathStale(index, impactOf([{ path: "tests/a.test.ts" }], "direct", ["a"]), lines([["tests/a.test.ts", [[10, 10]]]]))).toEqual({
      stale: 0,
      touched: 0,
      nonBehavioralTouched: 0,
    });
  });
});

describe("窗口度量与汇总", () => {
  const index = baseline({ a: ["lib/a.ts"], b: ["lib/b.ts"], c: ["lib/c.ts"], d: ["lib/d.ts"] });

  it("measures one window end to end", () => {
    const metrics = measureWindow(index, impactOf([{ path: "lib/a.ts" }], "direct", ["a"]), new Map(), fourEqualFiles);
    expect(metrics).toMatchObject({
      outcome: "direct",
      incremental: true,
      reanalyzedFeatures: 1,
      featureShare: 0.25,
      incrementalFiles: 1,
      incrementalBytes: 1000,
      tokenSavings: 0.75,
      exceedsFull: false,
    });
  });

  it("aggregates the share, the means and the reason distribution over all windows", () => {
    const windows = [
      measureWindow(index, impactOf([{ path: "lib/a.ts" }], "direct", ["a"]), new Map(), fourEqualFiles),
      measureWindow(index, impactOf([{ path: "README.md" }], "no_behavior"), new Map(), fourEqualFiles),
      measureWindow(index, impactOf([{ path: "tests/x.test.ts" }], "no_detected_behavior_change"), new Map(), fourEqualFiles),
      measureWindow(index, impactOf([{ path: "package-lock.json" }], "global_unbounded"), new Map(), fourEqualFiles),
      measureWindow(index, impactOf([{ path: "migrations/1.sql" }], "global_unbounded"), new Map(), fourEqualFiles),
      measureWindow(index, impactOf([{ path: "assets/blob.bin" }], "unknown"), new Map(), fourEqualFiles),
    ];
    expect(aggregateWindows(windows)).toMatchObject({
      windows: 6,
      incrementalWindows: 3,
      incrementalShare: 0.5,
      meanTokenSavings: (0.75 + 1 + 1 + 0 + 0 + 0) / 6,
      meanFeatureShareOfDirectWindows: 0.25,
      outcomeCounts: { direct: 1, no_behavior: 1, no_detected_behavior_change: 1, global_unbounded: 2, unknown: 1 },
      globalReasonCounts: { dependency_manifest: 1, schema_migration: 1 },
      exceedsFullWindows: 0,
    });
  });

  it("keeps the result empty rather than dividing by zero", () => {
    expect(aggregateWindows([])).toMatchObject({ windows: 0, incrementalShare: null, meanTokenSavings: null, meanFeatureShareOfDirectWindows: null });
  });
});

describe("stale 连续模拟", () => {
  const initial = [anchor("a", "tests/a.test.ts", 10), anchor("b", "tests/b.test.ts", 10), anchor("c", "tests/c.test.ts", 10)];
  const step = (impact: WindowImpact, removedLines: LineRanges, nextAnchors: Anchor[] = initial) => ({ impact, removedLines, nextAnchors });

  it("lets stale anchors pile up across fast paths", () => {
    const first = step(impactOf([{ path: "tests/a.test.ts" }], "no_detected_behavior_change"), lines([["tests/a.test.ts", [[10, 10]]]]));
    const second = step(impactOf([{ path: "tests/b.test.ts" }], "no_detected_behavior_change"), lines([["tests/b.test.ts", [[10, 10]]]]));
    const points = simulateStale(initial, [first, second]);
    expect(points.map((point) => [point.newlyStale, point.stale, point.staleShare, point.anchors])).toEqual([
      [1, 1, 1 / 3, 3],
      [1, 2, 2 / 3, 3],
    ]);
    // 快速路径不恢复任何东西。
    expect(points.every((point) => point.recoveredByReanalysis === 0 && point.recoveredByFullResync === 0)).toBe(true);
  });

  it("recovers a feature's anchors when a later window re-analyzes that feature", () => {
    const first = step(impactOf([{ path: "tests/a.test.ts" }], "no_detected_behavior_change"), lines([["tests/a.test.ts", [[10, 10]]]]));
    const reanalysis = step(impactOf([{ path: "lib/a.ts" }], "direct", ["a"]), new Map(), [...initial, anchor("new", "lib/new.ts", 1)]);
    const points = simulateStale(initial, [first, reanalysis]);
    // 重分析窗口自己不产生 stale。
    expect(points[1]).toMatchObject({ newlyStale: 0, stale: 0, anchors: 4, recoveredByReanalysis: 1, recoveredByFullResync: 0 });
  });

  it("leaves another feature's stale anchor alone when only one feature is re-analyzed", () => {
    const first = step(impactOf([{ path: "tests/a.test.ts" }, { path: "tests/b.test.ts" }], "no_detected_behavior_change"), lines([["tests/a.test.ts", [[10, 10]]], ["tests/b.test.ts", [[10, 10]]]]));
    const partial = step(impactOf([{ path: "lib/a.ts" }], "direct", ["a"]), new Map());
    const points = simulateStale(initial, [first, partial]);
    expect(points[1]).toMatchObject({ stale: 1, anchors: 3, recoveredByReanalysis: 1, recoveredByFullResync: 0 });
  });

  it("clears everything on a full resync and takes the next version's anchors as they are", () => {
    const first = step(impactOf([{ path: "tests/a.test.ts" }], "no_detected_behavior_change"), lines([["tests/a.test.ts", [[10, 10]]]]));
    const full = step(impactOf([{ path: "package-lock.json" }], "global_unbounded"), new Map(), [anchor("a", "tests/a.test.ts", 12), anchor("z", "lib/z.ts", 4)]);
    const points = simulateStale(initial, [first, full]);
    expect(points[1]).toMatchObject({ stale: 0, anchors: 2, recoveredByReanalysis: 0, recoveredByFullResync: 1 });
  });

  it("reports an empty share instead of dividing by zero when no anchor is carried", () => {
    const full = step(impactOf([{ path: "package-lock.json" }], "global_unbounded"), lines([]), []);
    expect(simulateStale([], [full])).toEqual([
      { newlyStale: 0, stale: 0, anchors: 0, staleShare: 0, recoveredByReanalysis: 0, recoveredByFullResync: 0 },
    ]);
  });

  it("follows a pure rename and drops anchors of a feature that disappears", () => {
    const renamed = step(impactOf([{ path: "tests/renamed.test.ts", oldPath: "tests/a.test.ts", status: "renamed" }], "no_detected_behavior_change"), lines([]));
    const retired = step(
      impactOf([{ path: "lib/b.ts", status: "deleted" }], "direct", ["b"]),
      lines([]),
      [anchor("a", "tests/renamed.test.ts", 10), anchor("c", "tests/c.test.ts", 10)],
    );
    const points = simulateStale(initial, [renamed, retired]);
    expect(points[0]).toMatchObject({ anchors: 3, stale: 0, newlyStale: 0 });
    expect(points[1]).toMatchObject({ anchors: 2, stale: 0 });
  });
});

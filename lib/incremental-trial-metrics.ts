import { isImplementationSurfaceFile } from "./evidence";
import type { FileImpact, GlobalReason, WindowImpact, WindowOutcome } from "./impact-classification";

/**
 * 增量可用率试验的度量（规格 §19.4）。全部是纯函数：不读 Git，不查库。
 *
 * 口径在跑之前写进了规格，这里的每个函数对应其中一条：
 * - 窗口归宿由分类器给出，可增量窗口 = direct、no_behavior、no_detected_behavior_change；
 * - 重分析功能占比 = 必须重分析的基线自动功能数 / 基线自动功能总数，未命中索引的新实现文件各算一个；
 * - token 节省率按读取字节估：快速路径记 100%，全量窗口记 0%，增量超过全量时按全量计。
 */

export type LineRanges = ReadonlyMap<string, readonly (readonly [number, number])[]>;

/** 一条自动证据锚点。没有行号的锚点在文件被改动时记 stale。 */
export interface Anchor {
  featureKey: string;
  path: string;
  startLine: number | null;
  endLine: number | null;
}

/** 基线版本的索引：自动功能、每个功能的证据路径、每个路径证明哪些功能。 */
export interface BaselineIndex {
  featureKeys: readonly string[];
  featurePaths: ReadonlyMap<string, readonly string[]>;
  pathFeatures: ReadonlyMap<string, readonly string[]>;
  anchors: readonly Anchor[];
}

export interface SizeSource {
  fullBytes: number;
  fullFiles: number;
  bytesOf: (path: string) => number;
}

const FAST_PATH: ReadonlySet<WindowOutcome> = new Set(["no_behavior", "no_detected_behavior_change"]);
const INCREMENTAL: ReadonlySet<WindowOutcome> = new Set(["direct", "no_behavior", "no_detected_behavior_change"]);
const OUTCOMES: readonly WindowOutcome[] = ["direct", "no_behavior", "no_detected_behavior_change", "global_unbounded", "unknown"];

type AnalysisEntry = FileImpact & { classification: "direct" | "expanded_closed"; directFeatureKeys: readonly string[] };

function needsAnalysis(entry: FileImpact): entry is AnalysisEntry {
  return entry.classification === "direct" || entry.classification === "expanded_closed";
}

/**
 * 增量要读的源码：本次变更的实现文件（删除的除外），加上必须重分析的功能的证据文件。
 * 旧功能引用的迁移脚本不读：它已移出分析目标，读了也不能当证据。
 */
export function incrementalReadPaths(baseline: BaselineIndex, impact: WindowImpact): string[] {
  if (impact.outcome !== "direct") return [];
  const paths = new Set<string>();
  for (const entry of impact.files) if (needsAnalysis(entry) && entry.status !== "deleted") paths.add(entry.path);
  for (const key of impact.requiredFeatureKeys) for (const path of readableEvidence(baseline, key)) paths.add(path);
  return [...paths].sort();
}

function readableEvidence(baseline: BaselineIndex, featureKey: string): readonly string[] {
  return (baseline.featurePaths.get(featureKey) ?? []).filter((path) => isImplementationSurfaceFile(path));
}

export function reanalysisLoad(baseline: BaselineIndex, impact: WindowImpact): { reanalyzedFeatures: number; featureShare: number; newImplementationFiles: number } {
  if (impact.outcome !== "direct") return { reanalyzedFeatures: 0, featureShare: 0, newImplementationFiles: 0 };
  const newImplementationFiles = impact.files.filter((entry) => needsAnalysis(entry) && entry.directFeatureKeys.length === 0).length;
  const reanalyzedFeatures = impact.requiredFeatureKeys.length + newImplementationFiles;
  return { reanalyzedFeatures, featureShare: baseline.featureKeys.length === 0 ? 0 : reanalyzedFeatures / baseline.featureKeys.length, newImplementationFiles };
}

export function tokenSavings(outcome: WindowOutcome, incrementalBytes: number, fullBytes: number): { savings: number; exceedsFull: boolean } {
  if (FAST_PATH.has(outcome)) return { savings: 1, exceedsFull: false };
  if (outcome !== "direct") return { savings: 0, exceedsFull: false };
  if (fullBytes > incrementalBytes) return { savings: 1 - incrementalBytes / fullBytes, exceedsFull: false };
  return { savings: incrementalBytes === 0 ? 1 : 0, exceedsFull: incrementalBytes > 0 };
}

export type AnchorFate = "untouched" | "reanchored" | "remapped" | "nonbehavioral" | "stale";

/** 锚点所在文件在本窗口里的变更记录，按变更前的路径找。 */
function changeFor(path: string, impact: WindowImpact): FileImpact | undefined {
  return impact.files.find((entry) => (entry.status === "renamed" ? entry.oldPath : entry.path) === path);
}

/**
 * 锚点在一个快速路径窗口里的去向（§12.5）：不相交则重映射，相交或无行号则 stale。
 * 实现文件上的锚点不在此列：落在上面的注释或格式改动记 content_changed_nonbehavioral，证据状态保留。
 * 迁移脚本上的锚点是历史遗留，按文档锚点的规矩算：那个文件不在分析目标里，改了也不会触发重分析，
 * 被改的行落在锚点上，证据就已经对不上了。
 */
function fateOf(anchor: Anchor, entry: FileImpact | undefined, removedLines: LineRanges): AnchorFate {
  if (!entry) return "untouched";
  if (entry.reason === "pure_rename") return "reanchored";
  if (isImplementationSurfaceFile(anchor.path)) return "nonbehavioral";
  if (entry.status === "deleted") return "stale";
  const ranges = removedLines.get(anchor.path) ?? [];
  return ranges.length === 0 ? "remapped" : lineFate(anchor, ranges);
}

/** 有行被替换时：锚点落在被替换的行上，或者根本没有行号，就是 stale；否则只是行号要重映射。 */
function lineFate(anchor: Anchor, ranges: readonly (readonly [number, number])[]): AnchorFate {
  const { startLine, endLine } = anchor;
  if (startLine === null || endLine === null) return "stale";
  return ranges.some(([start, end]) => start <= endLine && end >= startLine) ? "stale" : "remapped";
}

export interface StaleCount {
  stale: number;
  /** 落在本窗口改动过的非实现文件上的锚点数，含 stale 的。已移出分析目标的迁移脚本也算非实现文件。 */
  touched: number;
  /** 落在本窗口改动过的实现文件上的锚点数。 */
  nonBehavioralTouched: number;
}

const NO_STALE: StaleCount = { stale: 0, touched: 0, nonBehavioralTouched: 0 };

/** 每个基线锚点在这个窗口里的去向，顺序与 `baseline.anchors` 一致。 */
export function anchorFates(baseline: BaselineIndex, impact: WindowImpact, removedLines: LineRanges): AnchorFate[] {
  return baseline.anchors.map((anchor) => fateOf(anchor, changeFor(anchor.path, impact), removedLines));
}

function countFates(fates: readonly AnchorFate[]): StaleCount {
  const count = { stale: 0, touched: 0, nonBehavioralTouched: 0 };
  for (const fate of fates) {
    if (fate === "stale") count.stale += 1;
    if (fate === "stale" || fate === "remapped") count.touched += 1;
    if (fate === "nonbehavioral") count.nonBehavioralTouched += 1;
  }
  return count;
}

/** 快速路径窗口的 stale 计数。不是快速路径的窗口全为零。 */
export function fastPathStale(baseline: BaselineIndex, impact: WindowImpact, removedLines: LineRanges): StaleCount {
  return FAST_PATH.has(impact.outcome) ? countFates(anchorFates(baseline, impact, removedLines)) : NO_STALE;
}

export interface WindowMetrics {
  outcome: WindowOutcome;
  globalReasons: readonly GlobalReason[];
  incremental: boolean;
  reanalyzedFeatures: number;
  featureShare: number;
  newImplementationFiles: number;
  incrementalFiles: number;
  incrementalBytes: number;
  fullFiles: number;
  fullBytes: number;
  tokenSavings: number;
  exceedsFull: boolean;
  fastPath: StaleCount;
}

export function measureWindow(baseline: BaselineIndex, impact: WindowImpact, removedLines: LineRanges, sizes: SizeSource): WindowMetrics {
  const readPaths = incrementalReadPaths(baseline, impact);
  const incrementalBytes = readPaths.reduce((sum, path) => sum + sizes.bytesOf(path), 0);
  const { savings, exceedsFull } = tokenSavings(impact.outcome, incrementalBytes, sizes.fullBytes);
  return {
    outcome: impact.outcome,
    globalReasons: impact.globalReasons,
    incremental: INCREMENTAL.has(impact.outcome),
    ...reanalysisLoad(baseline, impact),
    incrementalFiles: readPaths.length,
    incrementalBytes,
    fullFiles: sizes.fullFiles,
    fullBytes: sizes.fullBytes,
    tokenSavings: savings,
    exceedsFull,
    fastPath: fastPathStale(baseline, impact, removedLines),
  };
}

export interface TrialSummary {
  windows: number;
  incrementalWindows: number;
  incrementalShare: number | null;
  meanTokenSavings: number | null;
  meanFeatureShareOfDirectWindows: number | null;
  exceedsFullWindows: number;
  outcomeCounts: Record<WindowOutcome, number>;
  globalReasonCounts: Record<string, number>;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateWindows(windows: readonly WindowMetrics[]): TrialSummary {
  const outcomeCounts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<WindowOutcome, number>;
  const globalReasonCounts: Record<string, number> = {};
  for (const window of windows) {
    outcomeCounts[window.outcome] += 1;
    for (const reason of window.globalReasons) globalReasonCounts[reason] = (globalReasonCounts[reason] ?? 0) + 1;
  }
  const incrementalWindows = windows.filter((window) => window.incremental).length;
  return {
    windows: windows.length,
    incrementalWindows,
    incrementalShare: windows.length === 0 ? null : incrementalWindows / windows.length,
    meanTokenSavings: mean(windows.map((window) => window.tokenSavings)),
    meanFeatureShareOfDirectWindows: mean(windows.filter((window) => window.outcome === "direct").map((window) => window.featureShare)),
    exceedsFullWindows: windows.filter((window) => window.exceedsFull).length,
    outcomeCounts,
    globalReasonCounts,
  };
}

interface Carried {
  anchor: Anchor;
  stale: boolean;
}

export interface StaleStep {
  impact: WindowImpact;
  removedLines: LineRanges;
  /** 下一个版本真实的锚点，用来代表重分析或全量重同步之后的新证据。 */
  nextAnchors: readonly Anchor[];
}

export interface StalePoint {
  newlyStale: number;
  stale: number;
  anchors: number;
  staleShare: number;
  recoveredByReanalysis: number;
  recoveredByFullResync: number;
}

const fresh = (anchor: Anchor): Carried => ({ anchor, stale: false });
const staleCount = (carried: readonly Carried[]) => carried.filter((entry) => entry.stale).length;

function carryFastPath(carried: readonly Carried[], step: StaleStep): Carried[] {
  return carried.map((entry) => {
    const change = changeFor(entry.anchor.path, step.impact);
    // 纯重命名只换路径，锚点仍然有效。
    if (change?.reason === "pure_rename") return { anchor: { ...entry.anchor, path: change.path }, stale: entry.stale };
    const stale = fateOf(entry.anchor, change, step.removedLines) === "stale";
    return { anchor: entry.anchor, stale: entry.stale || stale };
  });
}

interface Advanced {
  carried: Carried[];
  recoveredByReanalysis: number;
  recoveredByFullResync: number;
}

/** 快速路径不刷新锚点，stale 会留到所属功能被重分析，或者下一次全量重同步。 */
function advance(carried: readonly Carried[], knownFeatures: ReadonlySet<string>, step: StaleStep): Advanced {
  const outcome = step.impact.outcome;
  if (outcome === "global_unbounded" || outcome === "unknown") {
    return { carried: step.nextAnchors.map(fresh), recoveredByReanalysis: 0, recoveredByFullResync: staleCount(carried) };
  }
  if (outcome === "direct") {
    const required = new Set(step.impact.requiredFeatureKeys);
    const nextFeatures = new Set(step.nextAnchors.map((anchor) => anchor.featureKey));
    const kept = carried.filter(({ anchor }) => !required.has(anchor.featureKey) && nextFeatures.has(anchor.featureKey));
    const refreshed = step.nextAnchors.filter((anchor) => required.has(anchor.featureKey) || !knownFeatures.has(anchor.featureKey)).map(fresh);
    return { carried: [...kept, ...refreshed], recoveredByReanalysis: staleCount(carried) - staleCount(kept), recoveredByFullResync: 0 };
  }
  return { carried: carryFastPath(carried, step), recoveredByReanalysis: 0, recoveredByFullResync: 0 };
}

export function simulateStale(initial: readonly Anchor[], steps: readonly StaleStep[]): StalePoint[] {
  let carried = initial.map(fresh);
  let knownFeatures: ReadonlySet<string> = new Set(initial.map((anchor) => anchor.featureKey));
  return steps.map((step) => {
    const before = staleCount(carried);
    const after = advance(carried, knownFeatures, step);
    carried = after.carried;
    knownFeatures = new Set(step.nextAnchors.map((anchor) => anchor.featureKey));
    const stale = staleCount(carried);
    const fastPath = FAST_PATH.has(step.impact.outcome);
    return {
      newlyStale: fastPath ? stale - before : 0,
      stale,
      anchors: carried.length,
      staleShare: carried.length === 0 ? 0 : stale / carried.length,
      recoveredByReanalysis: after.recoveredByReanalysis,
      recoveredByFullResync: after.recoveredByFullResync,
    };
  });
}

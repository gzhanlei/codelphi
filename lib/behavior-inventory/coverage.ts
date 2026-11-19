import { compareCodePoints } from "./identity";
import { rangeLineCount, subtractRanges } from "./ranges";
import type { BehaviorExecutionTask, BehaviorUnit, CodeRange } from "./types";

export interface CoverageInput {
  /** 实现面区间（与 buildBehaviorInventory 的 eligible 枚举同口径）。 */
  eligibleRanges: readonly CodeRange[];
  units: readonly BehaviorUnit[];
  tasks: readonly BehaviorExecutionTask[];
}

export interface RangeCoverage {
  coveredRanges: CodeRange[];
  omittedRanges: CodeRange[];
  uniqueLinesCovered: number;
  uniqueLinesOmitted: number;
  complete: boolean;
}

export interface InventoryCoverageDiagnostics {
  /** primaryRanges === null 的 whole-file 占位单元：成功读取前主覆盖门禁不得通过。 */
  unreadableUnits: string[];
  /** 存在未被任务 fragment 完整覆盖的 behavior/implicit_review 锚点（含无法安全拆分而未排产的单元）。 */
  unresolvedUnits: string[];
  /** 被拆成多个 fragment 的锚点：任一单任务不得独立核销，须全部分片完成后聚合。 */
  fragmentedAnchors: string[];
}

/** 双覆盖门禁：primary（实现面 vs 单元主覆盖）与 anchor（单元主区间 vs 审查锚点）分别计算，互不替代。 */
export interface InventoryCoverage {
  primaryCoverage: RangeCoverage;
  anchorCoverage: RangeCoverage;
  diagnostics: InventoryCoverageDiagnostics;
}

function coverageOf(
  base: readonly CodeRange[],
  covered: readonly CodeRange[],
  blocked: boolean,
): RangeCoverage {
  const omittedRanges = subtractRanges(base, covered);
  const coveredRanges = subtractRanges(base, omittedRanges);
  return {
    coveredRanges,
    omittedRanges,
    uniqueLinesCovered: rangeLineCount(coveredRanges),
    uniqueLinesOmitted: rangeLineCount(omittedRanges),
    complete: omittedRanges.length === 0 && !blocked,
  };
}

function reviewRangesOf(unit: BehaviorUnit, ranges: readonly { startLine: number; endLine: number }[]): CodeRange[] {
  return ranges.map((range) => ({ path: unit.primaryPath, startLine: range.startLine, endLine: range.endLine }));
}

export function evaluateInventoryCoverage(input: CoverageInput): InventoryCoverage {
  const unreadableUnits: string[] = [];
  const unitPrimary: CodeRange[] = [];
  const anchorRanges: CodeRange[] = [];
  for (const unit of input.units) {
    if (unit.primaryRanges == null) {
      unreadableUnits.push(unit.unitKey);
      continue;
    }
    unitPrimary.push(...reviewRangesOf(unit, unit.primaryRanges));
    for (const anchor of unit.anchors) {
      if (anchor.role === "entry") continue;
      anchorRanges.push(...reviewRangesOf(unit, anchor.ranges));
    }
  }
  const blocked = unreadableUnits.length > 0;
  const primaryCoverage = coverageOf(input.eligibleRanges, unitPrimary, blocked);
  const anchorCoverage = coverageOf(unitPrimary, anchorRanges, blocked);

  const tasksByUnit = new Map<string, BehaviorExecutionTask[]>();
  for (const task of input.tasks) {
    tasksByUnit.set(task.unitKey, [...(tasksByUnit.get(task.unitKey) ?? []), task]);
  }

  const unresolvedUnits: string[] = [];
  for (const unit of input.units) {
    if (unit.primaryRanges == null) continue;
    const reviewAnchors = unit.anchors.filter((anchor) => anchor.role !== "entry");
    const fragments = (tasksByUnit.get(unit.unitKey) ?? []).flatMap((task) => task.anchorFragments);
    const resolved =
      reviewAnchors.length > 0 &&
      reviewAnchors.every((anchor) => {
        const covered = fragments
          .filter((fragment) => fragment.anchorKey === anchor.anchorKey)
          .flatMap((fragment) => reviewRangesOf(unit, fragment.ranges));
        return subtractRanges(reviewRangesOf(unit, anchor.ranges), covered).length === 0;
      });
    if (!resolved) unresolvedUnits.push(unit.unitKey);
  }

  const fragmentCountByAnchor = new Map<string, number>();
  for (const task of input.tasks) {
    for (const fragment of task.anchorFragments) {
      fragmentCountByAnchor.set(fragment.anchorKey, (fragmentCountByAnchor.get(fragment.anchorKey) ?? 0) + 1);
    }
  }
  const fragmentedAnchors = [...fragmentCountByAnchor.entries()]
    .filter(([, count]) => count > 1)
    .map(([anchorKey]) => anchorKey);

  return {
    primaryCoverage,
    anchorCoverage,
    diagnostics: {
      unreadableUnits: unreadableUnits.sort(compareCodePoints),
      unresolvedUnits: unresolvedUnits.sort(compareCodePoints),
      fragmentedAnchors: fragmentedAnchors.sort(compareCodePoints),
    },
  };
}

/**
 * 规划器排除记录的合并和汇总。
 *
 * 多趟规划每一趟都会重新遇到同一个第三方目录，必选循环每一趟也会重新检查同一个改过的文件，
 * 所以先按「类别 + 路径 + 原因」合并去重，再给服务端日志和客户端的发布摘要各出一份。
 */
import type { SliceExclusion, SliceExclusionKind } from "./types";

export interface ExclusionGroup {
  kind: SliceExclusionKind;
  /** 排除了多少个路径。 */
  count: number;
  /** 成块排除时的目录或原因，去重后排序：第三方的那个目录、工具目录、保留下来的那份文件…… */
  reasons: string[];
}

export function mergeExclusions(into: Map<string, SliceExclusion>, additions: readonly SliceExclusion[] | undefined): void {
  for (const exclusion of additions ?? []) into.set(`${exclusion.kind}\u0000${exclusion.path}\u0000${exclusion.detail ?? ""}`, exclusion);
}

/** 顺序沿用给用户看时的固定顺序；没有排除的类别不出现。 */
export function summarizeExclusions(exclusions: readonly SliceExclusion[]): ExclusionGroup[] {
  const order: SliceExclusionKind[] = ["vendored", "tooling", "duplicate", "generated"];
  return order.map((kind) => {
    const ofKind = exclusions.filter((exclusion) => exclusion.kind === kind);
    return { kind, count: ofKind.length, reasons: [...new Set(ofKind.map((exclusion) => exclusion.detail).filter((detail): detail is string => detail !== undefined))].sort() };
  }).filter((group) => group.count > 0);
}

/**
 * 规划器排除记录的合并和汇总。
 *
 * 多趟规划每一趟都会重新遇到同一个第三方目录，必选循环每一趟也会重新检查同一个改过的文件，
 * 所以先按「类别 + 路径 + 原因」合并去重，再给服务端日志和客户端的发布摘要各出一份。
 */
import type { SliceExclusion, SliceExclusionKind } from "./types";

export interface ExclusionGroup {
  kind: SliceExclusionKind;
  /** 排除了多少：第三方副本按目录算，其余按文件算。 */
  count: number;
  /** 第三方目录、工具目录、保留下来的那份、生成工具……去重后排序。 */
  subjects: string[];
}

export function mergeExclusions(into: Map<string, SliceExclusion>, additions: readonly SliceExclusion[] | undefined): void {
  for (const exclusion of additions ?? []) into.set(`${exclusion.kind}\u0000${exclusion.path}\u0000${exclusion.detail ?? ""}`, exclusion);
}

/**
 * 按类别汇总。顺序固定；没有排除的类别不出现。
 * 第三方副本的记录有两种：遍历记的是目录本身（path 和 detail 都是目录），必选循环记的是落在目录里的文件（detail 是目录）。
 * 两种的 detail 都是目录，所以按 detail 去重就是目录清单。
 */
export function summarizeExclusions(exclusions: readonly SliceExclusion[]): ExclusionGroup[] {
  const order: SliceExclusionKind[] = ["vendored", "tooling", "duplicate", "generated"];
  return order.map((kind) => {
    const ofKind = exclusions.filter((exclusion) => exclusion.kind === kind);
    const subjects = [...new Set(ofKind.map((exclusion) => exclusion.detail).filter((detail): detail is string => detail !== undefined))].sort();
    return { kind, count: kind === "vendored" ? subjects.length : ofKind.length, subjects };
  }).filter((group) => group.count > 0);
}

import { compareCodePoints, normalizeCodeRanges } from "./identity";
import type { CodeRange } from "./types";

/**
 * 整数闭区间的精确区间运算。输入先经 normalizeCodeRanges 校验并按
 * (path, startLine, endLine) 排序去重，再在同一 path 内合并重叠或整数相邻区间。
 * Task 1 的 normalizeCodeRanges 只做校验/排序/去重，本文件负责并集语义。
 */

function mergeSortedRanges(sorted: readonly CodeRange[]): CodeRange[] {
  const merged: CodeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last != null && last.path === range.path && range.startLine <= last.endLine + 1) {
      if (range.endLine > last.endLine) last.endLine = range.endLine;
    } else {
      merged.push({ path: range.path, startLine: range.startLine, endLine: range.endLine });
    }
  }
  return merged;
}

/** 并集：同一 path 内合并重叠与整数相邻区间，不同 path 之间不合并。输出按 (path, startLine, endLine) 排序。 */
export function unionRanges(ranges: readonly CodeRange[]): CodeRange[] {
  return mergeSortedRanges(normalizeCodeRanges(ranges));
}

/** 差集：primary 减去 covered 的逐行剩余，按 (path, startLine, endLine) 稳定排序。 */
export function subtractRanges(
  primary: readonly CodeRange[],
  covered: readonly CodeRange[],
): CodeRange[] {
  const pieces = unionRanges(primary);
  const cover = unionRanges(covered);
  const residual: CodeRange[] = [];
  for (const piece of pieces) {
    let start = piece.startLine;
    for (const cut of cover) {
      if (cut.path !== piece.path) continue;
      if (cut.endLine < start) continue;
      if (cut.startLine > piece.endLine) break;
      if (cut.startLine > start) {
        residual.push({ path: piece.path, startLine: start, endLine: cut.startLine - 1 });
      }
      if (cut.endLine >= piece.endLine) {
        start = piece.endLine + 1;
        break;
      }
      start = cut.endLine + 1;
    }
    if (start <= piece.endLine) {
      residual.push({ path: piece.path, startLine: start, endLine: piece.endLine });
    }
  }
  residual.sort(
    (a, b) => compareCodePoints(a.path, b.path) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  return residual;
}

/** 精确行数：先求并集再逐段求和，禁止对输入长度直接求和推导覆盖。 */
export function rangeLineCount(ranges: readonly CodeRange[]): number {
  return unionRanges(ranges).reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

/** 子集校验：inner 的每一行都必须落在 outer 的并集之内，否则抛错。 */
export function assertRangesWithin(inner: readonly CodeRange[], outer: readonly CodeRange[]): void {
  const outside = subtractRanges(inner, outer);
  if (outside.length > 0) {
    const first = outside[0];
    throw new Error(
      `range not within outer set: ${first.path} [${first.startLine}, ${first.endLine}]`,
    );
  }
}

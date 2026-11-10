import type { ChangeFile } from "./code-hosting/types";

/**
 * W0-8 · 行为面枚举提取的纯函数层：把窗口 diff 的行为文件分解为「定向微任务」。
 *
 * W0-7 把 diff 文件装进了分区窗口，残余 3 条未中（L8/L12/L15）的文件已被读到仍未写进
 * 场景——自由阅读提取的注意力会偏向大而显著的行为，小而深的边缘行为（一个重试分支、
 * 一次权限同步推迟）被泛化吞掉。本模块把召回从「概率问题」变「枚举问题」：
 * patch-scan 给出行为文件清单，patch 的 @@ 头给出精确变更区间，逐文件定向提问，
 * 模型必须对每个显式回答（行为或无行为）。
 */

export interface PatchHunk {
  /** 新文件起始行（1-based）。 */
  newStart: number;
  /** 新文件覆盖行数（纯删除 hunk 为 0）。 */
  newLines: number;
}

/** 解析 unified diff 的 @@ 头（新文件行号区间）；无 hunk（二进制/空 patch）返回空数组。 */
export function parsePatchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    hunks.push({ newStart: Number(match[1]), newLines: match[2] === undefined ? 1 : Number(match[2]) });
  }
  return hunks;
}

export interface ReadRange {
  startLine: number;
  endLine: number;
}

/**
 * hunk 区间向外扩 contextLines、合并重叠/相邻区间，并裁剪到文件行数内。
 * 用于定向读取「变更区 ± 上下文」——证据行号直接取自这里读出的带行号内容。
 */
export function hunkReadRanges(hunks: PatchHunk[], contextLines: number, fileLineCount?: number): ReadRange[] {
  const expanded = hunks
    .map((hunk) => ({
      startLine: Math.max(1, hunk.newStart - contextLines),
      endLine: hunk.newLines === 0 ? hunk.newStart + contextLines : hunk.newStart + hunk.newLines - 1 + contextLines,
    }))
    .sort((a, b) => a.startLine - b.startLine);
  const merged: ReadRange[] = [];
  for (const range of expanded) {
    const last = merged[merged.length - 1];
    if (last && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine);
      continue;
    }
    merged.push({ ...range });
  }
  if (fileLineCount !== undefined) {
    for (const range of merged) range.endLine = Math.min(range.endLine, fileLineCount);
  }
  return merged.filter((range) => range.endLine >= range.startLine);
}

/** 从 ChangeFile 的 patch 解析 hunk 区间（无 patch 视为全文件，由调用方决定读取口径）。 */
export function changeFileHunkRanges(file: ChangeFile, contextLines: number, fileLineCount?: number): ReadRange[] {
  if (!file.patch) return [];
  return hunkReadRanges(parsePatchHunks(file.patch), contextLines, fileLineCount);
}

/**
 * 行为文件分组：路径序稳定分片，每组最多 groupSize 个文件（定向提取按组调用，
 * prompt 内逐文件显式提问）。空清单返回空分组。
 */
export function groupBehavioralTargets(paths: ReadonlyArray<string>, groupSize: number): string[][] {
  const sorted = [...new Set(paths)].sort();
  const groups: string[][] = [];
  for (let index = 0; index < sorted.length; index += groupSize) {
    groups.push(sorted.slice(index, index + groupSize));
  }
  return groups;
}

import type { ChangeFile } from "./code-hosting/types";
import type { OpenedRemoteSourceRevision } from "./remote-source-index";
import { analyzeBehavioralGroup, type LlmBillingContext } from "./ai";
import type { AnalysisResult } from "./ai";
import { sanitizeEvidence } from "./analysis";
import { behavioralEnumerationGroupSize, behavioralEnumerationMaxGroups } from "./env";
import type { ChangeContext } from "./ai";

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


export interface BehavioralEnumerationOptions {
  behavioralPaths: ReadonlyArray<string>;
  files: ReadonlyArray<ChangeFile>;
  index: OpenedRemoteSourceRevision;
  change: ChangeContext;
  knownFeatureNames: string[];
  billing: LlmBillingContext;
}

export interface BehavioralEnumerationChunk {
  result: AnalysisResult;
  label: string;
}

const CONTEXT_LINES = 30;
/** 单文件变更区上下文总行数帽（hunk 合并后防超大读取）。 */
const MAX_CONTEXT_LINES_PER_FILE = 400;
/** 单次读取的行数帽（与 index 预算对齐）。 */
const MAX_LINES_PER_READ = 400;

/**
 * W0-8 编排：行为文件逐组定向提问（每组 ≤ groupSize 个文件），硬失败重试一次后
 * 仍失败则跳过该组（定向枚举是增强层，分区提取已提供基线覆盖）。每组结果用
 * 「组文件 ∪ 全部 diff 文件」作证据允许集清洗后返回；清洗后为空的组不返回。
 */
export interface BehavioralEnumerationMetrics {
  /** patch-scan 行为文件总数。 */
  pathsTotal: number;
  /** 实际进入枚举组并被处理的文件数。 */
  pathsEnumerated: number;
  /** 未进入枚举的文件数（组数帽/组失败/不可读）。 */
  pathsOmitted: number;
  groupsTotal: number;
  groupsCompleted: number;
  groupsFailed: number;
  /** complete / partial / failed / not_applicable——增强层失败不得被误认为完整成功。 */
  status: "complete" | "partial" | "failed" | "not_applicable";
}

export interface BehavioralEnumerationOutcome {
  chunks: BehavioralEnumerationChunk[];
  metrics: BehavioralEnumerationMetrics;
}

export async function enumerateBehavioralChunks(options: BehavioralEnumerationOptions): Promise<BehavioralEnumerationOutcome> {
  const pathsTotal = new Set(options.behavioralPaths).size;
  if (pathsTotal === 0) {
    return { chunks: [], metrics: { pathsTotal: 0, pathsEnumerated: 0, pathsOmitted: 0, groupsTotal: 0, groupsCompleted: 0, groupsFailed: 0, status: "not_applicable" } };
  }
  const groups = groupBehavioralTargets(options.behavioralPaths, behavioralEnumerationGroupSize());
  const capped = groups.slice(0, behavioralEnumerationMaxGroups());
  const cappedGroups = groups.length - capped.length;
  if (cappedGroups > 0) {
    console.warn("[analysis] behavioral enumeration capped", { groups: groups.length, used: capped.length, omittedPaths: new Set(groups.slice(capped.length).flat()).size });
  }
  const chunks: BehavioralEnumerationChunk[] = [];
  let groupsCompleted = 0;
  let groupsFailed = 0;
  const pathsEnumerated = new Set<string>();
  for (const [groupIndex, group] of capped.entries()) {
    const label = `w0-8/g${groupIndex + 1}`;
    const targets: Array<{ path: string; patch: string; contextBlocks: Array<{ startLine: number; endLine: number; content: string }> }> = [];
    for (const path of group) {
      const file = options.files.find((candidate) => candidate.path === path);
      if (!file) continue;
      const blocks: Array<{ startLine: number; endLine: number; content: string }> = [];
      let budget = MAX_CONTEXT_LINES_PER_FILE;
      try {
        for (const range of changeFileHunkRanges(file, CONTEXT_LINES)) {
          const startLine = range.startLine;
          const endLine = Math.min(range.endLine, startLine + MAX_LINES_PER_READ - 1, startLine + budget - 1);
          if (endLine < startLine) continue;
          const read = await options.index.readLines({ path, startLine, endLine, requestedBy: "behavioral_enumeration", reason: "W0-8 targeted behavioral extraction" });
          blocks.push({ startLine: read.startLine, endLine: read.endLine, content: read.lines.map((line, offset) => `${read.startLine + offset}: ${line}`).join("\n") });
          budget -= read.endLine - read.startLine + 1;
          if (budget <= 0) break;
        }
      } catch (error) {
        // 文件在窗口内被删除或不可读：跳过该文件（patch 仍在组 prompt 里提供变更内容）
        console.warn("[analysis] behavioral target unreadable; skipped", { label, path, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
        continue;
      }
      targets.push({ path, patch: file.patch ?? "", contextBlocks: blocks });
    }
    if (targets.length === 0) continue;
    let chunk: AnalysisResult;
    try {
      chunk = await analyzeBehavioralGroup(targets, options.knownFeatureNames, options.change, options.billing);
    } catch (firstError) {
      console.warn("[analysis] behavioral enumeration group failed; retrying once", { label, error: firstError instanceof Error ? firstError.message.slice(0, 160) : String(firstError) });
      try {
        chunk = await analyzeBehavioralGroup(targets, options.knownFeatureNames, options.change, options.billing);
      } catch (secondError) {
        console.warn("[analysis] behavioral enumeration group skipped after retry", { label, error: secondError instanceof Error ? secondError.message.slice(0, 160) : String(secondError) });
        continue;
      }
    }
    const allowSet = new Set([...group, ...options.files.map((file) => file.path)]);
    sanitizeEvidence(chunk, allowSet, label);
    groupsCompleted += 1;
    for (const target of targets) pathsEnumerated.add(target.path);
    if (chunk.features.length > 0) chunks.push({ result: chunk, label });
  }
  groupsFailed = capped.length - groupsCompleted;
  const pathsOmitted = pathsTotal - pathsEnumerated.size;
  const status = pathsEnumerated.size === 0 ? "failed" : groupsFailed > 0 || cappedGroups > 0 || pathsOmitted > 0 ? "partial" : "complete";
  return {
    chunks,
    metrics: { pathsTotal, pathsEnumerated: pathsEnumerated.size, pathsOmitted, groupsTotal: groups.length, groupsCompleted, groupsFailed, status },
  };
}

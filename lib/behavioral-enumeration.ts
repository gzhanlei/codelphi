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
  /** 分析输出语言（072）：透传给两步提取的 prompt 语言段。 */
  outputLanguage?: "zh-CN" | "en";
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
/**
 * Task 14 · inventory 编排的枚举详情（设计 §6.3）：作为可选 details 挂在
 * BehavioralEnumerationMetrics 上——旧 W0-8 diff 枚举回执没有该字段，字段与状态口径不变。
 * running / coarse / implicit / fallback / lease / budget / productDescriptionStatus
 * 与恢复任务会计（reused/executed/pending）在此记录；单元处理比例只是诊断计数，
 * 不产生新的综合质量分（整体状态仍由完整性账本的最差维度规则推导）。
 */
export interface InventoryEnumerationSummary {
  unitsTotal: number;
  unitsPending: number;
  /** 租约持有中（status=running）的单元数。 */
  unitsRunning: number;
  unitsExtracted: number;
  unitsNoBehavior: number;
  unitsUnresolved: number;
  unitsFailed: number;
  anchorsTotal: number;
  /** entry 锚点只用于定位，不计入核销分子。 */
  entryAnchors: number;
  behaviorAnchors: number;
  /** 未被 behavior 锚点覆盖、必须交 AI 审查的剩余区域锚点数。 */
  implicitReviewAnchors: number;
  /** coarse=true 的粗粒度审查区域（检测能力缺口披露，不等于已发现该区域全部行为）。 */
  coarseReviewAnchors: number;
  semanticUnits: number;
  /** 剩余实现面兜底认领的单元数（detector=residual）：检测器缺口由它兜底并披露。 */
  residualUnits: number;
  /** primaryRanges=null 的不可读占位单元数（读取失败披露；占位期间主覆盖门禁不通过）。 */
  unreadableUnits: number;
  primaryRangesCoveredLines: number;
  primaryRangesOmittedLines: number;
  anchorRangesCoveredLines: number;
  anchorRangesOmittedLines: number;
  tasksTotal: number;
  /** 恢复会计：复用成功终态 result_json、本 run 未重新执行的任务数。 */
  tasksReusedTerminal: number;
  /** 本 run 实际发起过提取尝试的任务数（含发起后硬失败的；重试不重复计）。
      passInfos 只覆盖这部分，恢复复用绝不计为新执行趟。 */
  tasksExecuted: number;
  /** 持久化行 status='pending' 的字面计数（failed/unresolved/running 都不是 pending）。 */
  tasksPending: number;
  /** 快照时仍处于 running（租约持有）的任务数。 */
  leasesHeld: number;
  /** 全部任务累计 attempt 数（重复尝试与迟到提交可审计，at-least-once 语义披露）。 */
  attemptsTotal: number;
  /** 共享预算触顶或 usage 未知导致的派发停止（激活门禁 fail closed 的输入）。 */
  budgetBlocked: boolean;
  productDescriptionStatus: "generated" | "preserved" | "unavailable" | "not_run";
}

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
  /** 行为文件的全部 hunk 数（R3 公平预算披露）。 */
  hunksTotal: number;
  /** 因文件级预算被裁剪的 hunk 数（>0 = 尾部上下文未全读，披露用）。 */
  hunksTruncated: number;
  /** complete / partial / failed / not_applicable——增强层失败不得被误认为完整成功。 */
  status: "complete" | "partial" | "failed" | "not_applicable";
  /** Task 14 · inventory 编排的可选枚举详情；旧 W0-8 diff 枚举回执无此字段。 */
  inventory?: InventoryEnumerationSummary;
}

export interface BehavioralEnumerationOutcome {
  chunks: BehavioralEnumerationChunk[];
  metrics: BehavioralEnumerationMetrics;
}

export async function enumerateBehavioralChunks(options: BehavioralEnumerationOptions): Promise<BehavioralEnumerationOutcome> {
  const pathsTotal = new Set(options.behavioralPaths).size;
  if (pathsTotal === 0) {
    return { chunks: [], metrics: { pathsTotal: 0, pathsEnumerated: 0, pathsOmitted: 0, groupsTotal: 0, groupsCompleted: 0, groupsFailed: 0, hunksTotal: 0, hunksTruncated: 0, status: "not_applicable" } };
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
  let hunksTotal = 0;
  let hunksTruncated = 0;
  const pathsEnumerated = new Set<string>();
  for (const [groupIndex, group] of capped.entries()) {
    const label = `w0-8/g${groupIndex + 1}`;
    const targets: Array<{ path: string; patch: string; contextBlocks: Array<{ startLine: number; endLine: number; content: string }> }> = [];
    for (const path of group) {
      const file = options.files.find((candidate) => candidate.path === path);
      if (!file) continue;
      const blocks: Array<{ startLine: number; endLine: number; content: string }> = [];
      try {
        // R3 公平预算：每 hunk 保底核心 ±context 行，剩余按需分配；截断计数披露
        const allocatedReads = allocateHunkReads(changeFileHunkRanges(file, CONTEXT_LINES), MAX_CONTEXT_LINES_PER_FILE, CONTEXT_LINES);
        hunksTotal += allocatedReads.length;
        for (const item of allocatedReads) {
          if (item.truncated) hunksTruncated += 1;
          // 极端路径（hunk 数超过预算）仍可能 0-grant：跳过而不发起非法读取
          if (item.allocated.endLine < item.allocated.startLine) continue;
          const read = await options.index.readLines({ path, startLine: item.allocated.startLine, endLine: Math.min(item.allocated.endLine, item.allocated.startLine + MAX_LINES_PER_READ - 1), requestedBy: "behavioral_enumeration", reason: "W0-8 targeted behavioral extraction" });
          blocks.push({ startLine: read.startLine, endLine: read.endLine, content: read.lines.map((line, offset) => `${read.startLine + offset}: ${line}`).join("\n") });
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
      chunk = await analyzeBehavioralGroup(targets, options.knownFeatureNames, options.change, options.billing, options.outputLanguage);
    } catch (firstError) {
      console.warn("[analysis] behavioral enumeration group failed; retrying once", { label, error: firstError instanceof Error ? firstError.message.slice(0, 160) : String(firstError) });
      try {
        chunk = await analyzeBehavioralGroup(targets, options.knownFeatureNames, options.change, options.billing, options.outputLanguage);
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
    metrics: { pathsTotal, pathsEnumerated: pathsEnumerated.size, pathsOmitted, groupsTotal: groups.length, groupsCompleted, groupsFailed, hunksTotal, hunksTruncated, status },
  };
}

/**
 * R3 hunk 公平预算：400 行/文件帽不再按 hunk 顺序消耗（大文件尾部 hunk 整段被丢）。
 * 每个 hunk 先保底 minPerHunk 行（核心变更区保证入选），剩余预算按剩余需求比例分配，
 * 零头按序补齐；分配不满需求的 hunk 标记 truncated（由编排层计数披露）。
 */
export interface AllocatedHunkRead {
  range: ReadRange;
  /** 实际应读的行区间（裁剪后）。 */
  allocated: ReadRange;
  truncated: boolean;
}

export function allocateHunkReads(ranges: ReadonlyArray<ReadRange>, totalBudget: number, minPerHunk: number): AllocatedHunkRead[] {
  const needs = ranges.map((range) => Math.max(1, range.endLine - range.startLine + 1));
  const grants = needs.map(() => 0);
  let used = 0;
  // 第一步：每个 hunk 保底核心区间。为后续 hunk 预留 1 行预算（remainingAfterThis），
  // 预算不足以保底时每 hunk 至少 1 行——0-grant 会产生 endLine < startLine 的非法读区间，
  // 让整文件在编排层被当不可读丢弃（index.readLines 对非法区间直接抛错）。
  for (let index = 0; index < needs.length; index += 1) {
    const remainingAfterThis = needs.length - index - 1;
    const grant = Math.min(needs[index], minPerHunk, Math.max(0, totalBudget - used - remainingAfterThis));
    grants[index] = Math.max(used < totalBudget ? 1 : 0, grant);
    used += grants[index];
  }
  // 第二步：剩余预算按剩余需求比例一次性分配（同一基数，顺序公平），零头按序补齐
  let remaining = totalBudget - used;
  const unmet = needs.map((need, index) => need - grants[index]);
  const totalUnmet = unmet.reduce((sum, value) => sum + value, 0);
  if (remaining > 0 && totalUnmet > 0) {
    const shares = unmet.map((value) => Math.floor((remaining * value) / totalUnmet));
    let spent = 0;
    for (let index = 0; index < needs.length; index += 1) {
      const grant = Math.min(unmet[index], shares[index], remaining - spent);
      grants[index] += grant;
      spent += grant;
    }
    remaining -= spent;
    // 零头按序补齐（每轮 +1，直到预算用尽或全部满足）
    let cursor = 0;
    while (remaining > 0 && unmet.some((value, index) => needs[index] - grants[index] > 0)) {
      const index = cursor % needs.length;
      if (needs[index] - grants[index] > 0) {
        grants[index] += 1;
        remaining -= 1;
      }
      cursor += 1;
    }
  }
  return ranges.map((range, index) => ({
    range,
    allocated: { startLine: range.startLine, endLine: range.startLine + grants[index] - 1 },
    truncated: grants[index] < needs[index],
  }));
}

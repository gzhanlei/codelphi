import type { OpenedRemoteSourceRevision } from "../remote-source-index/types";
import type { InventorySource } from "./detectors/types";
import { compareCodePoints } from "./identity";
import { unionRanges } from "./ranges";
import type {
  BehaviorAnchorFragment,
  BehaviorExecutionTask,
  BehaviorUnit,
  CodeRange,
  LineRange,
} from "./types";

export interface BehaviorSourceBudgets {
  primaryBytes: number;
  contextBytes: number;
  totalBytes: number;
}

/** D6 硬预算：主内容 96KB、辅助上下文 32KB、合计 128KB；超预算只拆 task/fragment，不截断。 */
export const BEHAVIOR_SOURCE_BUDGETS: BehaviorSourceBudgets = {
  primaryBytes: 96_000,
  contextBytes: 32_000,
  totalBytes: 128_000,
};

export interface PlanExecutionTasksInput {
  units: readonly BehaviorUnit[];
  /** 字节测量只依赖同 revision 的源码内容；与 Task 3 inventory 输入同形。 */
  sources: readonly InventorySource[];
  budgets?: BehaviorSourceBudgets;
}

export interface TaskSource {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  role: "primary" | "context";
}

/** 与 behavioral-enumeration 相同的安全块（索引默认 maxLinesPerRead=600），防止 readLines 静默截断。 */
const MAX_LINES_PER_READ = 400;

interface LineByteIndex {
  lineBytes: number[];
  prefix: number[];
  lineCount: number;
}

function indexContent(content: string): LineByteIndex {
  const lineBytes = content.split("\n").map((line) => Buffer.byteLength(line, "utf8"));
  const prefix = [0];
  for (const bytes of lineBytes) prefix.push(prefix[prefix.length - 1] + bytes);
  return { lineBytes, prefix, lineCount: lineBytes.length };
}

/** 与加载侧 join("\n") 一致的字节口径：区间字节 = 行字节和 + 行间换行数。 */
function rangeBytes(index: LineByteIndex, range: LineRange): number {
  const sum = index.prefix[range.endLine] - index.prefix[range.startLine - 1];
  return sum + (range.endLine - range.startLine);
}

function assertBudgets(budgets: BehaviorSourceBudgets): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`invalid behavior source budget: ${name} must be a positive integer, got ${value}`);
    }
  }
  if (budgets.primaryBytes > budgets.totalBytes || budgets.contextBytes > budgets.totalBytes) {
    throw new Error("invalid behavior source budget: primary/context bytes must not exceed total bytes");
  }
}

interface SizedFragment {
  anchorKey: string;
  ranges: LineRange[];
}

/**
 * 单个锚点超出分片上限时按稳定行区间拆分；单行超过上限即无法安全拆分（返回 null），
 * 调用方把整个单元留作 unresolved，绝不截断内容伪装成功。
 */
function splitAnchorRanges(ranges: readonly LineRange[], index: LineByteIndex, cap: number): LineRange[][] | null {
  const fragments: LineRange[][] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let currentBytes = 0;
  const flush = () => {
    if (currentStart >= 0) fragments.push([{ startLine: currentStart, endLine: currentEnd }]);
    currentStart = -1;
    currentBytes = 0;
  };
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const lineCost = index.lineBytes[line - 1];
      if (lineCost > cap) return null;
      if (currentStart >= 0 && currentBytes + lineCost + 1 > cap) flush();
      if (currentStart < 0) {
        currentStart = line;
        currentBytes = lineCost;
      } else {
        currentBytes += lineCost + 1;
      }
      currentEnd = line;
    }
  }
  flush();
  return fragments;
}

/** 逐单元原子排产：任一锚点无法安全落入预算时整个单元不生成任务，交覆盖门禁判 unresolved。 */
function planUnitTasks(
  unit: BehaviorUnit,
  contents: ReadonlyMap<string, LineByteIndex>,
  budgets: BehaviorSourceBudgets,
): BehaviorExecutionTask[] {
  if (unit.primaryRanges == null) return [];
  const primaryIndex = contents.get(unit.primaryPath);
  if (primaryIndex == null) return [];
  if (unit.primaryRanges.some((range) => range.endLine > primaryIndex.lineCount)) return [];

  const contextRanges = unionRanges(unit.contextRanges);
  let contextBytes = 0;
  for (const range of contextRanges) {
    const contextIndex = contents.get(range.path);
    if (contextIndex == null || range.endLine > contextIndex.lineCount) return [];
    contextBytes += rangeBytes(contextIndex, range);
  }
  if (contextBytes > budgets.contextBytes) return [];

  const cap = Math.min(budgets.primaryBytes, budgets.totalBytes - contextBytes);
  if (cap < 1) return [];

  const reviewAnchors = unit.anchors
    .filter((anchor) => anchor.role !== "entry")
    .sort((a, b) => compareCodePoints(a.anchorKey, b.anchorKey));

  const fragments: SizedFragment[] = [];
  for (const anchor of reviewAnchors) {
    const anchorRanges = unionRanges(
      anchor.ranges.map((range) => ({ path: unit.primaryPath, ...range })),
    );
    if (anchorRanges.some((range) => range.endLine > primaryIndex.lineCount)) return [];
    const bytes = anchorRanges.reduce((total, range) => total + rangeBytes(primaryIndex, range), 0);
    if (bytes <= cap) {
      fragments.push({
        anchorKey: anchor.anchorKey,
        ranges: anchorRanges.map(({ startLine, endLine }) => ({ startLine, endLine })),
      });
      continue;
    }
    const split = splitAnchorRanges(anchorRanges, primaryIndex, cap);
    if (split == null) return [];
    for (const ranges of split) {
      fragments.push({ anchorKey: anchor.anchorKey, ranges });
    }
  }

  // 整锚点优先分组：按锚点顺序贪心装包，装不下才开新任务；拆分只新增 task/fragment key。
  const tasks: BehaviorExecutionTask[] = [];
  // fragment ordinal 按单元内锚点顺序编号，与任务装包结果无关（D6: anchorKey + fragmentRange + fragmentOrdinal）。
  const ordinals = new Map<string, number>();
  let currentFragments: SizedFragment[] = [];
  let currentRanges: CodeRange[] = [];
  const flush = () => {
    if (currentFragments.length === 0) return;
    const ordinal = tasks.length + 1;
    const anchorFragments: BehaviorAnchorFragment[] = currentFragments.map((fragment) => {
      const fragmentOrdinal = (ordinals.get(fragment.anchorKey) ?? 0) + 1;
      ordinals.set(fragment.anchorKey, fragmentOrdinal);
      return {
        anchorKey: fragment.anchorKey,
        anchorFragmentKey: `fragment|${JSON.stringify([
          fragment.anchorKey,
          fragment.ranges.map((range) => [range.startLine, range.endLine]),
          fragmentOrdinal,
        ])}`,
        ranges: fragment.ranges,
      };
    });
    tasks.push({
      taskKey: `task|${JSON.stringify([unit.unitKey, ordinal])}`,
      unitKey: unit.unitKey,
      anchorFragments,
    });
    currentFragments = [];
    currentRanges = [];
  };
  for (const fragment of fragments) {
    const candidate = unionRanges([
      ...currentRanges,
      ...fragment.ranges.map((range) => ({ path: unit.primaryPath, ...range })),
    ]);
    const candidateBytes = candidate.reduce((total, range) => total + rangeBytes(primaryIndex, range), 0);
    if (currentFragments.length > 0 && candidateBytes > cap) flush();
    currentFragments.push(fragment);
    currentRanges = candidate;
  }
  flush();
  return tasks;
}

/**
 * 在 manifest 首次持久化前确定性排产全部执行任务。
 * 无法安全拆到预算内的单元不生成任务（不截断），由覆盖门禁判为 unresolved。
 */
export function planBehaviorExecutionTasks(input: PlanExecutionTasksInput): BehaviorExecutionTask[] {
  const budgets = input.budgets ?? BEHAVIOR_SOURCE_BUDGETS;
  assertBudgets(budgets);
  const contents = new Map<string, LineByteIndex>();
  for (const source of input.sources) {
    if (!contents.has(source.path)) contents.set(source.path, indexContent(source.content));
  }
  const units = [...input.units].sort((a, b) => compareCodePoints(a.unitKey, b.unitKey));
  return units.flatMap((unit) => planUnitTasks(unit, contents, budgets));
}

async function readRange(
  index: OpenedRemoteSourceRevision,
  range: CodeRange,
  role: TaskSource["role"],
): Promise<TaskSource> {
  const lines: string[] = [];
  let startLine = range.startLine;
  while (startLine <= range.endLine) {
    const endLine = Math.min(range.endLine, startLine + MAX_LINES_PER_READ - 1);
    const slice = await index.readLines({
      path: range.path,
      startLine,
      endLine,
      requestedBy: "behavioral_enumeration",
      reason: `behavior task source (${role})`,
    });
    lines.push(...slice.lines);
    startLine = slice.endLine + 1;
    if (slice.endLine < endLine) break;
  }
  return {
    path: range.path,
    content: lines.join("\n"),
    startLine: range.startLine,
    endLine: range.startLine + lines.length - 1,
    role,
  };
}

/**
 * 按任务分片加载源码：primary 取任务 fragment 区间的并集（重叠不重复读），
 * context 只读取单元声明的最小依赖区间（共享服务的签名/调用区间），不在每个消费方重复全文。
 */
export async function loadBehaviorTaskSources(
  index: OpenedRemoteSourceRevision,
  task: BehaviorExecutionTask,
  unit: BehaviorUnit,
): Promise<TaskSource[]> {
  const primaryRanges = unionRanges(
    task.anchorFragments.flatMap((fragment) =>
      fragment.ranges.map((range) => ({ path: unit.primaryPath, ...range })),
    ),
  );
  const contextRanges = unionRanges(unit.contextRanges);
  const sources: TaskSource[] = [];
  for (const range of primaryRanges) sources.push(await readRange(index, range, "primary"));
  for (const range of contextRanges) sources.push(await readRange(index, range, "context"));
  return sources;
}

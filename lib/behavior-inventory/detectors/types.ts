import type { ArchitectureSource } from "../../architecture/source";
import type {
  AnonymousPosition,
  BehaviorAnchorRole,
  BehaviorEvidence,
  BehaviorUnitLocator,
  LineRange,
} from "../types";

/** 检测器输入沿用 ArchitectureSource 形状；eligible 过滤在 inventory 入口按 evidenceKind 完成。 */
export type InventorySource = ArchitectureSource;

export interface BehaviorAnchorDraft {
  role: BehaviorAnchorRole;
  symbol?: string | null;
  anonymousAt?: AnonymousPosition | null;
  ranges: LineRange[];
  evidence?: BehaviorEvidence[];
  coarse: boolean;
}

export interface BehaviorUnitDraft {
  locator: BehaviorUnitLocator;
  primaryPath: string;
  primaryRanges: LineRange[] | null;
  anchors: BehaviorAnchorDraft[];
}

export interface BehaviorDetector {
  id: string;
  version: string;
  detect(source: InventorySource): BehaviorUnitDraft[];
}

/** 每行起始偏移（0 基 index），行号为 1 基。 */
export function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function positionAt(starts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

function findMatching(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * 从声明位置推导符号行区间：取声明后第一个 `{` 做括号配对。
 * 语句在出现 `;` 前没有 `{` 时按单行处理（如 `export const X = 1;`）。
 * 括号不配对抛错，由 inventory 入口归类为 detectorParseFailure。
 */
export function rangeFromDeclaration(
  content: string,
  starts: readonly number[],
  declarationIndex: number,
): LineRange {
  const startLine = positionAt(starts, declarationIndex).line;
  const braceIndex = content.indexOf("{", declarationIndex);
  const semicolonIndex = content.indexOf(";", declarationIndex);
  if (braceIndex === -1 || (semicolonIndex !== -1 && semicolonIndex < braceIndex)) {
    return { startLine, endLine: startLine };
  }
  const closeIndex = findMatching(content, braceIndex, "{", "}");
  if (closeIndex === -1) {
    throw new Error(`unbalanced braces after offset ${declarationIndex}`);
  }
  return { startLine, endLine: positionAt(starts, closeIndex).line };
}

export interface CallArgument {
  text: string;
  /** 参数文本在文件中的绝对起始偏移（已跳过前导空白）。 */
  start: number;
}

/** 从 `(` 的偏移解析到配对的 `)`，按顶层逗号切分参数，字符串字面量内的逗号不切。 */
export function parseCallArguments(content: string, openParenIndex: number): CallArgument[] | null {
  const closeIndex = findMatching(content, openParenIndex, "(", ")");
  if (closeIndex === -1) return null;
  const args: CallArgument[] = [];
  let depth = 0;
  let quote: string | null = null;
  let argStart = openParenIndex + 1;
  for (let index = openParenIndex + 1; index < closeIndex; index += 1) {
    const char = content[index];
    if (quote != null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push({ text: content.slice(argStart, index), start: argStart });
      argStart = index + 1;
    }
  }
  args.push({ text: content.slice(argStart, closeIndex), start: argStart });
  return args
    .map((arg) => {
      const trimmed = arg.text.trim();
      const leading = arg.text.length - arg.text.trimStart().length;
      return { text: trimmed, start: arg.start + leading };
    })
    .filter((arg) => arg.text !== "");
}

export function unquoteLiteral(text: string): string | null {
  if (text.length < 2) return null;
  const first = text[0];
  if ((first === "\"" || first === "'" || first === "`") && text[text.length - 1] === first) {
    return text.slice(1, -1);
  }
  return null;
}

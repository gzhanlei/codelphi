import type {
  AnonymousPosition,
  BehaviorAnchorLocator,
  BehaviorUnitLocator,
  CodeRange,
  LineRange,
} from "./types";

export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const aPoint = left[index].codePointAt(0) ?? 0;
    const bPoint = right[index].codePointAt(0) ?? 0;
    if (aPoint !== bPoint) return aPoint - bPoint;
  }
  return left.length - right.length;
}

export function assertLineRange(range: LineRange): void {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
    throw new Error(`invalid range: lines must be integers, got [${range.startLine}, ${range.endLine}]`);
  }
  if (range.startLine < 1 || range.startLine > range.endLine) {
    throw new Error(`invalid range: expected 1 <= startLine <= endLine, got [${range.startLine}, ${range.endLine}]`);
  }
}

/** 校验闭区间，按 (startLine, endLine) 排序并去除完全重复的区间。不做重叠合并（见 ranges.ts）。 */
export function normalizeLineRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges.map((range) => {
    assertLineRange(range);
    return { startLine: range.startLine, endLine: range.endLine };
  });
  sorted.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return sorted.filter(
    (range, index) => index === 0 || range.startLine !== sorted[index - 1].startLine || range.endLine !== sorted[index - 1].endLine,
  );
}

/** 校验带路径区间，按 (path, startLine, endLine) 排序并去重。 */
export function normalizeCodeRanges(ranges: readonly CodeRange[]): CodeRange[] {
  const sorted = ranges.map((range) => {
    assertLineRange(range);
    return { path: range.path, startLine: range.startLine, endLine: range.endLine };
  });
  sorted.sort(
    (a, b) => compareCodePoints(a.path, b.path) || a.startLine - b.startLine || a.endLine - b.endLine,
  );
  return sorted.filter(
    (range, index) =>
      index === 0 ||
      range.path !== sorted[index - 1].path ||
      range.startLine !== sorted[index - 1].startLine ||
      range.endLine !== sorted[index - 1].endLine,
  );
}

function handlerIdentity(
  symbol: string | null | undefined,
  anonymousAt: AnonymousPosition | null | undefined,
): string | null {
  if (symbol != null && symbol !== "") return symbol;
  if (anonymousAt != null) {
    return `anonymous@${anonymousAt.path}:${anonymousAt.startLine}:${anonymousAt.startColumn}`;
  }
  return null;
}

function chunkIdentity(chunk: LineRange | null | undefined): string | null {
  if (chunk == null) return null;
  assertLineRange(chunk);
  return `chunk:${chunk.startLine}-${chunk.endLine}`;
}

function normalizeMethod(method: string | null | undefined): string | null {
  if (method == null) return null;
  return method.trim().toUpperCase();
}

/**
 * 单元 key 只承诺同 revision、scope、detector registry、inventory schema 下确定。
 * AI 生成名称（displayName）与文件内容 hash 不进入身份。
 */
export function makeUnitKey(input: BehaviorUnitLocator): string {
  const handler = handlerIdentity(input.symbol, input.anonymousAt);
  let parts: unknown[];
  switch (input.kind) {
    case "http":
      parts = [normalizeMethod(input.method), input.route ?? null, input.registrationPath ?? null, handler];
      break;
    case "page":
      parts = [input.route ?? input.path ?? null, input.registrationPath ?? null, handler];
      break;
    case "cli":
    case "job":
    case "event":
      parts = [input.registrationId ?? null, input.registrationPath ?? null, handler];
      break;
    case "public_api":
      parts = [input.exportPath ?? null, input.symbol ?? null, input.signature ?? null];
      break;
    case "symbol_range":
      if (input.path == null) throw new Error("symbol_range unit locator requires path");
      parts = [input.path, handler ?? chunkIdentity(input.chunk)];
      break;
    case "file":
      if (input.path == null) throw new Error("file unit locator requires path");
      parts = [input.path];
      break;
  }
  if (input.occurrenceOrdinal != null) parts.push(`#${input.occurrenceOrdinal}`);
  return `unit|${input.kind}|${JSON.stringify(parts)}`;
}

/** 锚点 key 由规范化代码定位信息生成，不依赖 AI 输出，也不随执行任务拆分改变。 */
export function makeAnchorKey(input: BehaviorAnchorLocator): string {
  const handler = handlerIdentity(input.symbol, input.anonymousAt);
  const ranges = normalizeLineRanges(input.ranges).map((range) => [range.startLine, range.endLine]);
  const parts: unknown[] = [input.path, handler, ranges];
  if (input.occurrenceOrdinal != null) parts.push(`#${input.occurrenceOrdinal}`);
  return `anchor|${input.role}|${JSON.stringify(parts)}`;
}

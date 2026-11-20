import {
  lineStarts,
  positionAt,
  rangeFromDeclaration,
  type BehaviorDetector,
  type BehaviorUnitDraft,
  type InventorySource,
} from "./types";

const NEXT_ROUTE_PATH = /(?:^|\/)app\/.*\/route\.(?:ts|tsx|js|jsx|mjs)$|(?:^|\/)pages\/api\/.*\.(?:ts|tsx|js|jsx|mjs)$/;
const NEXT_PAGE_PATH = /(?:^|\/)app\/.*\/page\.(?:ts|tsx|js|jsx)$|(?:^|\/)pages\/(?!api\/)(?:(?!_)[^/]+\/)*(?!_)[^/]+\.(?:tsx|jsx)$/;

// 行首缩进只吃行内空白（J）：`\s` 吞换行会把声明前的空行并入路由/page 单元区间。
const HTTP_METHOD = /^[^\S\n]*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|^[^\S\n]*export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=\s*(?:async\s*)?/gm;
const DEFAULT_EXPORT = /^[^\S\n]*export\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/gm;

export function isNextRoutePath(path: string): boolean {
  return NEXT_ROUTE_PATH.test(path);
}

export function isNextPagePath(path: string): boolean {
  return NEXT_PAGE_PATH.test(path);
}

export function matchesNextPath(path: string): boolean {
  return isNextRoutePath(path) || isNextPagePath(path);
}

/** 规范化路由：去 app/pages 前缀与文件名，去掉路由组段，收敛 index。无法推导返回 null。 */
export function deriveNextRoute(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  let rest: string;
  if (/(?:^|\/)app\//.test(normalized)) {
    rest = normalized.replace(/^(?:.*\/)?app\//, "");
    rest = rest.replace(/(?:^|\/)(?:route|page)\.[tj]sx?$/, "");
  } else if (/(?:^|\/)pages\//.test(normalized)) {
    rest = normalized.replace(/^(?:.*\/)?pages\//, "");
    rest = rest.replace(/\.[tj]sx?$/, "");
  } else {
    return null;
  }
  const segments = rest
    .split("/")
    .filter((segment) => segment !== "" && !segment.startsWith("("))
    .filter((segment) => segment !== "index");
  return `/${segments.join("/")}`;
}

function detectRouteUnits(source: InventorySource): BehaviorUnitDraft[] {
  const starts = lineStarts(source.content);
  const route = deriveNextRoute(source.path);
  const drafts: BehaviorUnitDraft[] = [];
  HTTP_METHOD.lastIndex = 0;
  for (let match = HTTP_METHOD.exec(source.content); match != null; match = HTTP_METHOD.exec(source.content)) {
    const method = match[1] ?? match[2];
    if (method == null) continue;
    const range = rangeFromDeclaration(source.content, starts, match.index);
    const evidence = [{ path: source.path, startLine: range.startLine }];
    drafts.push({
      locator: {
        kind: "http",
        method,
        route,
        registrationPath: source.path,
        symbol: method,
      },
      primaryPath: source.path,
      primaryRanges: [range],
      anchors: [
        { role: "entry", symbol: method, ranges: [{ startLine: range.startLine, endLine: range.startLine }], evidence, coarse: false },
        { role: "implicit_review", symbol: method, ranges: [range], evidence, coarse: true },
      ],
    });
  }
  return drafts;
}

function detectPageUnit(source: InventorySource): BehaviorUnitDraft[] {
  const starts = lineStarts(source.content);
  const route = deriveNextRoute(source.path);
  DEFAULT_EXPORT.lastIndex = 0;
  const match = DEFAULT_EXPORT.exec(source.content);
  if (match == null) return [];
  const name = match[1] ?? null;
  const range = rangeFromDeclaration(source.content, starts, match.index);
  const declaration = positionAt(starts, match.index);
  const anonymousAt = name == null
    ? { path: source.path, startLine: declaration.line, startColumn: declaration.column }
    : null;
  const evidence = [{ path: source.path, startLine: range.startLine }];
  return [
    {
      locator: {
        kind: "page",
        route,
        path: source.path,
        registrationPath: source.path,
        symbol: name,
        anonymousAt,
      },
      primaryPath: source.path,
      primaryRanges: [range],
      anchors: [
        { role: "entry", symbol: name, anonymousAt, ranges: [{ startLine: range.startLine, endLine: range.startLine }], evidence, coarse: false },
        { role: "implicit_review", symbol: name, anonymousAt, ranges: [range], evidence, coarse: true },
      ],
    },
  ];
}

export function detectNext(source: InventorySource): BehaviorUnitDraft[] {
  if (isNextRoutePath(source.path)) return detectRouteUnits(source);
  if (isNextPagePath(source.path)) return detectPageUnit(source);
  return [];
}

export const nextDetector: BehaviorDetector = {
  id: "next",
  version: "1",
  detect: detectNext,
};

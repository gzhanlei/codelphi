import {
  lineStarts,
  parseCallArguments,
  positionAt,
  rangeFromDeclaration,
  unquoteLiteral,
  type BehaviorDetector,
  type BehaviorUnitDraft,
  type CallArgument,
  type InventorySource,
} from "./types";
import type { LineRange } from "../types";

interface RegistrationPattern {
  kind: "cli" | "job" | "event";
  regex: RegExp;
}

/** 只识别带显式接收者与字符串字面量注册标识的注册调用；其他一律视为动态并兜底。 */
const REGISTRATION_PATTERNS: RegistrationPattern[] = [
  { kind: "cli", regex: /\b(?:program|yargs|commander)\s*\.\s*command\s*\(/g },
  { kind: "job", regex: /\bcron\s*\.\s*schedule\s*\(/g },
  { kind: "job", regex: /\bnew\s+Queue\s*\(/g },
  { kind: "event", regex: /\b(?:eventBus|bus|emitter|consumer|pubsub|events)\s*\.\s*(?:on|subscribe|registerHandler)\s*\(/gi },
];

/** 语言无关的动态注册信号：出现即记录 dynamicRegistrationFallback，不伪造语义 key。 */
const DYNAMIC_REGISTRATION_PATTERNS: RegExp[] = [
  /\badd_url_rule\s*\(/,
  /\bregister_blueprint\s*\(/,
  /@(?:app|router|bp|blueprint)\s*\.\s*route\s*\(\s*(?!["'`])\w/,
  /\b(?:app|router|server)\s*\[\s*[\w$]+\s*\]\s*\(/,
];

/** 行首断言后的缩进只吃空白不吃换行（J）：`\s` 可吞换行会把声明前的空行并入单元区间。 */
const EXPORT_DECLARATION = /^[^\S\n]*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^[^\S\n]*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm;

export function matchesGenericPath(path: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path);
}

export function findDynamicRegistrationLines(source: InventorySource): number[] {
  const starts = lineStarts(source.content);
  const lines = new Set<number>();
  for (const pattern of DYNAMIC_REGISTRATION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (let match = regex.exec(source.content); match != null; match = regex.exec(source.content)) {
      lines.add(positionAt(starts, match.index).line);
    }
  }
  const { dynamicLines } = analyzeRegistrations(source);
  for (const line of dynamicLines) lines.add(line);
  return [...lines].sort((a, b) => a - b);
}

interface RegistrationMatch {
  kind: "cli" | "job" | "event";
  openParenIndex: number;
  line: number;
}

interface ScannedRegistrations {
  registrations: Array<{
    kind: "cli" | "job" | "event";
    registrationId: string;
    handler: CallArgument;
    line: number;
  }>;
  dynamicLines: number[];
}

function findCliHandlerArgument(content: string, callCloseHint: number): CallArgument | null {
  const statement = content.slice(callCloseHint, callCloseHint + 400);
  const actionMatch = /\.\s*action\s*\(/.exec(statement);
  if (actionMatch == null) return null;
  const openParen = callCloseHint + actionMatch.index + actionMatch[0].length - 1;
  const args = parseCallArguments(content, openParen);
  return args == null || args.length === 0 ? null : args[args.length - 1];
}

function scanRegistrations(source: InventorySource): ScannedRegistrations {
  const starts = lineStarts(source.content);
  const matches: RegistrationMatch[] = [];
  for (const pattern of REGISTRATION_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (let match = pattern.regex.exec(source.content); match != null; match = pattern.regex.exec(source.content)) {
      matches.push({
        kind: pattern.kind,
        openParenIndex: match.index + match[0].length - 1,
        line: positionAt(starts, match.index).line,
      });
    }
  }
  matches.sort((a, b) => a.openParenIndex - b.openParenIndex);

  const registrations: ScannedRegistrations["registrations"] = [];
  const dynamicLines: number[] = [];
  for (const match of matches) {
    const args = parseCallArguments(source.content, match.openParenIndex);
    if (args == null || args.length === 0) {
      dynamicLines.push(match.line);
      continue;
    }
    const registrationId = unquoteLiteral(args[0].text);
    const handler = match.kind === "cli"
      ? findCliHandlerArgument(source.content, match.openParenIndex)
      : args[args.length - 1];
    if (registrationId == null || handler == null) {
      dynamicLines.push(match.line);
      continue;
    }
    registrations.push({ kind: match.kind, registrationId, handler, line: match.line });
  }
  return { registrations, dynamicLines };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function resolveNamedHandler(content: string, starts: readonly number[], name: string): LineRange | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?:^|\n) 之后只吃行内空白（J）：`\s*` 会跨行吞掉声明前的空行，使 handler 区间起点错位。
  const patterns = [
    new RegExp(`(?:^|\\n)[^\\S\\n]*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)[^\\S\\n]*(?:export\\s+)?const\\s+${escaped}\\s*=`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match != null) {
      const offset = match.index + (match[0].startsWith("\n") ? 1 : 0);
      return rangeFromDeclaration(content, starts, offset);
    }
  }
  return null;
}

function registrationDraft(
  source: InventorySource,
  starts: readonly number[],
  registration: ScannedRegistrations["registrations"][number],
): BehaviorUnitDraft | null {
  const { kind, registrationId, handler } = registration;
  const registrationPosition = positionAt(starts, handler.start);

  let symbol: string | null = null;
  let anonymousAt: BehaviorUnitDraft["locator"]["anonymousAt"] = null;
  let handlerRange: LineRange | null = null;

  if (IDENTIFIER.test(handler.text)) {
    symbol = handler.text;
    handlerRange = resolveNamedHandler(source.content, starts, handler.text);
    if (handlerRange == null) return null;
  } else if (/^(?:async\s*)?(?:function\b|\()/.test(handler.text)) {
    anonymousAt = {
      path: source.path,
      startLine: registrationPosition.line,
      startColumn: registrationPosition.column,
    };
    handlerRange = rangeFromDeclaration(source.content, starts, handler.start);
  } else {
    return null;
  }

  const entryEvidence = [{ path: source.path, startLine: registrationPosition.line }];
  return {
    locator: {
      kind,
      registrationId,
      registrationPath: source.path,
      symbol,
      anonymousAt,
    },
    primaryPath: source.path,
    primaryRanges: [handlerRange],
    anchors: [
      { role: "entry", symbol, anonymousAt, ranges: [{ startLine: registrationPosition.line, endLine: registrationPosition.line }], evidence: entryEvidence, coarse: false },
      { role: "implicit_review", symbol, anonymousAt, ranges: [handlerRange], evidence: [{ path: source.path, startLine: handlerRange.startLine }], coarse: true },
    ],
  };
}

function publicExportDrafts(source: InventorySource, starts: readonly number[]): BehaviorUnitDraft[] {
  const drafts: BehaviorUnitDraft[] = [];
  EXPORT_DECLARATION.lastIndex = 0;
  for (let match = EXPORT_DECLARATION.exec(source.content); match != null; match = EXPORT_DECLARATION.exec(source.content)) {
    const name = match[1] ?? match[2];
    if (name == null) continue;
    const range = rangeFromDeclaration(source.content, starts, match.index);
    drafts.push({
      locator: { kind: "public_api", exportPath: source.path, symbol: name, signature: null },
      primaryPath: source.path,
      primaryRanges: [range],
      anchors: [
        { role: "behavior", symbol: name, ranges: [range], evidence: [{ path: source.path, startLine: range.startLine }], coarse: false },
      ],
    });
  }
  return drafts;
}

interface RegistrationAnalysis {
  drafts: BehaviorUnitDraft[];
  dynamicLines: number[];
}

function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/** 同一 handler 被多次注册时，后续注册单元收缩到注册语句行：handler 区间只能由首个
 *  注册单元认领（同文件主区间两两不相交的结构不变量），后续单元的独立行为是注册本身
 *  （registrationId/调度参数差异），其 entry 锚点已在注册语句上。 */
function shrinkDraftToRegistrationLine(draft: BehaviorUnitDraft, fallbackLine: number): BehaviorUnitDraft {
  const entryLine = draft.anchors.find((anchor) => anchor.role === "entry")?.ranges[0]?.startLine ?? fallbackLine;
  return {
    ...draft,
    primaryRanges: [{ startLine: entryLine, endLine: entryLine }],
    anchors: draft.anchors.filter((anchor) => anchor.role === "entry"),
  };
}

/** handler 不可解析（未定义标识符、无法识别的匿名形态）时同样记动态兜底，不允许静默丢单元。 */
function analyzeRegistrations(source: InventorySource): RegistrationAnalysis {
  const starts = lineStarts(source.content);
  const { registrations, dynamicLines } = scanRegistrations(source);
  const drafts: BehaviorUnitDraft[] = [];
  const claimedHandlerRanges: LineRange[] = [];
  for (const registration of registrations) {
    let draft = registrationDraft(source, starts, registration);
    if (draft == null) {
      dynamicLines.push(registration.line);
      continue;
    }
    if (draft.primaryRanges?.some((range) => claimedHandlerRanges.some((claimed) => rangesOverlap(range, claimed)))) {
      draft = shrinkDraftToRegistrationLine(draft, registration.line);
    }
    claimedHandlerRanges.push(...(draft.primaryRanges ?? []));
    drafts.push(draft);
  }
  return { drafts, dynamicLines };
}

export function detectGeneric(source: InventorySource): BehaviorUnitDraft[] {
  const starts = lineStarts(source.content);
  const registrationDrafts = analyzeRegistrations(source).drafts;
  // A：注册调用优先认领 handler 声明区间——同一区间若再产出 public_api 单元会造成
  // 主区间跨单元重叠（同一行被两个身份单元双计）。与任一注册 handler 区间相交的
  // public_api 草稿直接丢弃；注册单元本身已带 entry + implicit_review 完整覆盖。
  const registrationRanges: LineRange[] = registrationDrafts.flatMap((draft) => draft.primaryRanges ?? []);
  const drafts = publicExportDrafts(source, starts).filter(
    (draft) => !(draft.primaryRanges ?? []).some((range) => registrationRanges.some((other) => rangesOverlap(range, other))),
  );
  return [...drafts, ...registrationDrafts];
}

export const genericDetector: BehaviorDetector = {
  id: "generic",
  version: "1",
  detect: detectGeneric,
};

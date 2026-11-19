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

const EXPORT_DECLARATION = /^\s*export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm;

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
  const { dynamicLines } = scanRegistrations(source);
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
    registrations.push({ kind: match.kind, registrationId, handler });
  }
  return { registrations, dynamicLines };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function resolveNamedHandler(content: string, starts: readonly number[], name: string): LineRange | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${escaped}\\s*=`),
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

export function detectGeneric(source: InventorySource): BehaviorUnitDraft[] {
  const starts = lineStarts(source.content);
  const drafts = publicExportDrafts(source, starts);
  const { registrations } = scanRegistrations(source);
  for (const registration of registrations) {
    const draft = registrationDraft(source, starts, registration);
    if (draft != null) drafts.push(draft);
  }
  return drafts;
}

export const genericDetector: BehaviorDetector = {
  id: "generic",
  version: "1",
  detect: detectGeneric,
};

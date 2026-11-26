/**
 * 隐私扫描（修订稿 §4.2）。客户端和服务端共用这一份代码：客户端上传前扫，服务端复查它做得到的三条规则。
 * 纯函数，不读环境、不连库——它要被打进客户端的单文件里。
 *
 * 扫描对象是载荷里的每一个字符串值，不只是 proposal 字段：流程图、理解层、覆盖率、回执说明都在内。
 *
 * 规则：
 *   code_block    任一字符串值里出现三反引号围栏。服务端能复查。
 *   source_line   本次读过的源码里一行代码（去首尾空白后不少于 30 个字符）原样出现在某个字符串值的一行里。
 *   code_fragment 字符串值的一行里，有一段代码结构与某行源码相同。两边都去掉注释、字符串内容、标识符和数字，
 *                 只留运算符、括号和关键字；连续 4 个记号里要有比较、赋值或逻辑运算符，还要有引号、方括号、
 *                 花括号、关键字或第二个运算符。它不看空白和标识符，所以去掉空白的源码、变量改名后的近似源码
 *                 都命中。只对九种能识别注释的扩展名生效，因为去注释要去得准。
 *   code_run      连续 3 行或更多以 ; { } 结尾的非空文本行。服务端能复查。
 *   patch_marker  以 @@ -、diff --git、+++ b/、--- a/ 开头的行。服务端能复查。
 *
 * 能力边界（已知拦不住，测试集里固定为放行，规则改了要显式改测试）：只有函数调用的行、单个短条件、
 * 算术公式、九种扩展名以外的语言的代码片段（整行规则仍然管用）、改写成自然语言的内容、跨字段拼接的内容。
 */

export const PRIVACY_RULES = ["code_block", "source_line", "code_fragment", "code_run", "patch_marker"] as const;

export type PrivacyRule = (typeof PRIVACY_RULES)[number];

export interface PrivacyHit {
  rule: PrivacyRule;
  /** 载荷里的字段路径，例如 proposal.features[3].scenarios[0].outcome；载荷本身是字符串时为空串。 */
  path: string;
  /** 命中的是那个字符串值的第几行（从 1 数）。 */
  line: number;
  /** 整行规则和代码片段规则命中的源码文件。其它规则没有这一项。 */
  sourcePath?: string;
}

export interface SourceText {
  path: string;
  text: string;
}

/** 源码索引：整行规则和代码片段规则查的东西。 */
export interface SourceIndex {
  /** 够长的代码行（原样，只去掉了注释），按前 LINE_KEY_LENGTH 个字符分组。 */
  lines: Map<string, Array<{ line: string; path: string }>>;
  /** 每行源码骨架里合格的记号窗口 → 源码文件。 */
  fragments: Map<string, string>;
}

/** 能识别注释的扩展名：去注释要去得准，其它语言的文件不进代码片段规则的比对。 */
const COMMENT_AWARE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/i;
const PYTHON = /\.py$/i;
/** 整行规则只看够长的行：短行和标识符、路径分不开。 */
const SOURCE_LINE_MIN_LENGTH = 30;
/** 整行规则的索引按这个长度的前缀分组，查找时在载荷的一行里滑窗。 */
const LINE_KEY_LENGTH = 16;
const FRAGMENT_WINDOW = 4;
const CODE_RUN_LINES = 3;

const KEYWORDS = new Set(
  "if else for while return throw new await async function class switch case catch try const let var def elif except lambda import from export yield assert raise with not and or in is None True False fn pub use match impl type struct enum func go defer chan package select".split(
    " ",
  ),
);
const STRONG_OPERATORS = new Set(["=", "==", "===", "!=", "!==", "<=", ">=", "&&", "||", "=>", "->", "+=", "-=", "*=", "/=", "%="]);
const STRUCTURE_TOKENS = new Set(['"', "'", "`", "[", "]", "{", "}", "&&", "||", "=>", "->"]);
const OPERATOR_OR_WORD = /(===|!==|==|!=|<=|>=|&&|\|\||=>|->|\+=|-=|\*=|\/=|%=|\+\+|--|[A-Za-z]+|[^\sA-Za-z0-9])/g;
const PATCH_PREFIX = /^(@@ -|diff --git|\+\+\+ b\/|--- a\/)/;
const CODE_RUN_ENDING = /[;{}]$/;
const ONLY_BRACKETS = /^[;{}()\[\],\s]+$/;
const CLOSED_DOUBLE_QUOTED = /"(?:[^"\\\n]|\\.)*"/g;

type BlockMode = "code" | "block" | "quoted";

interface LineState {
  mode: BlockMode;
  quote: string;
}

/** 一行源码留下的东西：code 是代码部分（注释去掉，字符串内容抹成一对空引号），raw 是同样的范围但保留原样。 */
interface LineCode {
  code: string;
  raw: string;
}

/** 从 start 起找和 quote 配对的结束引号，跳过反斜杠转义。没找到返回 -1。 */
function closingQuote(line: string, start: number, quote: string): number {
  let index = start + quote.length;
  while (index < line.length) {
    if (line[index] === "\\") index += 2;
    else if (line.startsWith(quote, index)) return index;
    else index += 1;
  }
  return -1;
}

/**
 * 取出一行源码里的代码部分。块注释、文档串、模板串可以跨行，所以带着状态逐行调用。
 * raw 给整行规则用（载荷里出现的是原样的行），code 给代码片段规则用（两边都要抹掉字符串内容才比得一样）。
 */
function codeOfLine(line: string, python: boolean, state: LineState): LineCode {
  let code = "";
  let raw = "";
  let index = 0;
  const soFar = (): LineCode => ({ code, raw });
  while (index < line.length) {
    if (state.mode === "block") {
      const end = line.indexOf("*/", index);
      if (end < 0) return soFar();
      state.mode = "code";
      index = end + 2;
      continue;
    }
    if (state.mode === "quoted") {
      const end = line.indexOf(state.quote, index);
      if (end < 0) return soFar();
      state.mode = "code";
      index = end + state.quote.length;
      continue;
    }
    const char = line[index];
    if (python ? char === "#" : char === "/" && line[index + 1] === "/") return soFar();
    if (!python && char === "/" && line[index + 1] === "*") {
      state.mode = "block";
      index += 2;
      continue;
    }
    const quote = python && (line.startsWith('"""', index) || line.startsWith("'''", index)) ? line.slice(index, index + 3) : char;
    if (quote === '"""' || quote === "'''" || char === '"' || char === "'" || char === "`") {
      const end = closingQuote(line, index, quote);
      // 没闭合的文档串、模板串会跨行：从这里到行尾都是字符串内容，不留任何东西，带着状态进下一行。
      if (end < 0 && quote.length === 3 || end < 0 && char === "`" && !python) {
        state.mode = "quoted";
        state.quote = quote;
        return soFar();
      }
      code += '""';
      // 没闭合的单双引号到行尾为止，不带着状态走。
      raw += line.slice(index, end < 0 ? line.length : end + quote.length);
      index = end < 0 ? line.length : end + quote.length;
      continue;
    }
    code += char;
    raw += char;
    index += 1;
  }
  return soFar();
}

function codeLinesOf(text: string, path: string): LineCode[] {
  const python = PYTHON.test(path);
  const state: LineState = { mode: "code", quote: "" };
  const lines: LineCode[] = [];
  for (const line of text.split(/\r?\n/)) {
    const part = codeOfLine(line, python, state);
    if (part.code.trim() !== "") lines.push({ code: part.code.trim(), raw: part.raw.trim() });
  }
  return lines;
}

/** 一个源码文件里每一行留下的代码部分（去首尾空白），整行是注释或空白的不要。 */
export function codePartsOf(text: string, path: string): string[] {
  return codeLinesOf(text, path).map((line) => line.code);
}

/** 代码骨架：标识符和数字去掉（关键字留着），只留运算符、括号和引号。空白和非 ASCII 不算记号。 */
function skeletonOf(code: string): string[] {
  const masked = code
    .replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (word) => (KEYWORDS.has(word) ? ` ${word} ` : " "))
    .replace(/[0-9_$]+/g, " ")
    .replace(/[^\x20-\x7e]+/g, " ");
  return masked.match(OPERATOR_OR_WORD) ?? [];
}

/** 一个窗口要同时像代码、又不容易在正文里出现：有比较、赋值或逻辑运算符，还得有别的结构。 */
function qualifies(window: readonly string[]): boolean {
  const strong = window.filter((token) => STRONG_OPERATORS.has(token)).length;
  return strong >= 1 && (strong >= 2 || window.some((token) => STRUCTURE_TOKENS.has(token) || KEYWORDS.has(token)));
}

function fragmentWindows(tokens: readonly string[]): string[] {
  const windows: string[] = [];
  for (let index = 0; index + FRAGMENT_WINDOW <= tokens.length; index += 1) {
    const window = tokens.slice(index, index + FRAGMENT_WINDOW);
    if (qualifies(window)) windows.push(window.join(" "));
  }
  return windows;
}

/** 把一次分析读过的全部源码建成索引。不是抽样的。 */
export function createSourceIndex(files: readonly SourceText[]): SourceIndex {
  const lines = new Map<string, Array<{ line: string; path: string }>>();
  const fragments = new Map<string, string>();
  for (const file of files) {
    const codeLines = codeLinesOf(file.text, file.path);
    for (const { raw } of codeLines) {
      if (raw.length < SOURCE_LINE_MIN_LENGTH || ONLY_BRACKETS.test(raw)) continue;
      const key = raw.slice(0, LINE_KEY_LENGTH);
      lines.set(key, [...(lines.get(key) ?? []), { line: raw, path: file.path }]);
    }
    if (!COMMENT_AWARE_EXTENSIONS.test(file.path)) continue;
    for (const { code } of codeLines) for (const window of fragmentWindows(skeletonOf(code))) if (!fragments.has(window)) fragments.set(window, file.path);
  }
  return { lines, fragments };
}

/** 载荷的一行里有没有哪条够长的源码行原样出现。 */
function sourceLineOf(text: string, index: SourceIndex): string | undefined {
  for (let start = 0; start + LINE_KEY_LENGTH <= text.length; start += 1) {
    const found = index.lines.get(text.slice(start, start + LINE_KEY_LENGTH))?.find((entry) => text.includes(entry.line));
    if (found) return found.path;
  }
  return undefined;
}

/** 载荷的一行里的字符串内容抹成空引号。只抹同一行里闭合的双引号串：英文里的撇号不是字符串。 */
function fragmentOf(text: string, index: SourceIndex): string | undefined {
  const tokens = skeletonOf(text.replace(CLOSED_DOUBLE_QUOTED, '""'));
  for (const window of fragmentWindows(tokens)) {
    const path = index.fragments.get(window);
    if (path !== undefined) return path;
  }
  return undefined;
}

function scanText(text: string, path: string, index: SourceIndex | undefined, hits: PrivacyHit[]): void {
  let blockReported = false;
  let runLength = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, position) => {
    const trimmed = line.trim();
    const lineNumber = position + 1;
    if (!blockReported && line.includes("```")) {
      hits.push({ rule: "code_block", path, line: lineNumber });
      blockReported = true;
    }
    if (PATCH_PREFIX.test(trimmed)) hits.push({ rule: "patch_marker", path, line: lineNumber });
    runLength = trimmed !== "" && CODE_RUN_ENDING.test(trimmed) ? runLength + 1 : 0;
    if (runLength === CODE_RUN_LINES) hits.push({ rule: "code_run", path, line: lineNumber - CODE_RUN_LINES + 1 });
    if (index === undefined) return;
    const sourceLine = sourceLineOf(trimmed, index);
    if (sourceLine !== undefined) hits.push({ rule: "source_line", path, line: lineNumber, sourcePath: sourceLine });
    const fragment = fragmentOf(trimmed, index);
    if (fragment !== undefined) hits.push({ rule: "code_fragment", path, line: lineNumber, sourcePath: fragment });
  });
}

function walk(value: unknown, path: string, visit: (text: string, path: string) => void): void {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walk(item, path === "" ? key : `${path}.${key}`, visit);
  }
}

/** 扫整个载荷。给了源码索引就是客户端的完整扫描；不给就只剩不需要源码的三条规则。命中按载荷里的出现顺序返回。 */
export function scanValue(value: unknown, index?: SourceIndex): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  walk(value, "", (text, path) => scanText(text, path, index, hits));
  return hits;
}

/** 服务端的复查：它没有源码，只查代码块、连续片段、补丁特征。 */
export function scanServer(value: unknown): PrivacyHit[] {
  return scanValue(value);
}

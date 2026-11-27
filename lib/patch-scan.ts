import { isImplementationSurfaceFile, isInfrastructureEvidence } from "./evidence";
import type { ChangeFile } from "./code-hosting/types";

/**
 * patch 行为性判定：文件在本发布中的增删行是否包含注释/空白以外的内容。
 * 确定性规则，供 tests-only 门禁判定「实现证据文件本次是否真的变了行为」：
 * 纯注释/空白变动（如补 JSDoc）不构成行为变更，引用它的「新增功能」是覆盖补录。
 *
 * BM-9（benchmark report-2026-11-10 FG-1）：formatter 重排（换行/缩进调整、整行搬动、
 * 多行折叠）不是行为变更——M8 案例两轮复现「formatter diff → 假新增功能」。识别取
 * 两层**严格相等**（去空白后）：行级集合相等（重排）或全行拼接相等（折叠/展开）。
 * 保守边界——拿不准一律视为行为变更：`b - a → a - b`、`a || b → a ?? b`、`a.b → a?.b`
 * 去空白串均不同，不会被误判为格式；引号统一类 formatter 改动保留标点差异，同样放行
 * 为行为（漏判格式的代价是一条假功能，错判行为的代价是丢真变化，红线取后者）。
 *
 * 集合语义 = 行为变更 ∩ implementation 级证据：测试/文档路径按证据分级即不行为性，
 * 不因 patch 内容进入集合。
 *
 * 保守方向设计——拿不准一律视为行为变更（宁可漏折叠，不可错折叠）：
 * - 无 patch、未知语言、超长疑似截断的 patch → 行为变更；
 * - Python docstring 体、模板字符串等按内容行处理 → 行为变更；
 * - C 系块注释跨行状态机按 patch 片段重同步（块注释闭合标记出现即出块）。
 */

const COMMENT_STYLE_LANGUAGES = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/i;
/** 超过该长度视为可能被 share 预算截断（截断会隐藏尾部代码行），保守视为行为变更。 */
const TRUNCATION_GUARD_LENGTH = 4000;

interface PatchCodeLines {
  added: string[];
  removed: string[];
}

/**
 * 收集 patch 中非注释的代码行内容：跳过 hunk 头、空白行与注释行（C 系行注释与块注释
 * 跨行状态机按片段重同步；Python 只跳 # 注释）。块注释闭合后同行剩余内容非空时
 * 视为确定行为（返回 null 短路，与既有保守语义一致）。
 */
function collectCodeLines(patch: string, pythonOnly: boolean): PatchCodeLines | null {
  const added: string[] = [];
  const removed: string[] = [];
  let inBlock = false;
  for (const raw of patch.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    const isRemoved = line.startsWith("-") && !line.startsWith("---");
    if (!isAdded && !isRemoved) continue;
    const content = line.slice(1).trim();
    if (content === "") continue;
    if (pythonOnly) {
      if (content.startsWith("#")) continue;
      (isAdded ? added : removed).push(content);
      continue;
    }
    if (inBlock) {
      const closeIndex = content.indexOf("*/");
      if (closeIndex === -1) continue;
      const rest = content.slice(closeIndex + 2).trim();
      if (rest !== "") return null; // 块注释后同行还有代码：确定行为
      inBlock = false;
      continue;
    }
    if (content.startsWith("//")) continue;
    if (content.startsWith("/*")) {
      if (!content.includes("*/")) inBlock = true;
      continue;
    }
    (isAdded ? added : removed).push(content);
  }
  return { added, removed };
}

/** 去除全部空白字符（formatter 的缩进/换行产物），供格式等价比较。 */
function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * BM-9 格式重排判定：增删两侧均非空，且（1）去空白行集合相等——整行搬动；或
 * （2）全部代码行去空白后拼接相等——换行/缩进调整与多行折叠。任何 token/标点差异
 * （操作数交换、运算符替换、optional chaining、引号统一）都不会通过严格相等。
 */
function isFormattingOnly(added: string[], removed: string[]): boolean {
  if (added.length === 0 || removed.length === 0) return false;
  const squashedAdded = added.map(squashWhitespace);
  const squashedRemoved = removed.map(squashWhitespace);
  // 1) 行级重排：同一组行，顺序不同
  if ([...squashedAdded].sort().join("\u0001") === [...squashedRemoved].sort().join("\u0001")) return true;
  // 2) 折叠/展开：换行位置不同，去空白拼接相同
  return squashedAdded.join("") === squashedRemoved.join("");
}

/** 单个 patch 是否只有注释/空白/格式重排变动（无代码语义变更）。 */
export function patchOnlyCommentsOrBlank(patch: string): boolean {
  const lines = collectCodeLines(patch, /\.py$/i.test(patch));
  if (lines === null) return false;
  return lines.added.length === 0 && lines.removed.length === 0;
}

/**
 * 本发布中包含行为性行变更的 implementation 级文件路径集合；未入集合 = 仅注释/空白/格式重排变动、无 patch 佐证、非实现证据、
 * 数据库迁移脚本或 CI/基础设施路径（BM-8：工作流/锁文件不承载产品行为；迁移脚本已移出分析目标）。
 */
export function behavioralChangePaths(files: ReadonlyArray<ChangeFile>): Set<string> {
  const behavioral = new Set<string>();
  for (const file of files) {
    if (carriesBehavior(file.path) && patchIsBehavioral(file)) behavioral.add(file.path);
  }
  return behavioral;
}

/** 一次发布的变更，可以带着调用方已经算好的「含行为变更的路径集合」。 */
export interface ChangeWithBehavioralPaths {
  files: ReadonlyArray<ChangeFile>;
  behavioralPaths?: ReadonlySet<string>;
}

/**
 * 这次发布里含行为变更的路径集合：调用方算好了就用它的，否则从补丁算。
 * 客户端提案不带补丁文本，集合和行号区间都由客户端在本地用同一个函数算好交上来（修订稿 §4.4）。
 */
export function behavioralPathsOf(change: ChangeWithBehavioralPaths): ReadonlySet<string> {
  return change.behavioralPaths ?? behavioralChangePaths(change.files);
}


/** 路径层级：只有实现证据才进入行为判定。测试、文档、CI/基础设施与迁移脚本在此排除。 */
// 2026-11-27 起口径在 lib/analysis-target.ts：测试、文档、迁移脚本、构建和部署文件、生成的代码、第三方副本都不承载行为。
function carriesBehavior(path: string): boolean {
  return isImplementationSurfaceFile(path) && !isInfrastructureEvidence(path);
}

/** 内容层级：补丁里有注释、空白与格式重排以外的代码变动，才算行为变更。 */
function patchIsBehavioral(file: ChangeFile): boolean {
  const pythonOnly = /\.py$/i.test(file.path);
  const commentAware = COMMENT_STYLE_LANGUAGES.test(file.path);
  if (!file.patch || !commentAware || file.patch.length > TRUNCATION_GUARD_LENGTH) return true;
  const lines = collectCodeLines(file.patch, pythonOnly);
  if (lines === null) return true;
  if (lines.added.length === 0 && lines.removed.length === 0) return false;
  return !isFormattingOnly(lines.added, lines.removed);
}

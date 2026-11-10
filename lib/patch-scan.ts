import { evidenceKind, isInfrastructureEvidence } from "./evidence";
import type { ChangeFile } from "./code-hosting/types";

/**
 * patch 行为性判定：文件在本发布中的增删行是否包含注释/空白以外的内容。
 * 确定性规则，供 tests-only 门禁判定「实现证据文件本次是否真的变了行为」：
 * 纯注释/空白变动（如补 JSDoc）不构成行为变更，引用它的「新增功能」是覆盖补录。
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

/** 单个 patch 是否只有注释/空白变动（C 系行级判定；Python 由调用方单独处理）。 */
export function patchOnlyCommentsOrBlank(patch: string): boolean {
  let inBlock = false;
  for (const raw of patch.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    const isRemoved = line.startsWith("-") && !line.startsWith("---");
    if (!isAdded && !isRemoved) continue;
    const content = line.slice(1).trim();
    if (content === "") continue;
    if (inBlock) {
      const closeIndex = content.indexOf("*/");
      if (closeIndex === -1) continue;
      const rest = content.slice(closeIndex + 2).trim();
      if (rest === "") {
        inBlock = false;
        continue;
      }
      return false;
    }
    if (content.startsWith("//")) continue;
    if (content.startsWith("/*")) {
      if (content.includes("*/")) continue;
      inBlock = true;
      continue;
    }
    return false;
  }
  return true;
}

/** 本发布中包含行为性行变更的 implementation 级文件路径集合；未入集合 = 仅注释/空白变动、无 patch 佐证、非实现证据或 CI/基础设施路径（BM-8：工作流/锁文件不承载产品行为）。 */
export function behavioralChangePaths(files: ReadonlyArray<ChangeFile>): Set<string> {
  const behavioral = new Set<string>();
  for (const file of files) {
    if (evidenceKind(file.path) !== "implementation") continue;
    if (isInfrastructureEvidence(file.path)) continue;
    const pythonOnly = /\.py$/i.test(file.path);
    const commentAware = COMMENT_STYLE_LANGUAGES.test(file.path);
    if (!file.patch || !commentAware || file.patch.length > TRUNCATION_GUARD_LENGTH) {
      behavioral.add(file.path);
      continue;
    }
    if (pythonOnly) {
      // Python 无块注释状态（docstring 体保守按内容处理）：只跳过 # 注释行与空白行。
      const nonComment = file.patch.split("\n").some((raw) => {
        const line = raw.trim();
        if (!line.startsWith("+") && !line.startsWith("-")) return false;
        const content = line.slice(1).trim();
        return content !== "" && !content.startsWith("#");
      });
      if (nonComment) behavioral.add(file.path);
      continue;
    }
    if (!patchOnlyCommentsOrBlank(file.patch)) behavioral.add(file.path);
  }
  return behavioral;
}

import { buildAnalysisMessages, type ChangeContext } from "../ai";
import type { SourceFile } from "../github";
import type { StructuredCompletionMessage } from "../llm-client";
import type { GuardAnchor } from "./guard-anchors";

export type GuardExperimentArm = "A" | "B" | "C" | "D";

/**
 * CB-18 四臂实验的冻结替换（B/D 臂只允许这三处变化）：
 * 覆盖长句、每功能场景长句、证据长句 → 压缩版。原始代码段逐字不变。
 */
const FROZEN_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    "当前产品功能规格必须覆盖输入代码里的全部主要用户功能，不得只总结本次提交。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。",
    "覆盖输入中的全部主要用户功能，逐个检查页面、API、组件和业务模块，不得只总结提交或遗漏独立模块。",
  ],
  [
    "优先保证功能覆盖，每个功能保留最关键的 1-5 个场景；不要因单个功能场景过多而遗漏其他功能。",
    "覆盖全部主要功能；每功能保留 1-5 个关键场景。",
  ],
  [
    "每个场景、reviewed 审计候选和产品简介必须给 evidence；path 必须来自输入文件，startLine 使用输入的行号。没有内部实现需要审计时返回 changes=[]。",
    "场景、审计候选和产品简介均须附输入文件的 path:startLine 证据；无内部审计时 changes=[]。",
  ],
];

const ANCHOR_SECTION_HEADER = "【遗留守卫锚点（静态提取的 if/throw 守卫，供覆盖核对，最多 3 条）】";
const CODE_SECTION_MARKER = "\n【当前代码，带行号】\n";
const MAX_ANCHORS = 3;

const ANCHOR_SCORE_RULES: ReadonlyArray<readonly [RegExp, number]> = [
  [/supersed|latest|activat/i, 3],
  [/permission|authoriz/i, 2],
  [/payment|billing|quota/i, 1],
];

function anchorScore(anchor: GuardAnchor): number {
  const haystack = `${anchor.symbol}\n${anchor.condition}\n${anchor.outcome}`;
  for (const [pattern, score] of ANCHOR_SCORE_RULES) {
    if (pattern.test(haystack)) return score;
  }
  return 0;
}

/** 冻结排序：分数降序（supersed|latest|activat=3、permission|authoriz=2、payment|billing|quota=1），再按 path/startLine 升序，最多 3 条。 */
export function selectGuardExperimentAnchors(anchors: GuardAnchor[], max = MAX_ANCHORS): GuardAnchor[] {
  return [...anchors]
    .sort((left, right) =>
      anchorScore(right) - anchorScore(left)
      || left.path.localeCompare(right.path)
      || left.evidence.startLine - right.evidence.startLine)
    .slice(0, max);
}

function renderAnchorSection(anchors: GuardAnchor[]): string {
  const lines = anchors.map((anchor) =>
    `- ${anchor.evidence.path}:${anchor.evidence.startLine}-${anchor.evidence.endLine}｜${anchor.symbol}｜extraction=${anchor.extraction}｜condition: ${anchor.condition}｜outcome: ${anchor.outcome}`,
  );
  return [ANCHOR_SECTION_HEADER, ...lines].join("\n");
}

function applyFrozenReplacements(content: string): string {
  let result = content;
  for (const [from, to] of FROZEN_REPLACEMENTS) {
    if (!result.includes(from)) {
      throw new Error("[legacy-guard-prompt] frozen replacement source missing from buildAnalysisMessages output");
    }
    result = result.replace(from, to);
  }
  return result;
}

function insertAnchors(content: string, anchors: GuardAnchor[]): string {
  const selected = selectGuardExperimentAnchors(anchors);
  if (selected.length === 0) return content;
  const index = content.indexOf(CODE_SECTION_MARKER);
  if (index < 0) {
    throw new Error("[legacy-guard-prompt] code section marker missing from buildAnalysisMessages output");
  }
  return `${content.slice(0, index)}\n${renderAnchorSection(selected)}${content.slice(index)}`;
}

/**
 * 四臂 Prompt 构建（只包装 buildAnalysisMessages，不改生产 lib/ai.ts）：
 * - A：与 buildAnalysisMessages 逐字节一致；
 * - B：仅应用三条冻结替换；
 * - C：仅在 commit 与 code section 之间插入守卫锚点（用 extraction，无 resolution）；
 * - D：同时应用替换与锚点插入。
 */
export function buildLegacyGuardExperimentMessages(input: {
  arm: GuardExperimentArm;
  sources: SourceFile[];
  change: ChangeContext;
  anchors: GuardAnchor[];
}): StructuredCompletionMessage[] {
  const base = buildAnalysisMessages(input.sources, input.change);
  if (input.arm === "A") return base;
  const system = base[0];
  const user = base[1];
  if (!system || !user) throw new Error("[legacy-guard-prompt] unexpected buildAnalysisMessages shape");
  let content = user.content;
  if (input.arm === "B" || input.arm === "D") content = applyFrozenReplacements(content);
  if (input.arm === "C" || input.arm === "D") content = insertAnchors(content, input.anchors);
  return [system, { ...user, content }];
}

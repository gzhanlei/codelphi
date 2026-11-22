import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import type { OutputLanguage } from "../analysis-language";
import type { TaskSource } from "../behavior-inventory/planner";
import {
  parseJudgeContent,
  type BehaviorJudgeOutput,
  type BehaviorRegionDescription,
} from "../behavior-unit-ai";
import { BATCH_PROMPT_VERSION, type BatchChatMessage } from "./types";
import { parseBatchJudgeContent, BatchProtocolError, type BatchProtocolMember, type BatchTaskParseResult } from "./protocol";
export { BatchProtocolError };

/**
 * Task 13 fused 单步协议：每 attempt 一次模型调用同时完成「先陈述事实、后判定」。
 *
 * 分层设计（用户裁决的边界落实）：
 * - **质量手法在 prompt 层**：要求模型对每个区域先输出 facts/inputs/controlFlow/
 *   externalEffects（双步 describe 的推理手法）再输出判定——引导模型先理解后裁决，
 *   但不新增持久化字段（入库产物与双步 judge 对齐）。
 * - **校验零弱化**：解析与校验原样复用现有 parseBatchJudgeContent（judge schema、
 *   证据 allow set、场景归属、内部身份全部同构）——合并的是模型调用，不是质量职责；
 *   模型不得自证正确，独立程序化校验与 repair 语义保持不变。
 * - 成员绑定、失败隔离与双步完全一致（T 别名绑定、duplicate/missing 逐成员隔离）。
 */

export interface BatchFusedPromptInput {
  members: ReadonlyArray<BatchProtocolMember>;
  taskByTaskKey: ReadonlyMap<string, BehaviorExecutionTask>;
  sourcesByTaskKey: ReadonlyMap<string, TaskSource[]>;
  knownFeatureNames?: string[];
  knownUnitKeys?: string[];
  language?: OutputLanguage;
}

export function buildBatchFusedPrompt(input: BatchFusedPromptInput): BatchChatMessage[] {
  const language: OutputLanguage = input.language ?? "zh-CN";
  const roster = input.members
    .map((member) => `- ${member.taskAlias}: ${member.orderedRegionAliases.map((alias) => alias.regionAlias).join(", ")}`)
    .join("\n");
  const system = [
    `[execution-batch fused v${BATCH_PROMPT_VERSION}]`,
    language === "en"
      ? "You are executing one batched single-call extraction for multiple tasks. Each TASK section below carries its own instructions, review regions (R1…Rn) and source. For every region you must FIRST state the facts (facts, inputs, controlFlow, externalEffects) and THEN the judgment (disposition, internalKind, reason, evidence, scenarioRefs) — analysis and judgment happen once, in one output, but the judgment must still rest on the stated facts and verifiable evidence."
      : "你正在执行一次多任务单调用提取。下面每个 TASK 分节自带说明、审查区域（R1…Rn）与源码。对每个区域必须先陈述事实（facts/inputs/controlFlow/externalEffects），再给出判定（disposition/internalKind/reason/evidence/scenarioRefs）——分析与判定一次完成，但判定必须基于已陈述的事实与可验证证据。",
    language === "en"
      ? 'Respond with exactly ONE JSON object: {"tasks":[{"id":"T1","regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":"","disposition":"extracted|reviewed_internal|unresolved","internalKind":"","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}],"features":[...]},...]}. Each listed task id must appear exactly once and contain every listed region id. Scenario references are scoped inside their own task.'
      : '只返回一个 JSON 对象：{"tasks":[{"id":"T1","regions":[{…事实四字段…判定字段…}],"features":[…]},…]}。列出的每个任务 id 恰好出现一条，且必须包含其列出的全部区域 id；区域 id 原样回显；场景引用只在所属任务内解析。',
    language === "en" ? "[Task roster]" : "【任务清单】",
    roster,
  ].join("\n");
  const sections = input.members.map((member) => {
    const task = input.taskByTaskKey.get(member.taskKey);
    if (!task) throw new BatchProtocolError(`成员 ${member.taskAlias} 缺少任务定义（${member.taskKey}）`);
    const sources = input.sourcesByTaskKey.get(member.taskKey) ?? [];
    return `===== TASK ${member.taskAlias} =====\n${describeTaskFusedBody(task, sources, language)}`;
  });
  return [
    { role: "system", content: system },
    { role: "user", content: sections.join("\n\n") },
  ];
}

/** 单任务 fused 指令体：事实四元组 + 判定字段一次产出（结构与双步的 describe/judge 同字段名）。 */
function describeTaskFusedBody(task: BehaviorExecutionTask, sources: TaskSource[], language: OutputLanguage): string {
  const ids = task.anchorFragments.map((_, index) => `R${index + 1}`);
  const regionList = task.anchorFragments
    .map((fragment, index) => {
      const ranges = fragment.ranges.map((range) => `${range.startLine}-${range.endLine}`).join(language === "en" ? ", " : "、");
      return language === "en" ? `- ${ids[index]}: lines ${ranges}` : `- ${ids[index]}：行 ${ranges}`;
    })
    .join("\n");
  const sourceSections = sources
    .filter((source) => source.role === "primary")
    .map((source) => {
      const header = language === "en"
        ? `--- ${source.path} lines ${source.startLine}-${source.endLine} ---`
        : `--- ${source.path} 行 ${source.startLine}-${source.endLine} ---`;
      const numbered = source.content
        .split("\n")
        .map((line, offset) => `${source.startLine + offset}: ${line}`)
        .join("\n");
      return `${header}\n${numbered}`;
    })
    .join("\n");
  const template = '{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":"","disposition":"extracted|reviewed_internal|unresolved","internalKind":"pure_technical|covered_elsewhere|data_transform|other_evidence_backed","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}';
  if (language === "en") {
    return [
      "Single-call extraction: for each review region state the facts first (what the code does, its inputs, control flow, external effects) and then judge it.",
      "- extracted: externally visible behavior → output the scenarios in features and fill the region's scenarioRefs.",
      "- reviewed_internal: internal implementation only → internalKind, reason and evidence required, scenarioRefs empty.",
      "- unresolved: cannot be decided from the source → say why.",
      "Evidence must cite the provided source paths with real line numbers; do not cite files you were not given.",
      `Region schema: ${template}`,
      "",
      "[Review regions]",
      regionList,
      "",
      "[Primary content (with line numbers)]",
      sourceSections || "(none)",
    ].join("\n");
  }
  return [
    "单调用提取：对每个审查区域先陈述事实（这段代码做什么、输入、控制流、对外效果），再给出判定。",
    "- extracted：存在外部可感知行为 → 在 features 中输出对应场景并回填区域的 scenarioRefs。",
    "- reviewed_internal：纯内部实现 → internalKind、reason、evidence 必填，scenarioRefs 为空。",
    "- unresolved：无法从源码判定 → 说明原因。",
    "证据必须引用给出的源码路径与真实行号；不得引用未提供的文件。",
    `区域 schema：${template}`,
    "",
    "【审查区域】",
    regionList,
    "",
    "【主内容（带行号）】",
    sourceSections || "（无）",
  ].join("\n");
}

/** fused 解析 = 既有双步 judge 解析的同构复用：T 包装、别名绑定、逐成员失败隔离、
 *  judge schema 校验（facts 四字段被 schema 归一剥离——它们是 prompt 层推理手法，不入库）。 */
export function parseBatchFusedContent(
  content: string,
  members: ReadonlyArray<BatchProtocolMember>,
): BatchTaskParseResult<BehaviorJudgeOutput>[] {
  return parseBatchJudgeContent(content, members);
}

// 类型再导出：fused payload 与现有 judge 输出/描述类型同构（deriveBehaviorTaskResult 直接消费）
export type { BehaviorJudgeOutput, BehaviorRegionDescription };

import type { TaskSource } from "../behavior-inventory/planner";
import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import type { OutputLanguage } from "../analysis-language";
import {
  describeBehaviorTaskPrompt,
  extractJsonObject,
  judgeBehaviorTaskPrompt,
  parseDescribeContent,
  parseJudgeContent,
  type BehaviorJudgeOutput,
  type BehaviorRegionDescription,
  type JudgePromptInput,
} from "../behavior-unit-ai";
import { BATCH_PROMPT_VERSION, type BatchChatMessage } from "./types";

/**
 * 双步 batch 协议（§11/§12 / §23.6 C6）：外层只做 T/R 包装与语法解析，各 task payload 经
 * JSON.stringify 原样交给现有单任务解析器（parseDescribeContent/parseJudgeContent）——
 * 不复制 feature/scenario Zod schema，不定义第二套业务协议。失败按成员隔离：
 * 缺 task / 缺 region 是未决输入（绝不 no_behavior），重复别名与 schema 错误只影响该成员。
 */

export class BatchProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BatchProtocolError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 协议只消费成员的别名与持久化区域映射（BatchAttemptMember 的结构子集）。 */
export interface BatchProtocolMember {
  taskKey: string;
  taskAlias: string;
  orderedRegionAliases: ReadonlyArray<{ anchorFragmentKey: string; regionAlias: string }>;
}

export interface BatchDescribePromptInput {
  members: ReadonlyArray<BatchProtocolMember>;
  taskByTaskKey: ReadonlyMap<string, BehaviorExecutionTask>;
  sourcesByTaskKey: ReadonlyMap<string, TaskSource[]>;
  language?: OutputLanguage;
}

export interface BatchJudgePromptInput {
  members: ReadonlyArray<BatchProtocolMember>;
  taskByTaskKey: ReadonlyMap<string, BehaviorExecutionTask>;
  sourcesByTaskKey: ReadonlyMap<string, TaskSource[]>;
  /** judge 请求显式绑定的 describe 响应 hash（§10.2）。 */
  describeResponseHash: string;
  /** taskKey → describe 解析结果；缺复述的成员由 judge 直接核对源码（单任务同规则）。 */
  descriptionsByTaskKey: ReadonlyMap<string, BehaviorRegionDescription[]>;
  knownFeatureNames?: string[];
  knownUnitKeys?: string[];
  language?: OutputLanguage;
}

export type BatchTaskParseStatus =
  | "ok"
  | "missing_task"
  | "duplicate_task"
  | "duplicate_region"
  | "missing_region"
  | "payload_invalid"
  | "unknown_alias";

export interface BatchTaskParseResult<T> {
  /** unknown_alias 的诊断条目没有成员身份，taskKey 为 null。 */
  taskKey: string | null;
  taskAlias: string;
  status: BatchTaskParseStatus;
  payload?: T;
  message?: string;
  diagnostics?: string[];
}

interface BatchTaskEntry {
  id: string;
  regions: unknown;
  features: unknown;
}

function requireTask(input: { taskByTaskKey: ReadonlyMap<string, BehaviorExecutionTask> }, member: BatchProtocolMember): BehaviorExecutionTask {
  const task = input.taskByTaskKey.get(member.taskKey);
  if (!task) throw new BatchProtocolError(`成员 ${member.taskAlias} 缺少任务定义（${member.taskKey}）`);
  return task;
}

function buildRoster(members: ReadonlyArray<BatchProtocolMember>): string {
  return members
    .map((member) => `- ${member.taskAlias}: ${member.orderedRegionAliases.map((alias) => alias.regionAlias).join(", ")}`)
    .join("\n");
}

export function buildBatchDescribePrompt(input: BatchDescribePromptInput): BatchChatMessage[] {
  const language: OutputLanguage = input.language ?? "zh-CN";
  const system = [
    `[execution-batch describe v${BATCH_PROMPT_VERSION}]`,
    language === "en"
      ? "You are executing one batched describe request for multiple tasks. Each TASK section below carries its own instructions and its own review regions (R1…Rn)."
      : "你正在执行一次多任务复述批处理请求。下面每个 TASK 分节自带说明与各自的审查区域（R1…Rn）。",
    language === "en"
      ? 'Respond with exactly ONE JSON object: {"tasks":[{"id":"T1","regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":""}]},...]}. Each listed task id must appear exactly once and contain every listed region id; echo region ids exactly as listed.'
      : '只返回一个 JSON 对象：{"tasks":[{"id":"T1","regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":""}]},…]}。列出的每个任务 id 恰好出现一条，且必须包含其列出的全部区域 id；区域 id 原样回显，不得增删改。',
    language === "en" ? "[Task roster]" : "【任务清单】",
    buildRoster(input.members),
  ].join("\n");
  const sections = input.members.map((member) => {
    const task = requireTask(input, member);
    const sources = input.sourcesByTaskKey.get(member.taskKey) ?? [];
    return `===== TASK ${member.taskAlias} =====\n${describeBehaviorTaskPrompt(task, sources, language)}`;
  });
  return [
    { role: "system", content: system },
    { role: "user", content: sections.join("\n\n") },
  ];
}

export function buildBatchJudgePrompt(input: BatchJudgePromptInput): BatchChatMessage[] {
  const language: OutputLanguage = input.language ?? "zh-CN";
  const system = [
    `[execution-batch judge v${BATCH_PROMPT_VERSION}]`,
    language === "en"
      ? `This judgment is bound to the persisted describe response hash ${input.describeResponseHash}: the member set, T/R alias mapping and source inputs are identical to that describe call.`
      : `本次判定绑定 describe 响应指纹 ${input.describeResponseHash}：成员、T/R 别名映射与源码输入与该 describe 调用完全一致，不得增删成员。`,
    language === "en"
      ? 'Respond with exactly ONE JSON object: {"tasks":[{"id":"T1","regions":[{"id":"R1","disposition":"extracted|reviewed_internal|unresolved","internalKind":"","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}],"features":[...]},...]}. Each listed task id must appear exactly once and contain every listed region id. Scenario references are scoped inside their own task.'
      : '只返回一个 JSON 对象：{"tasks":[{"id":"T1","regions":[{"id":"R1","disposition":"extracted|reviewed_internal|unresolved","internalKind":"","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}],"features":[…]},…]}。列出的每个任务 id 恰好出现一条，且必须包含其列出的全部区域 id；场景引用只在所属任务内解析。',
    language === "en" ? "[Task roster]" : "【任务清单】",
    buildRoster(input.members),
  ].join("\n");
  const sections = input.members.map((member) => {
    const task = requireTask(input, member);
    const sources = input.sourcesByTaskKey.get(member.taskKey) ?? [];
    const judgeInput: JudgePromptInput = {
      task,
      sources,
      descriptions: input.descriptionsByTaskKey.get(member.taskKey) ?? [],
      knownFeatureNames: input.knownFeatureNames,
      knownUnitKeys: input.knownUnitKeys,
      language,
    };
    return `===== TASK ${member.taskAlias} =====\n${judgeBehaviorTaskPrompt(judgeInput)}`;
  });
  return [
    { role: "system", content: system },
    { role: "user", content: sections.join("\n\n") },
  ];
}

function readTaskEntries(raw: unknown, stage: string): BatchTaskEntry[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BatchProtocolError(`batch ${stage} 外层不是 JSON 对象`);
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) {
    throw new BatchProtocolError(`batch ${stage} 缺少 tasks 数组`);
  }
  const entries: BatchTaskEntry[] = [];
  for (const item of record.tasks) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new BatchProtocolError(`batch ${stage} tasks 元素不是对象`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new BatchProtocolError(`batch ${stage} tasks 元素缺字符串 id`);
    }
    entries.push({ id: entry.id, regions: entry.regions, features: entry.features });
  }
  return entries;
}

/** 合成单任务身份：R 别名按持久化顺序生成（与 taskRegionIds 同构），区域结论按别名回填。
 *  持久化别名与 R 序号不一致属于成员完整性冲突，直接拒绝解释响应。 */
function syntheticTaskFromMember(member: BatchProtocolMember): BehaviorExecutionTask {
  member.orderedRegionAliases.forEach((alias, index) => {
    if (alias.regionAlias !== `R${index + 1}`) {
      throw new BatchProtocolError(
        `成员 ${member.taskAlias} 的持久化区域别名 ${alias.regionAlias} 与序号 R${index + 1} 不一致`,
      );
    }
  });
  return {
    taskKey: member.taskKey,
    unitKey: "",
    anchorFragments: member.orderedRegionAliases.map((alias) => ({
      anchorKey: "",
      anchorFragmentKey: alias.anchorFragmentKey,
      ranges: [],
    })),
  };
}

type RegionCheck =
  | { ok: true; regionsRaw: unknown[]; diagnostics: string[] }
  | { ok: false; status: "duplicate_region" | "missing_region" | "payload_invalid"; message: string };

function checkRegionPayload(entry: BatchTaskEntry, member: BatchProtocolMember): RegionCheck {
  const regionsRaw = Array.isArray(entry.regions) ? entry.regions : [];
  const ids: string[] = [];
  for (const region of regionsRaw) {
    if (region === null || typeof region !== "object" || Array.isArray(region) || typeof (region as { id?: unknown }).id !== "string") {
      return { ok: false, status: "payload_invalid", message: `成员 ${member.taskAlias} 的 region 元素缺字符串 id` };
    }
    ids.push((region as { id: string }).id);
  }
  const expected = member.orderedRegionAliases.map((alias) => alias.regionAlias);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicated = expected.filter((alias) => (counts.get(alias) ?? 0) > 1);
  if (duplicated.length > 0) {
    return { ok: false, status: "duplicate_region", message: `成员 ${member.taskAlias} 区域结论重复: ${duplicated.join(", ")}` };
  }
  const present = new Set(ids);
  const missing = expected.filter((alias) => !present.has(alias));
  if (missing.length > 0) {
    return { ok: false, status: "missing_region", message: `成员 ${member.taskAlias} 缺区域结论: ${missing.join(", ")}` };
  }
  const diagnostics = ids.filter((id) => !expected.includes(id)).map((id) => `丢弃未知区域 id: ${id}`);
  return { ok: true, regionsRaw, diagnostics };
}

function parseEntryPayload<TDescribe, TJudge>(
  stage: "describe" | "judge",
  entry: BatchTaskEntry,
  member: BatchProtocolMember,
  parse: (content: string, task: BehaviorExecutionTask) => TDescribe | TJudge,
):
  | { ok: true; payload: TDescribe | TJudge; diagnostics: string[] }
  | { ok: false; status: "duplicate_region" | "missing_region" | "payload_invalid"; message: string } {
  const check = checkRegionPayload(entry, member);
  if (!check.ok) return check;
  const task = syntheticTaskFromMember(member);
  const payloadJson =
    stage === "describe"
      ? JSON.stringify({ regions: check.regionsRaw })
      : JSON.stringify({ regions: check.regionsRaw, features: Array.isArray(entry.features) ? entry.features : [] });
  try {
    return { ok: true, payload: parse(payloadJson, task), diagnostics: check.diagnostics };
  } catch (error) {
    return {
      ok: false,
      status: "payload_invalid",
      message: `成员 ${member.taskAlias} 的 ${stage} schema 校验失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function parseBatchDescribeContent(
  content: string,
  members: ReadonlyArray<BatchProtocolMember>,
): BatchTaskParseResult<BehaviorRegionDescription[]>[] {
  let raw: unknown;
  try {
    raw = extractJsonObject(content);
  } catch (error) {
    throw new BatchProtocolError("batch describe 整体 JSON 无法解析（不得按任何成员伪装成功）", { cause: error });
  }
  const entries = readTaskEntries(raw, "describe");
  const aliasSet = new Set(members.map((member) => member.taskAlias));
  const results: BatchTaskParseResult<BehaviorRegionDescription[]>[] = [];
  for (const member of members) {
    const matched = entries.filter((entry) => entry.id === member.taskAlias);
    if (matched.length === 0) {
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "missing_task",
        message: `batch 未返回成员 ${member.taskAlias} 的复述（所有区域按未决输入处理）`,
      });
      continue;
    }
    if (matched.length > 1) {
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "duplicate_task",
        message: `batch 对成员 ${member.taskAlias} 返回 ${matched.length} 条复述`,
      });
      continue;
    }
    const parsed = parseEntryPayload<BehaviorRegionDescription[], never>("describe", matched[0]!, member, parseDescribeContent);
    if (!parsed.ok) {
      results.push({ taskKey: member.taskKey, taskAlias: member.taskAlias, status: parsed.status, message: parsed.message });
      continue;
    }
    results.push({
      taskKey: member.taskKey,
      taskAlias: member.taskAlias,
      status: "ok",
      payload: parsed.payload as BehaviorRegionDescription[],
      diagnostics: parsed.diagnostics.length > 0 ? parsed.diagnostics : undefined,
    });
  }
  for (const entry of entries) {
    if (!aliasSet.has(entry.id)) {
      results.push({ taskKey: null, taskAlias: entry.id, status: "unknown_alias", message: "模型返回未知 task ID：忽略并记录诊断" });
    }
  }
  return results;
}

export function parseBatchJudgeContent(
  content: string,
  members: ReadonlyArray<BatchProtocolMember>,
): BatchTaskParseResult<BehaviorJudgeOutput>[] {
  let raw: unknown;
  try {
    raw = extractJsonObject(content);
  } catch (error) {
    throw new BatchProtocolError("batch judge 整体 JSON 无法解析（不得按任何成员伪装成功）", { cause: error });
  }
  const entries = readTaskEntries(raw, "judge");
  const aliasSet = new Set(members.map((member) => member.taskAlias));
  const results: BatchTaskParseResult<BehaviorJudgeOutput>[] = [];
  for (const member of members) {
    const matched = entries.filter((entry) => entry.id === member.taskAlias);
    if (matched.length === 0) {
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "missing_task",
        message: `batch 未返回成员 ${member.taskAlias} 的判定（所有区域按未决输入处理）`,
      });
      continue;
    }
    if (matched.length > 1) {
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "duplicate_task",
        message: `batch 对成员 ${member.taskAlias} 返回 ${matched.length} 条判定`,
      });
      continue;
    }
    const parsed = parseEntryPayload<never, BehaviorJudgeOutput>("judge", matched[0]!, member, parseJudgeContent);
    if (!parsed.ok) {
      results.push({ taskKey: member.taskKey, taskAlias: member.taskAlias, status: parsed.status, message: parsed.message });
      continue;
    }
    results.push({
      taskKey: member.taskKey,
      taskAlias: member.taskAlias,
      status: "ok",
      payload: parsed.payload as BehaviorJudgeOutput,
      diagnostics: parsed.diagnostics.length > 0 ? parsed.diagnostics : undefined,
    });
  }
  for (const entry of entries) {
    if (!aliasSet.has(entry.id)) {
      results.push({ taskKey: null, taskAlias: entry.id, status: "unknown_alias", message: "模型返回未知 task ID：忽略并记录诊断" });
    }
  }
  return results;
}

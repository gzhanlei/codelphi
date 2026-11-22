import type { TaskSource } from "../behavior-inventory/planner";
import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import {
  behaviorTaskTruncatedResult,
  deriveBehaviorTaskResult,
  type BehaviorTaskExtractionResult,
} from "../behavior-unit-extraction";
import { batchFingerprint } from "./identity";
import { BatchProtocolError, parseBatchDescribeContent, parseBatchJudgeContent, type BatchProtocolMember } from "./protocol";

/**
 * 按 task 拆分与独立结果推导（§12 / §23.6 C6）：batch 原始响应 → 协议层解析 → 逐成员复用
 * 现有单任务推导（deriveBehaviorTaskResult / behaviorTaskTruncatedResult，判定规则零复制）。
 * 诚实边界：describe/judge 截断一律全成员 output_truncated（不接受部分成功）；缺 task/缺
 * region 是未决输入（推导落 unresolved，绝不 no_behavior）；重复别名与 schema 错误只标记
 * 该成员 parse_failed（硬失败/重试语义由编排层执行）。本模块不写库。
 */

export interface ExtractBatchInput {
  members: ReadonlyArray<BatchProtocolMember>;
  taskByTaskKey: ReadonlyMap<string, BehaviorExecutionTask>;
  sourcesByTaskKey: ReadonlyMap<string, TaskSource[]>;
  /** 已持久化的 describe 原始响应（先持久化再解析的纪律由调用方保证）。 */
  describeRaw: string;
  /** 已持久化的 judge 原始响应；describe 截断时为 null。 */
  judgeRaw: string | null;
  describeTruncated: boolean;
  judgeTruncated: boolean;
  parserVersion: string;
}

export interface BatchMemberExtraction {
  taskKey: string;
  taskAlias: string;
  /** derived=已按现有规则推导出终态事实（可提交性由 result.outcome 决定）；
   *  truncated=provider 明确截断；parse_failed=协议违例（走现有硬失败/重试语义）。 */
  status: "derived" | "truncated" | "parse_failed";
  result?: BehaviorTaskExtractionResult;
  reason?: string;
  diagnostics?: string[];
}

export interface BatchExtractionOutcome {
  results: BatchMemberExtraction[];
  /** 同一原始响应 + 同一 parser 版本 → 同一指纹（重放幂等，§20.2 T/R 兼容契约）。 */
  resultFingerprint: string;
}

function requireTask(input: ExtractBatchInput, member: BatchProtocolMember): BehaviorExecutionTask {
  const task = input.taskByTaskKey.get(member.taskKey);
  if (!task) throw new BatchProtocolError(`成员 ${member.taskAlias} 缺少任务定义（${member.taskKey}）`);
  return task;
}

function truncatedForAll(input: ExtractBatchInput, reason: string): BatchExtractionOutcome {
  const results = input.members.map((member) => ({
    taskKey: member.taskKey,
    taskAlias: member.taskAlias,
    status: "truncated" as const,
    result: behaviorTaskTruncatedResult(requireTask(input, member)),
    reason,
  }));
  return { results, resultFingerprint: batchFingerprint(results) };
}

export function extractBehaviorBatch(input: ExtractBatchInput): BatchExtractionOutcome {
  if (input.describeTruncated) {
    return truncatedForAll(input, "describe finish_reason=length：整批不进入 judge，全部成员 output_truncated");
  }
  // judge 原始响应无论是否截断都必须已持久化（调用方纪律）；截断时保留响应、不解析成功
  parseBatchDescribeContent(input.describeRaw, input.members);
  if (input.judgeRaw === null) {
    throw new BatchProtocolError("batch judge 原始响应缺失且 describe 未截断——调用方纪律违例");
  }
  if (input.judgeTruncated) {
    return truncatedForAll(input, "judge finish_reason=length：无法证明截断只影响某个 task，全部成员 output_truncated");
  }
  const judgeResults = parseBatchJudgeContent(input.judgeRaw, input.members);
  const judgeByAlias = new Map(judgeResults.map((result) => [result.taskAlias, result]));
  const describeByAlias = new Map(parseBatchDescribeContent(input.describeRaw, input.members).map((result) => [result.taskAlias, result]));
  const results: BatchMemberExtraction[] = [];
  for (const member of input.members) {
    const task = requireTask(input, member);
    const sources = input.sourcesByTaskKey.get(member.taskKey) ?? [];
    const judgeResult = judgeByAlias.get(member.taskAlias)!;
    if (judgeResult.status === "missing_task" || judgeResult.status === "missing_region") {
      // 缺整个 task / 缺 region：以空/部分判定进入现有推导 → 未决输入，绝不 no_behavior
      const judged = judgeResult.payload ?? { regions: [], features: [] };
      const derived = deriveBehaviorTaskResult(task, sources, judged, `batch:${member.taskAlias}`);
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "derived",
        result: derived,
        reason: judgeResult.message,
        diagnostics: judgeResult.diagnostics,
      });
      continue;
    }
    if (judgeResult.status !== "ok") {
      // duplicate_task / duplicate_region / payload_invalid：协议违例，成员走现有硬失败/重试语义
      results.push({
        taskKey: member.taskKey,
        taskAlias: member.taskAlias,
        status: "parse_failed",
        reason: judgeResult.message,
        diagnostics: judgeResult.diagnostics,
      });
      continue;
    }
    const derived = deriveBehaviorTaskResult(task, sources, judgeResult.payload!, `batch:${member.taskAlias}`);
    const describeResult = describeByAlias.get(member.taskAlias);
    const reason =
      describeResult && describeResult.status !== "ok"
        ? `describe 异常（${describeResult.status}）：按单任务规则直接依据源码判定`
        : undefined;
    results.push({
      taskKey: member.taskKey,
      taskAlias: member.taskAlias,
      status: "derived",
      result: derived,
      reason,
      diagnostics: judgeResult.diagnostics,
    });
  }
  return { results, resultFingerprint: batchFingerprint(results) };
}

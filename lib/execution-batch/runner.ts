import { randomUUID } from "node:crypto";
import { defaultExecute } from "../db";
import type { TaskSource } from "../behavior-inventory/planner";
import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import type { OutputLanguage } from "../analysis-language";
import { requestStructuredCompletionDetailed, type LlmBillingContext, type StructuredCompletionDetails } from "../ai";
import { releaseUnusedBehaviorBudget, reserveBehaviorBudget, settleBehaviorBudget } from "../behavior-run-budget";
import { BEHAVIOR_TASK_RESERVED_COST_AMOUNT, BEHAVIOR_TASK_RESERVED_INPUT_TOKENS, BEHAVIOR_TASK_RESERVED_OUTPUT_TOKENS } from "../full-analysis";
import { claimBehaviorTask, commitBehaviorTaskResult, markBehaviorTaskFailure, renewBehaviorTaskLease } from "../behavior-unit-receipts";
import { extractBehaviorTask, type BehaviorTaskExtractionResult } from "../behavior-unit-extraction";
import {
  acquireBatchAttemptProcessing,
  claimBatchAttemptMember,
  createBatchAttempt,
  freezeBatchAttemptMembers,
  loadBatchAttemptForRecovery,
  transitionBatchAttempt,
} from "./attempts";
import { batchFingerprint, makeBatchRequestKey, sha256Utf8 } from "./identity";
import { loadReadyBehaviorBatchAllocation, ExecutionBatchError } from "./plans";
import {
  beginBatchRequest,
  loadPersistedBatchResponses,
  markBatchRequestDispatchStarted,
  markBatchRequestOutcome,
  persistBatchResponse,
} from "./requests";
import { buildBatchDescribePrompt, buildBatchJudgePrompt, parseBatchDescribeContent, type BatchProtocolMember } from "./protocol";
import { buildBatchFusedPrompt, parseBatchFusedContent } from "./fused-protocol";
import { extractBehaviorBatch } from "./extraction";
import { BATCH_PARSER_VERSION, type BatchChatMessage, type BatchExecutionAllocation, type BatchPlan } from "./types";

/**
 * 主编排（§13/§15 / Task 8）：batch 计划执行 = 预算预留（先于 claim）→ attempt/逐 task claim →
 * 冻结 → describe/judge 双步（请求身份 + 原始响应持久化 + 读回校验）→ 按真实回执结算 →
 * 拆分/独立提交/单 task repair（三身份分离）。恢复优先消费已持久化响应：describe_persisted
 * 只补 judge；judge_persisted/splitting 零模型调用完成拆分提交。本模块不触碰聚合与激活。
 */

export const BATCH_RESERVED_MAX_OUTPUT_TOKENS = 32_000; // describe 16k + judge 16k（与 ai.ts max_tokens 对齐）

/** Task 13 提取模式：describe_judge（双步，默认）| fused（单步实验，显式 flag 才进入）。 */
export function behaviorBatchExtractionMode(): "describe_judge" | "fused" {
  const raw = (process.env.ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE ?? "").trim();
  if (raw === "fused") return "fused";
  return "describe_judge";
}
const BATCH_PROTOCOL_OVERHEAD_INPUT_TOKENS = 16_000;

/** §14.2：预留覆盖本 attempt 最大账务暴露（judge 输入含 describe 最大输出回显）。 */
export function batchReservationUpperBound(plan: BatchPlan): {
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostAmount: number;
} {
  const describeInput = Math.max(1, plan.inputBudgetSnapshot.estimatedInputTokens);
  const judgeInput = describeInput + BATCH_RESERVED_MAX_OUTPUT_TOKENS + BATCH_PROTOCOL_OVERHEAD_INPUT_TOKENS;
  return {
    maxLlmCalls: 2,
    maxInputTokens: describeInput + judgeInput,
    maxOutputTokens: BATCH_RESERVED_MAX_OUTPUT_TOKENS,
    maxCostAmount: BEHAVIOR_TASK_RESERVED_COST_AMOUNT * 2,
  };
}

export interface BatchWorkItem {
  plan: BatchPlan;
  tasks: BehaviorExecutionTask[];
}

/** 按 ready allocation 把 manifest 任务分为 batch 计划与 fallback 单任务——不重算路由。 */
export function routeBatchWorkItems(
  manifestTasks: readonly BehaviorExecutionTask[],
  allocation: BatchExecutionAllocation,
): { batchWork: BatchWorkItem[]; fallbackTasks: BehaviorExecutionTask[] } {
  const byKey = new Map(manifestTasks.map((task) => [task.taskKey, task]));
  const batchWork: BatchWorkItem[] = [];
  for (const plan of allocation.batchPlans) {
    const tasks = plan.orderedTaskKeys.map((key) => byKey.get(key)).filter((task): task is BehaviorExecutionTask => task !== undefined);
    batchWork.push({ plan, tasks });
  }
  const fallbackTasks = allocation.fallbackAssignments
    .map((assignment) => byKey.get(assignment.taskKey))
    .filter((task): task is BehaviorExecutionTask => task !== undefined);
  return { batchWork, fallbackTasks };
}

/** 双路径共享的运行配置。 */
export interface AttemptRunConfig {
  runId: number;
  accountId: number | null;
  manifestHash: string;
  chargeComponent: "main" | "platform_shadow";
  leaseOwner: string;
  leaseDurationMs: number;
  maxAttempts: number;
  loadSources: (task: BehaviorExecutionTask) => Promise<TaskSource[]>;
  knownFeatureNames?: string[];
  knownUnitKeys?: string[];
  outputLanguage?: OutputLanguage;
  /** 测试接缝：主批 describe/judge 派发替换（生产走 requestStructuredCompletionDetailed）。 */
  dispatchDetailed?: (messages: BatchChatMessage[], billing: LlmBillingContext) => Promise<StructuredCompletionDetails>;
}

export interface RunBatchAttemptInput extends AttemptRunConfig {
  batchKey: string;
  plan: BatchPlan;
  tasks: ReadonlyArray<BehaviorExecutionTask>;
  /** Task 13：describe_judge（双步默认）| fused（单步实验）。 */
  extractionMode?: "describe_judge" | "fused";
}

interface RunnerContext {
  runId: number;
  batchAttemptUuid: string;
  processingOwner: string;
  version: number;
}

interface ClaimedMember {
  member: BatchProtocolMember;
  task: BehaviorExecutionTask;
  requestTaskAttemptId: string;
}

function billingFor(context: RunnerContext, stage: "describe" | "judge", config: AttemptRunConfig, requestKey: string, requestFingerprint: string): LlmBillingContext {
  return {
    runId: config.runId,
    accountId: config.accountId,
    chargeComponent: config.chargeComponent,
    callKind: "batch",
    // LLM 计费身份 = batch attempt（settle 按预留聚合全部真实回执）；member.request_task_attempt_id 只做审计
    attemptId: context.batchAttemptUuid,
    callStage: stage,
    requestKey,
    requestFingerprint,
  };
}

async function safeSettle(reservationId: string): Promise<void> {
  try {
    await settleBehaviorBudget({ reservationId });
  } catch (error) {
    if ((error as { code?: string }).code === "behavior_budget_usage_unknown") {
      // 硬上限配置下 usage unknown：预算侧已 fail closed，编排层据此停止派发
      console.warn("[execution-batch] reservation settled with unknown usage", { reservationId });
      return;
    }
    throw error;
  }
}

/** 双步派发公共体：prepared → dispatch_started → 派发 → 持久化（读回校验）→ 状态推进。
 *  派发异常一律 outcome_unknown（不得反推未发送/零费用，§14.3）并终态化 attempt。 */
async function dispatchStage(
  context: RunnerContext,
  config: AttemptRunConfig,
  stage: "describe" | "judge",
  sequence: number,
  requestFingerprint: string,
  messages: BatchChatMessage[],
  describeResponseHash: string | null,
  dispatch: (messages: BatchChatMessage[], billing: LlmBillingContext) => Promise<StructuredCompletionDetails>,
): Promise<{ content: string; finishReason: string | null; reservationUuid: string }> {
  await transitionBatchAttempt({
    runId: config.runId,
    batchAttemptUuid: context.batchAttemptUuid,
    to: stage === "describe" ? "describe_requesting" : "judge_requesting",
    processingOwner: context.processingOwner,
    expectedVersion: context.version,
  });
  context.version += 1;
  const requestKey = makeBatchRequestKey({ batchAttemptUuid: context.batchAttemptUuid, stage, sequence });
  await beginBatchRequest(defaultExecute, {
    runId: config.runId,
    batchAttemptUuid: context.batchAttemptUuid,
    requestStage: stage,
    requestSequence: sequence,
    requestFingerprint,
    describeResponseHash,
  });
  await markBatchRequestDispatchStarted(defaultExecute, requestKey);
  let details: StructuredCompletionDetails;
  try {
    details = await dispatch(messages, billingFor(context, stage, config, requestKey, requestFingerprint));
  } catch (error) {
    await markBatchRequestOutcome(defaultExecute, { requestKey, outcome: "outcome_unknown" }).catch(() => undefined);
    const attempt = await transitionBatchAttempt({
      runId: config.runId,
      batchAttemptUuid: context.batchAttemptUuid,
      to: "request_outcome_unknown",
      processingOwner: context.processingOwner,
      expectedVersion: context.version,
      terminalRequestKey: requestKey,
    });
    context.version = attempt.version;
    const recovery = await loadBatchAttemptForRecovery({ runId: config.runId, batchAttemptUuid: context.batchAttemptUuid });
    await safeSettle(recovery.attempt.reservationUuid);
    throw error;
  }
  await persistBatchResponse(defaultExecute, {
    requestKey,
    rawResponse: details.content,
    providerRequestId: details.providerRequestId,
    providerFinishReason: details.finishReason,
  });
  const attempt = await transitionBatchAttempt({
    runId: config.runId,
    batchAttemptUuid: context.batchAttemptUuid,
    to: stage === "describe" ? "describe_persisted" : "judge_persisted",
    processingOwner: context.processingOwner,
    expectedVersion: context.version,
  });
  context.version = attempt.version;
  const recovery = await loadBatchAttemptForRecovery({ runId: config.runId, batchAttemptUuid: context.batchAttemptUuid });
  return { content: details.content, finishReason: details.finishReason, reservationUuid: recovery.attempt.reservationUuid };
}

/** 提交成员结果：先按 claim 时的 task attempt 提交；stale → 按现有协议重新 claim 取得新提交
 *  资格后再提交（不重取模型响应，§14.1）。 */
async function commitMemberResult(
  config: AttemptRunConfig,
  member: BatchProtocolMember,
  requestTaskAttemptId: string,
  result: BehaviorTaskExtractionResult,
): Promise<boolean> {
  const firstTry = await commitBehaviorTaskResult({
    execute: defaultExecute,
    runId: config.runId,
    taskKey: member.taskKey,
    attemptId: requestTaskAttemptId,
    leaseOwner: config.leaseOwner,
    outcome: result.outcome,
    result,
    scenarioCount: result.scenarioCount,
    reviewedCount: result.reviewedCount,
    unresolvedAnchorCount: result.unresolvedAnchorCount,
  });
  if (firstTry) return true;
  const reclaimed = await claimBehaviorTask({
    execute: defaultExecute,
    runId: config.runId,
    taskKey: member.taskKey,
    leaseOwner: config.leaseOwner,
    leaseDurationMs: config.leaseDurationMs,
    maxAttempts: config.maxAttempts,
  });
  if (!reclaimed) return false;
  return commitBehaviorTaskResult({
    execute: defaultExecute,
    runId: config.runId,
    taskKey: member.taskKey,
    attemptId: reclaimed.attemptId,
    leaseOwner: config.leaseOwner,
    outcome: result.outcome,
    result,
    scenarioCount: result.scenarioCount,
    reviewedCount: result.reviewedCount,
    unresolvedAnchorCount: result.unresolvedAnchorCount,
  });
}

async function loadSourcesFor(config: AttemptRunConfig, claimed: ReadonlyArray<ClaimedMember>): Promise<Map<string, TaskSource[]>> {
  const map = new Map<string, TaskSource[]>();
  for (const entry of claimed) {
    map.set(entry.member.taskKey, await config.loadSources(entry.task));
  }
  return map;
}

function protocolAliases(task: BehaviorExecutionTask): Array<{ anchorFragmentKey: string; regionAlias: string }> {
  // 与 planner 的 R 别名同构（R1..Rn 按 anchorFragments 原序）
  return task.anchorFragments.map((fragment, index) => ({ anchorFragmentKey: fragment.anchorFragmentKey, regionAlias: `R${index + 1}` }));
}

export type RepairTriggerClass = "format_or_parse" | "evidence_or_contract" | "model_capacity";

function classifyRepairTrigger(unresolvedReasons: readonly string[], parseFailureReason: string | undefined): RepairTriggerClass {
  if (parseFailureReason !== undefined) return "format_or_parse";
  const joined = unresolvedReasons.join(" ");
  if (unresolvedReasons.some((reason) => reason === "output_truncated")) return "format_or_parse";
  if (/missing|缺少|unknown|未知|drift/i.test(joined)) return "format_or_parse";
  if (/evidence|allow|sanitize|归属|attribution/i.test(joined)) return "evidence_or_contract";
  return "model_capacity";
}

async function runSplitAndCommit(
  config: AttemptRunConfig,
  context: RunnerContext,
  claimedMembers: ReadonlyArray<ClaimedMember>,
  describeRaw: string,
  judgeRaw: string | null,
  describeTruncated: boolean,
  judgeTruncated: boolean,
  descriptions: ReadonlyMap<string, import("../behavior-unit-ai").BehaviorRegionDescription[]>,
  repairClassCounts: Record<RepairTriggerClass, number>,
): Promise<void> {
  const extraction = extractBehaviorBatch({
    members: claimedMembers.map((entry) => entry.member),
    taskByTaskKey: new Map(claimedMembers.map((entry) => [entry.member.taskKey, entry.task])),
    sourcesByTaskKey: await loadSourcesFor(config, claimedMembers),
    describeRaw,
    judgeRaw,
    describeTruncated,
    judgeTruncated,
    parserVersion: BATCH_PARSER_VERSION,
  });
  const splitting = await transitionBatchAttempt({
    runId: config.runId,
    batchAttemptUuid: context.batchAttemptUuid,
    to: "splitting",
    processingOwner: context.processingOwner,
    expectedVersion: context.version,
  });
  context.version = splitting.version;
  for (const memberResult of extraction.results) {
    const entry = claimedMembers.find((candidate) => candidate.member.taskKey === memberResult.taskKey);
    if (!entry) continue;
    if (memberResult.status === "parse_failed") {
      // 协议违例：现有硬失败语义（消耗 attempt；重试由恢复/编排决定）
      await markBehaviorTaskFailure({
        execute: defaultExecute,
        runId: config.runId,
        taskKey: memberResult.taskKey,
        attemptId: entry.requestTaskAttemptId,
        leaseOwner: config.leaseOwner,
        error: memberResult.reason ?? "batch parse failed",
      });
      continue;
    }
    const result = memberResult.result!;
    if (result.outcome === "unresolved" && !describeTruncated && !judgeTruncated) {
      // repair 触发原因三类分别统计（用户裁决：区分格式/解析问题、模型能力不足、契约/校验失败，
      // 不为速度降低质量也不把 repair 混为纯缺陷）：
      //   format_or_parse = 批协议层问题（缺区域结论/别名错/JSON 结构）——batch 特有，可修；
      //   evidence_or_contract = 证据越界/契约校验未过（sanitize 拒绝/场景缺归属）——质量守卫触发；
      //   model_capacity = 模型判定本身未完成（无结论/内部推理不足）——模型工作量问题。
      const unresolvedReasons = result.anchorReceipts
        .filter((receipt) => receipt.disposition === "unresolved")
        .map((receipt) => String((receipt as { reason?: string }).reason ?? ""));
      const repairClass = classifyRepairTrigger(unresolvedReasons, memberResult.reason);
      repairClassCounts[repairClass] = (repairClassCounts[repairClass] ?? 0) + 1;
      // 单 task 语义复核（§15）：task_attempt_id（提交）/ repair_budget_attempt_id（预算聚合）/
      // repair_request_key（实际请求）三身份分离；repair 崩溃可按现有单任务语义重发
      const repairBudgetAttemptId = randomUUID();
      const repairReservation = await reserveBehaviorBudget({
        runId: config.runId,
        attemptId: repairBudgetAttemptId,
        kind: "task_repair",
        maxLlmCalls: 1,
        maxInputTokens: BEHAVIOR_TASK_RESERVED_INPUT_TOKENS,
        maxOutputTokens: BEHAVIOR_TASK_RESERVED_OUTPUT_TOKENS,
        maxCostAmount: BEHAVIOR_TASK_RESERVED_COST_AMOUNT,
      });
      const repairRequestKey = `${repairBudgetAttemptId}|judge|1`;
      try {
        const repaired = await extractBehaviorTask({
          task: entry.task,
          sources: await config.loadSources(entry.task),
          billing: {
            runId: config.runId,
            accountId: config.accountId,
            chargeComponent: config.chargeComponent,
            callKind: "task_repair",
            taskKey: memberResult.taskKey,
            unitKey: entry.task.unitKey,
            attemptId: repairBudgetAttemptId,
            callStage: "judge",
            requestKey: repairRequestKey,
            requestFingerprint: sha256Utf8(`${repairRequestKey}|${describeRaw}`),
          },
          knownFeatureNames: config.knownFeatureNames,
          knownUnitKeys: config.knownUnitKeys,
          outputLanguage: config.outputLanguage,
          label: `batch-repair/${config.runId}/${memberResult.taskKey.slice(0, 48)}`,
          repair: { previous: result },
        });
        await commitMemberResult(config, entry.member, entry.requestTaskAttemptId, repaired);
      } catch (error) {
        // repair 崩溃/失败：成员级硬失败（现有语义，消耗 attempt 且保持可恢复）；
        // attempt 继续完成拆分——绝不重复主批 describe/judge
        await markBehaviorTaskFailure({
          execute: defaultExecute,
          runId: config.runId,
          taskKey: memberResult.taskKey,
          attemptId: entry.requestTaskAttemptId,
          leaseOwner: config.leaseOwner,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await safeSettle(repairReservation.reservationId);
      }
      continue;
    }
    await commitMemberResult(config, entry.member, entry.requestTaskAttemptId, result);
  }
  const done = await transitionBatchAttempt({
    runId: config.runId,
    batchAttemptUuid: context.batchAttemptUuid,
    to: "split_done",
    processingOwner: context.processingOwner,
    expectedVersion: context.version,
  });
  context.version = done.version;
}

/** 双步主批执行（§13）。零 claim → aborted + 释放预留；派发失败 → 终态 + 按真实回执结算；
 *  成功路径结算后拆分/独立提交/repair。 */
export async function runInventoryBatchAttempt(input: RunBatchAttemptInput): Promise<void> {
  if (input.extractionMode !== undefined && input.extractionMode !== "describe_judge" && input.extractionMode !== "fused") {
    throw new Error(`unsupported batch extraction mode: ${String(input.extractionMode)}`);
  }
  const taskByKey = new Map(input.tasks.map((task) => [task.taskKey, task]));
  // ① 预算预留先于任何 claim（attemptId = batch attempt uuid，§14.2）
  const batchAttemptUuid = randomUUID();
  const reservation = await reserveBehaviorBudget({
    runId: input.runId,
    attemptId: batchAttemptUuid,
    kind: "batch",
    ...batchReservationUpperBound(input.plan),
  });
  // ② claiming attempt（成员冻结前可恢复领取）
  const attempt = await createBatchAttempt({
    runId: input.runId,
    batchAttemptUuid,
    batchKey: input.batchKey,
    reservationUuid: reservation.reservationId,
    modelConfigFingerprint: "runtime",
  });
  const context: RunnerContext = { runId: input.runId, batchAttemptUuid, processingOwner: input.leaseOwner, version: attempt.version };
  // ③ 逐 task claim + member insert（同事务；部分 claim 合法，T 别名继承 plan）
  const claimed: ClaimedMember[] = [];
  for (const taskKey of input.plan.orderedTaskKeys) {
    const task = taskByKey.get(taskKey);
    if (!task) throw new ExecutionBatchError("execution_batch_allocation_mismatch", `plan 成员 ${taskKey} 不在任务清单中`);
    const result = await claimBatchAttemptMember({
      runId: input.runId,
      batchAttemptUuid,
      taskKey,
      taskAlias: input.plan.taskAliasMap[taskKey] ?? "T?",
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs,
      maxAttempts: input.maxAttempts,
    });
    if (result) {
      claimed.push({ member: { taskKey, taskAlias: input.plan.taskAliasMap[taskKey] ?? "T?", orderedRegionAliases: protocolAliases(task) }, task, requestTaskAttemptId: result.attemptId });
    }
  }
  if (claimed.length === 0) {
    // 零 claim：aborted + 释放未使用预留，零模型请求（§13.5）
    const grant = await acquireBatchAttemptProcessing({ runId: input.runId, batchAttemptUuid, processingOwner: input.leaseOwner, leaseDurationMs: input.leaseDurationMs });
    await transitionBatchAttempt({ runId: input.runId, batchAttemptUuid, to: "aborted", processingOwner: grant.processingOwner, expectedVersion: grant.version });
    await releaseUnusedBehaviorBudget(reservation.reservationId);
    return;
  }
  // ④ 冻结成员与全部 T/R 映射
  await freezeBatchAttemptMembers({ runId: input.runId, batchAttemptUuid });
  const grant = await acquireBatchAttemptProcessing({ runId: input.runId, batchAttemptUuid, processingOwner: input.leaseOwner, leaseDurationMs: input.leaseDurationMs });
  context.processingOwner = grant.processingOwner;
  context.version = grant.version;
  // ④' 不可变源码快照（§23.6 正确性价值）：同一 attempt 的 describe/judge/extraction 共享
  // 同一份源码，避免三次读取间源码漂移导致各阶段实际基于不同输入；同时消除重复 I/O。
  const sourceSnapshot = new Map<string, TaskSource[]>();
  const cachedLoadSources = async (task: BehaviorExecutionTask): Promise<TaskSource[]> => {
    const cached = sourceSnapshot.get(task.taskKey);
    if (cached) return cached;
    const loaded = await input.loadSources(task);
    sourceSnapshot.set(task.taskKey, loaded);
    return loaded;
  };
  const snapshotInput: RunBatchAttemptInput = { ...input, loadSources: cachedLoadSources };
  // ⑤ 参与任务心跳：batch heartbeat 是协调操作，实际续租的是每个参与 task（§14.1）
  const claimedProtocolMembers = claimed.map((entry) => entry.member);
  const heartbeat = setInterval(() => {
    for (const entry of claimed) {
      void renewBehaviorTaskLease({
        execute: defaultExecute,
        runId: input.runId,
        taskKey: entry.member.taskKey,
        attemptId: entry.requestTaskAttemptId,
        leaseOwner: input.leaseOwner,
        leaseDurationMs: input.leaseDurationMs,
      }).catch(() => undefined);
    }
  }, Math.max(1, Math.floor(input.leaseDurationMs / 3)));
  try {
    if (input.extractionMode === "fused") {
      // Task 13 fused：单次调用同时完成事实陈述与判定（§15 边界：合并模型调用，
      // 不合并质量职责——解析/校验/推导/repair 语义原样复用）
      const fusedFingerprint = batchFingerprint({
        kind: "batch_fused_request",
        manifest_hash: input.manifestHash,
        batch_key: input.batchKey,
        batch_attempt_uuid: batchAttemptUuid,
        members: claimedProtocolMembers,
        prompt_version: BATCH_PARSER_VERSION,
      });
      const fused = await dispatchStage(
        context,
        input,
        "judge",
        1,
        fusedFingerprint,
        buildBatchFusedPrompt({
          members: claimedProtocolMembers,
          taskByTaskKey: taskByKey,
          sourcesByTaskKey: await loadSourcesFor(snapshotInput, claimed),
          knownFeatureNames: input.knownFeatureNames,
          knownUnitKeys: input.knownUnitKeys,
          language: input.outputLanguage,
        }),
        null,
        input.dispatchDetailed ?? ((messages, billing) => requestStructuredCompletionDetailed(messages, billing)),
      );
      // fused 单次调用结束即结算（同双步：按真实回执结算后再拆分）
      await safeSettle(fused.reservationUuid);
      const repairClassCounts: Record<RepairTriggerClass, number> = { format_or_parse: 0, evidence_or_contract: 0, model_capacity: 0 };
      await runSplitAndCommit(snapshotInput, context, claimed, fused.content, fused.content, fused.finishReason === "length", fused.finishReason === "length", new Map(), repairClassCounts);
      console.log("[execution-batch] fused repair classes", JSON.stringify(repairClassCounts));
      return;
    }
    // ⑥ describe
    const describeFingerprint = batchFingerprint({
      kind: "batch_describe_request",
      manifest_hash: input.manifestHash,
      batch_key: input.batchKey,
      batch_attempt_uuid: batchAttemptUuid,
      members: claimedProtocolMembers,
      prompt_version: BATCH_PARSER_VERSION,
    });
    const describe = await dispatchStage(
      context,
      input,
      "describe",
      1,
      describeFingerprint,
      buildBatchDescribePrompt({
        members: claimedProtocolMembers,
        taskByTaskKey: taskByKey,
        sourcesByTaskKey: await loadSourcesFor(snapshotInput, claimed),
        language: input.outputLanguage,
      }),
      null,
      input.dispatchDetailed ?? ((messages, billing) => requestStructuredCompletionDetailed(messages, billing)),
    );
    const describeTruncated = describe.finishReason === "length";
    const describeResponseHash = sha256Utf8(describe.content);
    // ⑦ judge（成员/映射与 describe 完全一致；指纹绑定 describe 响应 hash）
    let judgeContent: string | null = null;
    let judgeTruncated = false;
    if (!describeTruncated) {
      const judgeFingerprint = batchFingerprint({
        kind: "batch_judge_request",
        manifest_hash: input.manifestHash,
        batch_key: input.batchKey,
        batch_attempt_uuid: batchAttemptUuid,
        members: claimedProtocolMembers,
        describe_response_hash: describeResponseHash,
        prompt_version: BATCH_PARSER_VERSION,
      });
      const descriptions = new Map<string, import("../behavior-unit-ai").BehaviorRegionDescription[]>();
      for (const parsed of parseBatchDescribeContent(describe.content, claimedProtocolMembers)) {
        if (parsed.taskKey !== null && parsed.payload) descriptions.set(parsed.taskKey, parsed.payload);
      }
      const judge = await dispatchStage(
        context,
        input,
        "judge",
        1,
        judgeFingerprint,
        buildBatchJudgePrompt({
          members: claimedProtocolMembers,
          taskByTaskKey: taskByKey,
          sourcesByTaskKey: await loadSourcesFor(snapshotInput, claimed),
          describeResponseHash,
          descriptionsByTaskKey: descriptions,
          knownFeatureNames: input.knownFeatureNames,
          knownUnitKeys: input.knownUnitKeys,
          language: input.outputLanguage,
        }),
        describeResponseHash,
        input.dispatchDetailed ?? ((messages, billing) => requestStructuredCompletionDetailed(messages, billing)),
      );
      judgeContent = judge.content;
      judgeTruncated = judge.finishReason === "length";
    }
    // ⑧ 主批调用结束：按 batch attempt 全部真实回执结算（含失败/unknown）
    await safeSettle(describe.reservationUuid);
    // ⑨⑩ 拆分 / 独立提交 / repair
    const repairClassCounts: Record<RepairTriggerClass, number> = { format_or_parse: 0, evidence_or_contract: 0, model_capacity: 0 };
    await runSplitAndCommit(snapshotInput, context, claimed, describe.content, judgeContent, describeTruncated, judgeTruncated, new Map(), repairClassCounts);
    console.log("[execution-batch] repair classes", JSON.stringify(repairClassCounts));
  } finally {
    clearInterval(heartbeat);
  }
}

export interface RecoverBatchAttemptsInput extends AttemptRunConfig {
  /** manifest 任务清单（路由 batch plan 成员用）。 */
  tasks: ReadonlyArray<BehaviorExecutionTask>;
}

/** 恢复（§16）：先消费已持久化响应——describe_persisted 只补 judge；judge_persisted/splitting
 *  零模型调用完成拆分提交。request_outcome_unknown/request_failed 等终态不由本函数重试
 *  （对账后由编排层创建新 attempt）。 */
export async function recoverInventoryBatchAttempts(config: RecoverBatchAttemptsInput): Promise<void> {
  const allocation = await loadReadyBehaviorBatchAllocation(defaultExecute, config.runId).catch(() => null);
  if (!allocation) return;
  const { batchWork } = routeBatchWorkItems(config.tasks, allocation);
  for (const work of batchWork) {
    const resumable = await loadResumableAttempt(config.runId, work.plan.batchKey);
    if (!resumable) continue;
    const taskByKey = new Map(work.tasks.map((task) => [task.taskKey, task]));
    const recovery = await loadBatchAttemptForRecovery({ runId: config.runId, batchAttemptUuid: resumable.batchAttemptUuid });
  const recoveryRepairCounts: Record<RepairTriggerClass, number> = { format_or_parse: 0, evidence_or_contract: 0, model_capacity: 0 };
    const claimedProtocolMembers = recovery.members.map((member) => ({ taskKey: member.taskKey, taskAlias: member.taskAlias, orderedRegionAliases: member.orderedRegionAliases }));
    const persisted = await loadPersistedBatchResponses(resumable.batchAttemptUuid);
    if (!persisted.describe) continue;
    const grant = await acquireBatchAttemptProcessing({
      runId: config.runId,
      batchAttemptUuid: resumable.batchAttemptUuid,
      processingOwner: config.leaseOwner,
      leaseDurationMs: config.leaseDurationMs,
    });
    const context: RunnerContext = { runId: config.runId, batchAttemptUuid: resumable.batchAttemptUuid, processingOwner: grant.processingOwner, version: grant.version };
    const describeTruncated = persisted.describe.providerFinishReason === "length";
    const describeResponseHash = sha256Utf8(persisted.describe.rawResponse);
    let judgeContent: string | null = persisted.judge?.rawResponse ?? null;
    let judgeTruncated = persisted.judge?.providerFinishReason === "length";
    if (resumable.phase === "describe_persisted" && !describeTruncated) {
      const descriptions = new Map<string, import("../behavior-unit-ai").BehaviorRegionDescription[]>();
      for (const parsed of parseBatchDescribeContent(persisted.describe.rawResponse, claimedProtocolMembers)) {
        if (parsed.taskKey !== null && parsed.payload) descriptions.set(parsed.taskKey, parsed.payload);
      }
      const judgeFingerprint = batchFingerprint({
        kind: "batch_judge_request",
        manifest_hash: config.manifestHash,
        batch_key: work.plan.batchKey,
        batch_attempt_uuid: resumable.batchAttemptUuid,
        members: claimedProtocolMembers,
        describe_response_hash: describeResponseHash,
        prompt_version: BATCH_PARSER_VERSION,
      });
      const judge = await dispatchStage(
        context,
        config,
        "judge",
        1,
        judgeFingerprint,
        buildBatchJudgePrompt({
          members: claimedProtocolMembers,
          taskByTaskKey: taskByKey,
          sourcesByTaskKey: await loadSourcesForRecovery(config, recovery.members, taskByKey),
          describeResponseHash,
          descriptionsByTaskKey: descriptions,
          knownFeatureNames: config.knownFeatureNames,
          knownUnitKeys: config.knownUnitKeys,
          language: config.outputLanguage,
        }),
        describeResponseHash,
        config.dispatchDetailed ?? ((messages, billing) => requestStructuredCompletionDetailed(messages, billing)),
      );
      judgeContent = judge.content;
      judgeTruncated = judge.finishReason === "length";
    }
    await runSplitAndCommit(config, context, recovery.members.map((member) => ({
      member: { taskKey: member.taskKey, taskAlias: member.taskAlias, orderedRegionAliases: member.orderedRegionAliases },
      task: taskByKey.get(member.taskKey)!,
      requestTaskAttemptId: member.requestTaskAttemptId,
    })).filter((entry) => entry.task !== undefined), persisted.describe.rawResponse, judgeContent, describeTruncated, judgeTruncated, new Map(), recoveryRepairCounts);
  }
}

async function loadSourcesForRecovery(
  config: AttemptRunConfig,
  members: ReadonlyArray<{ taskKey: string }>,
  taskByKey: ReadonlyMap<string, BehaviorExecutionTask>,
): Promise<Map<string, TaskSource[]>> {
  const map = new Map<string, TaskSource[]>();
  for (const member of members) {
    const task = taskByKey.get(member.taskKey);
    if (task) map.set(member.taskKey, await config.loadSources(task));
  }
  return map;
}

async function loadResumableAttempt(runId: number, batchKey: string): Promise<{ batchAttemptUuid: string; phase: string } | null> {
  const { getDb } = await import("../db");
  const [rows] = (await getDb().execute(
    `SELECT batch_attempt_uuid, execution_phase FROM analysis_behavior_batch_attempts
      WHERE run_id = ? AND batch_key = ? AND execution_phase IN ('describe_persisted', 'judge_persisted', 'splitting')
      ORDER BY id DESC LIMIT 1`,
    [runId, batchKey],
  )) as [Array<Record<string, unknown>>, unknown];
  const row = rows[0];
  return row ? { batchAttemptUuid: String(row.batch_attempt_uuid), phase: String(row.execution_phase) } : null;
}

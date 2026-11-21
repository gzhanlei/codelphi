/**
 * Execution batch 冻结契约类型（docs/superpowers/specs/2026-11-21-execution-batch-design.md §23）。
 * 四层责任模型：plan（规划真源）/ attempt（执行记录）/ task row（结果真源，见 analysis_behavior_tasks）/
 * reservation & receipt（账务真源）。batch 不参与覆盖核算，也不是激活门禁单位。
 */

export const BATCH_PLANNER_VERSION = "1";
export const BATCH_PROMPT_VERSION = "1";
export const BATCH_SCHEMA_VERSION = "1";
export const BATCH_PARSER_VERSION = "1";
/** 协议最大响应字节数：必须小于 MEDIUMTEXT 容量与实际数据库写入限制（§23.8）。 */
export const MAX_BATCH_RESPONSE_BYTES = 4_000_000;

export type BatchRequestStage = "describe" | "judge";

/** 请求生命周期八态（§8.3 / §23.3 C3.1）：prepared 不证明已发送；dispatch 后无响应不得反推未发送。 */
export type BatchRequestOutcome =
  | "prepared"
  | "dispatch_started"
  | "response_received"
  | "response_persisted"
  | "confirmed_not_sent"
  | "failed"
  | "outcome_unknown"
  | "persistence_failed";

/** failed 行必填的费用判定分类（§23.3 C3.2）：仅 HTTP 429/5xx 状态码不构成 provider_rejected 证据。 */
export type BatchFailureClass =
  | "local_pre_dispatch"
  | "provider_rejected"
  | "provider_execution_failed"
  | "transport_failure";

/** attempt 执行阶段（§9.1）：正常链单向推进；五个异常终态；split_done 是执行终态（≠全部 task 成功）。 */
export type BatchExecutionPhase =
  | "claiming"
  | "describe_requesting"
  | "describe_persisted"
  | "judge_requesting"
  | "judge_persisted"
  | "splitting"
  | "split_done"
  | "request_failed"
  | "request_outcome_unknown"
  | "response_invalid"
  | "response_persistence_failed"
  | "aborted";

export type BatchFallbackReason = "oversized" | "blank_fragment" | "unsupported_task_shape";

export interface BatchChatMessage {
  role: "system" | "user";
  content: string;
}

export interface BatchRegionAlias {
  anchorFragmentKey: string;
  regionAlias: string;
}

export interface BatchPlanInputBudget {
  primaryUtf8Bytes: number;
  regionCount: number;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
}

/** Batch plan：规划真源，run 内不可变；身份 = UNIQUE(run_id, batch_key)（§23.1）。不保存 plan set 级字段。 */
export interface BatchPlan {
  runId: number;
  planSetId: string;
  batchKey: string;
  manifestHash: string;
  plannerVersion: string;
  orderedTaskKeys: string[];
  /** taskKey → T 别名（T1/T2/…），由 planner 生成并持久化；模型只见别名，不决定身份。 */
  taskAliasMap: Record<string, string>;
  groupingRulesFingerprint: string;
  inputBudgetSnapshot: BatchPlanInputBudget;
}

/** plan set：完整任务路由分配（batch + fallback）的唯一真源（§23.9）；building→ready 两阶段发布。 */
export interface BatchPlanSet {
  runId: number;
  planSetId: string;
  planSetFingerprint: string;
  plannerVersion: string;
  expectedPlanCount: number;
  expectedTaskCount: number;
  status: "building" | "ready";
  fallbackAssignments: BatchFallbackAssignment[];
}

export interface BatchFallbackAssignment {
  taskKey: string;
  reason: BatchFallbackReason;
}

/** planner 产出：batch plans + fallback 分配 + 全量指纹（恢复时重算比对，不符即 version conflict）。 */
export interface BatchExecutionAllocation {
  batchPlans: BatchPlan[];
  fallbackAssignments: BatchFallbackAssignment[];
  planSetFingerprint: string;
}

/** Batch attempt：执行真源；batch_attempt_uuid 同时是预算聚合 attempt id（§8.1）。 */
export interface BatchAttempt {
  runId: number;
  batchAttemptUuid: string;
  batchKey: string;
  reservationUuid: string;
  modelConfigFingerprint: string;
  promptVersion: string;
  schemaVersion: string;
  parserVersion: string;
  executionPhase: BatchExecutionPhase;
  membersFrozenAt: Date | null;
  acceptedDescribeRequestKey: string | null;
  acceptedJudgeRequestKey: string | null;
  terminalRequestKey: string | null;
  processingOwner: string | null;
  processingLeaseExpiresAt: Date | null;
  lastError: string | null;
  version: number;
}

/** 实际 claim 成功的成员：insert-only；UNIQUE(request_task_attempt_id) 防同一 task attempt 挂多个 attempt（§8.2）。 */
export interface BatchAttemptMember {
  batchAttemptUuid: string;
  taskKey: string;
  taskKeyHash: string;
  /** 首次模型请求时的 task attempt，永久保留；只做请求审计，提交资格来自当前 task row（C5.2）。 */
  requestTaskAttemptId: string;
  requestLeaseIdentity: string;
  taskAlias: string;
  orderedRegionAliases: BatchRegionAlias[];
  createdAt: Date;
}

/** 每次实际发送的模型请求一行；request_key 全局唯一明文复合键（§8.3 / §23.1）。 */
export interface BatchRequest {
  requestKey: string;
  batchAttemptUuid: string;
  requestStage: BatchRequestStage;
  requestSequence: number;
  requestFingerprint: string;
  /** judge 请求绑定的 describe 响应 hash；describe 行为空。 */
  describeResponseHash: string | null;
  providerRequestId: string | null;
  requestOutcome: BatchRequestOutcome;
  failureClass: BatchFailureClass | null;
  responseByteLength: number | null;
  storedByteLength: number | null;
  responseHash: string | null;
  providerFinishReason: string | null;
}

/** 预算上界快照（§14.2）：batch 每 attempt 一次预留，重试不在原 reservation 下发生。 */
export interface BatchBudgetUpperBound {
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostAmount: number;
}

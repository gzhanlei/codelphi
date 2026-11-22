import { createHash } from "node:crypto";
import type { Execute } from "../db";
import { recordRequestScopedReceipt } from "../billing/cost-receipt";
import { makeBatchRequestKey } from "./identity";
import { ExecutionBatchError } from "./plans";
import {
  MAX_BATCH_RESPONSE_BYTES,
  type BatchFailureClass,
  type BatchRequest,
  type BatchRequestOutcome,
  type BatchRequestStage,
} from "./types";

interface Row extends Record<string, unknown> {}

function asRows(result: unknown): Row[] {
  return (result as [Row[], unknown])[0] ?? [];
}

function isDuplicateEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const REQUEST_COLUMNS = `request_key, batch_attempt_uuid, request_stage, request_sequence, request_fingerprint,
        describe_response_hash, provider_request_id, request_outcome, failure_class,
        response_byte_length, stored_byte_length, response_hash, provider_finish_reason`;

function rowToRequest(row: Row): BatchRequest {
  return {
    requestKey: str(row.request_key),
    batchAttemptUuid: str(row.batch_attempt_uuid),
    requestStage: str(row.request_stage) as BatchRequestStage,
    requestSequence: Number(row.request_sequence),
    requestFingerprint: str(row.request_fingerprint),
    describeResponseHash: nullableStr(row.describe_response_hash),
    providerRequestId: nullableStr(row.provider_request_id),
    requestOutcome: str(row.request_outcome) as BatchRequestOutcome,
    failureClass: nullableStr(row.failure_class) as BatchFailureClass | null,
    responseByteLength: nullableNum(row.response_byte_length),
    storedByteLength: nullableNum(row.stored_byte_length),
    responseHash: nullableStr(row.response_hash),
    providerFinishReason: nullableStr(row.provider_finish_reason),
  };
}

export interface BeginBatchRequestInput {
  runId: number;
  batchAttemptUuid: string;
  requestStage: BatchRequestStage;
  requestSequence: number;
  requestFingerprint: string;
  /** judge 请求绑定的 describe 响应 hash；describe 为空。 */
  describeResponseHash?: string | null;
}

/** 派发前先落 prepared 身份行（§23.3 C3.1：prepared 不证明已发送）。同 key 重入且指纹一致时
 *  幂等返回既有行（恢复重入）；指纹不同 = 契约冲突。 */
export async function beginBatchRequest(execute: Execute, input: BeginBatchRequestInput): Promise<BatchRequest> {
  const requestKey = makeBatchRequestKey({
    batchAttemptUuid: input.batchAttemptUuid,
    stage: input.requestStage,
    sequence: input.requestSequence,
  });
  try {
    await execute(
      `INSERT INTO analysis_behavior_batch_requests
         (run_id, batch_attempt_uuid, request_key, request_stage, request_sequence, request_fingerprint, describe_response_hash, provider_request_id, request_outcome, failure_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'prepared', NULL)`,
      [
        input.runId,
        input.batchAttemptUuid,
        requestKey,
        input.requestStage,
        input.requestSequence,
        input.requestFingerprint,
        input.describeResponseHash ?? null,
      ],
    );
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;
    const existing = await loadBatchRequest(execute, requestKey);
    if (existing && existing.requestFingerprint === input.requestFingerprint) return existing;
    throw new ExecutionBatchError(
      "execution_batch_receipt_conflict",
      `request ${requestKey} 已存在但指纹不一致（${existing ? existing.requestFingerprint : "missing row"} != ${input.requestFingerprint}）`,
    );
  }
  const created = await loadBatchRequest(execute, requestKey);
  if (!created) throw new ExecutionBatchError("execution_batch_request_state", `request ${requestKey} 插入后读回失败`);
  return created;
}

export async function loadBatchRequest(execute: Execute, requestKey: string): Promise<BatchRequest | null> {
  const rows = asRows(
    await execute(`SELECT ${REQUEST_COLUMNS} FROM analysis_behavior_batch_requests WHERE request_key = ?`, [requestKey]),
  );
  const row = rows[0];
  return row ? rowToRequest(row) : null;
}

async function requireRequestRow(execute: Execute, requestKey: string): Promise<BatchRequest> {
  const request = await loadBatchRequest(execute, requestKey);
  if (!request) throw new ExecutionBatchError("execution_batch_request_state", `request ${requestKey} 不存在`);
  return request;
}

/** prepared → dispatch_started：进入实际网关派发前条件迁移（幂等重入返回当前行）。 */
export async function markBatchRequestDispatchStarted(execute: Execute, requestKey: string): Promise<BatchRequest> {
  const [result] = (await execute(
    `UPDATE analysis_behavior_batch_requests SET request_outcome = 'dispatch_started', dispatch_started_at = NOW(3)
      WHERE request_key = ? AND request_outcome = 'prepared'`,
    [requestKey],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows === 1) return requireRequestRow(execute, requestKey);
  const current = await requireRequestRow(execute, requestKey);
  if (current.requestOutcome === "dispatch_started") return current;
  throw new ExecutionBatchError(
    "execution_batch_request_state",
    `request ${requestKey} 不能从 ${current.requestOutcome} 迁移到 dispatch_started`,
  );
}

export interface PersistBatchResponseInput {
  requestKey: string;
  rawResponse: string;
  providerRequestId?: string | null;
  providerFinishReason?: string | null;
}

async function markPersistenceFailed(execute: Execute, requestKey: string, detail: string): Promise<never> {
  await execute(
    `UPDATE analysis_behavior_batch_requests SET request_outcome = 'persistence_failed'
      WHERE request_key = ? AND request_outcome = 'response_received'`,
    [requestKey],
  );
  throw new ExecutionBatchError("execution_batch_response_persistence_failed", `request ${requestKey}：${detail}`);
}

/**
 * 响应持久化（§23.3 C3.4）：先 response_received（记录 provider 元数据）→ 写入精确原始字节
 * 与 hash → 读回校验字节长度与 SHA-256 一致 → 才进入 response_persisted。任何不一致或容量超限
 * 落 persistence_failed 终态（响应仍在进程时只许重试持久化，不得重新调用模型）。
 */
export async function persistBatchResponse(execute: Execute, input: PersistBatchResponseInput): Promise<BatchRequest> {
  const current = await requireRequestRow(execute, input.requestKey);
  if (current.requestOutcome !== "dispatch_started" && current.requestOutcome !== "response_received") {
    throw new ExecutionBatchError(
      "execution_batch_request_state",
      `request ${input.requestKey} 不能从 ${current.requestOutcome} 持久化响应（须先 dispatch_started）`,
    );
  }
  const byteLength = Buffer.byteLength(input.rawResponse, "utf8");
  const responseHash = createHash("sha256").update(input.rawResponse, "utf8").digest("hex");
  if (current.requestOutcome === "dispatch_started") {
    await execute(
      `UPDATE analysis_behavior_batch_requests SET request_outcome = 'response_received', response_received_at = NOW(3),
              provider_request_id = COALESCE(provider_request_id, ?), provider_finish_reason = COALESCE(provider_finish_reason, ?)
        WHERE request_key = ? AND request_outcome = 'dispatch_started'`,
      [input.providerRequestId ?? null, input.providerFinishReason ?? null, input.requestKey],
    );
  }
  if (byteLength > MAX_BATCH_RESPONSE_BYTES) {
    await markPersistenceFailed(execute, input.requestKey, `响应 ${byteLength} 字节超过协议上限 ${MAX_BATCH_RESPONSE_BYTES}`);
  }
  await execute(
    `UPDATE analysis_behavior_batch_requests SET raw_response = ?, response_byte_length = ?, stored_byte_length = ?, response_hash = ?
      WHERE request_key = ? AND request_outcome = 'response_received'`,
    [input.rawResponse, byteLength, byteLength, responseHash, input.requestKey],
  );
  const stored = asRows(
    await execute(
      `SELECT raw_response, response_byte_length, stored_byte_length, response_hash
         FROM analysis_behavior_batch_requests WHERE request_key = ? AND request_outcome = 'response_received'`,
      [input.requestKey],
    ),
  )[0];
  const storedText = stored ? String(stored.raw_response ?? "") : null;
  const storedBytes = storedText === null ? null : Buffer.byteLength(storedText, "utf8");
  if (!stored || storedBytes === null || storedBytes !== byteLength || str(stored.response_hash) !== responseHash) {
    await markPersistenceFailed(execute, input.requestKey, "读回校验失败（字节长度或 hash 与写入不一致）");
  }
  const [result] = (await execute(
    `UPDATE analysis_behavior_batch_requests SET request_outcome = 'response_persisted', response_persisted_at = NOW(3)
      WHERE request_key = ? AND request_outcome = 'response_received'`,
    [input.requestKey],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows !== 1) {
    throw new ExecutionBatchError("execution_batch_request_state", `request ${input.requestKey} 读回后进入 persisted 条件更新失败`);
  }
  return requireRequestRow(execute, input.requestKey);
}

export interface MarkBatchRequestOutcomeInput {
  requestKey: string;
  outcome: "confirmed_not_sent" | "failed" | "outcome_unknown";
  /** failed 行必填（§23.3 C3.2）；confirmed_not_sent / outcome_unknown 不适用。 */
  failureClass?: BatchFailureClass | null;
}

/** 旁路转移（幂等重入 no-op）：confirmed_not_sent 仅限 prepared；failed 需带 failure_class；
 *  outcome_unknown 仅限 dispatch_started（无响应不得反推未发送）。 */
export async function markBatchRequestOutcome(execute: Execute, input: MarkBatchRequestOutcomeInput): Promise<void> {
  if (input.outcome === "failed" && !input.failureClass) {
    throw new ExecutionBatchError("execution_batch_request_state", `request ${input.requestKey} 的 failed 必须携带 failure_class`);
  }
  if (input.outcome === "confirmed_not_sent") {
    const [result] = (await execute(
      `UPDATE analysis_behavior_batch_requests SET request_outcome = 'confirmed_not_sent', confirmed_not_sent_at = NOW(3)
        WHERE request_key = ? AND request_outcome = 'prepared'`,
      [input.requestKey],
    )) as [{ affectedRows: number }, unknown];
    if (result.affectedRows !== 1 && (await requireRequestRow(execute, input.requestKey)).requestOutcome !== "confirmed_not_sent") {
      throw new ExecutionBatchError(
        "execution_batch_request_state",
        `request ${input.requestKey} 不能标记 confirmed_not_sent（仅 prepared 可走未发送旁路）`,
      );
    }
    return;
  }
  if (input.outcome === "outcome_unknown") {
    const [result] = (await execute(
      `UPDATE analysis_behavior_batch_requests SET request_outcome = 'outcome_unknown'
        WHERE request_key = ? AND request_outcome = 'dispatch_started'`,
      [input.requestKey],
    )) as [{ affectedRows: number }, unknown];
    if (result.affectedRows !== 1 && (await requireRequestRow(execute, input.requestKey)).requestOutcome !== "outcome_unknown") {
      throw new ExecutionBatchError(
        "execution_batch_request_state",
        `request ${input.requestKey} 不能标记 outcome_unknown（仅 dispatch_started 可走未知旁路）`,
      );
    }
    return;
  }
  const [result] = (await execute(
    `UPDATE analysis_behavior_batch_requests SET request_outcome = 'failed', failure_class = ?
      WHERE request_key = ? AND request_outcome IN ('prepared', 'dispatch_started')`,
    [input.failureClass ?? null, input.requestKey],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows !== 1 && (await requireRequestRow(execute, input.requestKey)).requestOutcome !== "failed") {
    throw new ExecutionBatchError(
      "execution_batch_request_state",
      `request ${input.requestKey} 不能标记 failed（终态不得改写）`,
    );
  }
}

export interface ReconcileBatchReceiptInput {
  runId: number | null;
  accountId: number | null;
  chargeComponent: "main" | "platform_shadow";
  callKind?: string | null;
  taskKey?: string | null;
  unitKey?: string | null;
  attemptId?: string | null;
  callStage?: "describe" | "judge" | "semantic_repair" | "product_summary" | null;
  model: string;
  outcome: "success" | "failed" | "timeout";
  usageRaw: unknown | null;
  providerRequestId?: string | null;
  durationMs?: number | null;
  requestKey: string;
  requestFingerprint: string;
}

/** receipt 幂等/单调补全/冲突矩阵的恢复入口（§23.3 C3.5/C3.6）：委托 cost-receipt 的
 *  insert-or-reconcile；恢复流程用它把查到的真实 usage 单调补进既有回执。 */
export async function reconcileBatchRequestReceipt(
  input: ReconcileBatchReceiptInput,
): Promise<"inserted" | "reconciled" | "noop"> {
  return recordRequestScopedReceipt(input);
}

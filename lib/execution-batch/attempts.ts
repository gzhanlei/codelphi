import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { claimBehaviorTask, taskKeyHash, type ClaimedBehaviorTask } from "../behavior-unit-receipts";
import { makeOrderedRegionAliases } from "./identity";
import { ExecutionBatchError } from "./plans";
import { withBatchTransaction } from "./persistence";
import {
  BATCH_PARSER_VERSION,
  BATCH_PROMPT_VERSION,
  BATCH_SCHEMA_VERSION,
  type BatchAttempt,
  type BatchExecutionPhase,
} from "./types";

/**
 * Batch attempt 单向状态机与成员/处理权契约（§8/§9.1/§14 / §23.2/§23.4/§23.5）：
 * - 正常链单向推进，异常终态不可再迁移；模型重试只能创建新 attempt（无倒退边）。
 * - task claim 与 member insert 同一事务（withBatchTransaction）——任一失败不留半持久化成员。
 * - 成员冻结是进入 describe 的独立原子步骤；冻结后 insert-only；零成员不得冻结（走 aborted）。
 * - processing_owner + version 双 CAS 保证同一时刻只有一个 worker 推进状态或拆分；
 *   租约过期后新 owner 可接管（splitting 恢复零新模型请求）。
 * - attempt 不复制 task 结果、不参与覆盖核算；member.request_task_attempt_id 只做请求审计，
 *   提交资格始终来自当前 task 行（loadBatchAttemptForRecovery 原样返回两侧事实）。
 */

export interface CreateBatchAttemptInput {
  runId: number;
  batchKey: string;
  reservationUuid: string;
  modelConfigFingerprint: string;
  /** 编排层先预留（attemptId=本 uuid）再建 attempt 时传入；缺省内部生成。 */
  batchAttemptUuid?: string;
}

export interface ClaimBatchMemberInput {
  runId: number;
  batchAttemptUuid: string;
  taskKey: string;
  taskAlias: string;
  leaseOwner: string;
  leaseDurationMs: number;
  maxAttempts: number;
}

export interface BatchProcessingGrant {
  batchAttemptUuid: string;
  processingOwner: string;
  version: number;
  processingLeaseExpiresAt: string;
}

export interface RecoveryMemberContext {
  taskKey: string;
  taskAlias: string;
  orderedRegionAliases: Array<{ anchorFragmentKey: string; regionAlias: string }>;
  /** 首次模型请求时的 task attempt，永久保留、不随恢复改写。 */
  requestTaskAttemptId: string;
  requestLeaseIdentity: string;
  /** 当前 task 行的提交资格事实（恢复按现有协议重新 claim 后由此判定可否提交）。 */
  currentTask: {
    attemptId: string | null;
    leaseOwner: string | null;
    status: string;
  } | null;
}

export interface BatchRecoveryContext {
  attempt: BatchAttempt;
  members: RecoveryMemberContext[];
}

interface Row extends Record<string, unknown> {}

const PHASE_TRANSITIONS: Readonly<Record<BatchExecutionPhase, readonly BatchExecutionPhase[]>> = {
  claiming: ["describe_requesting", "aborted"],
  describe_requesting: ["describe_persisted", "request_failed", "request_outcome_unknown", "response_persistence_failed"],
  describe_persisted: ["judge_requesting", "response_invalid"],
  judge_requesting: ["judge_persisted", "request_failed", "request_outcome_unknown", "response_persistence_failed"],
  judge_persisted: ["splitting", "response_invalid"],
  splitting: ["split_done"],
  split_done: [],
  request_failed: [],
  request_outcome_unknown: [],
  response_invalid: [],
  response_persistence_failed: [],
  aborted: [],
};

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** DATETIME(3) 列：mysql2 通常给 Date；fake/原始串统一解析为 Date。 */
function nullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = Date.parse(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z"));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

async function selectAttempt(runId: number, batchAttemptUuid: string): Promise<BatchAttempt | null> {
  const [rows] = (await getDb().execute(
    `SELECT run_id, batch_attempt_uuid, batch_key, reservation_uuid, model_config_fingerprint, prompt_version, schema_version,
            parser_version, execution_phase, members_frozen_at, accepted_describe_request_key, accepted_judge_request_key,
            terminal_request_key, processing_owner, processing_lease_expires_at, last_error, version
       FROM analysis_behavior_batch_attempts WHERE run_id = ? AND batch_attempt_uuid = ?`,
    [runId, batchAttemptUuid],
  )) as [Row[], unknown];
  const row = rows[0];
  if (!row) return null;
  return {
    runId: Number(row.run_id),
    batchAttemptUuid: String(row.batch_attempt_uuid),
    batchKey: String(row.batch_key),
    reservationUuid: String(row.reservation_uuid),
    modelConfigFingerprint: String(row.model_config_fingerprint),
    promptVersion: String(row.prompt_version),
    schemaVersion: String(row.schema_version),
    parserVersion: String(row.parser_version),
    executionPhase: String(row.execution_phase) as BatchExecutionPhase,
    membersFrozenAt: nullableDate(row.members_frozen_at),
    acceptedDescribeRequestKey: nullableStr(row.accepted_describe_request_key),
    acceptedJudgeRequestKey: nullableStr(row.accepted_judge_request_key),
    terminalRequestKey: nullableStr(row.terminal_request_key),
    processingOwner: nullableStr(row.processing_owner),
    processingLeaseExpiresAt: nullableDate(row.processing_lease_expires_at),
    lastError: nullableStr(row.last_error),
    version: Number(row.version),
  };
}

async function requireAttempt(runId: number, batchAttemptUuid: string): Promise<BatchAttempt> {
  const attempt = await selectAttempt(runId, batchAttemptUuid);
  if (!attempt) throw new ExecutionBatchError("execution_batch_version_conflict", `attempt ${batchAttemptUuid} 不存在`);
  return attempt;
}

export async function createBatchAttempt(input: CreateBatchAttemptInput): Promise<BatchAttempt> {
  const batchAttemptUuid = input.batchAttemptUuid ?? randomUUID();
  await getDb().execute(
    `INSERT INTO analysis_behavior_batch_attempts
       (run_id, batch_attempt_uuid, batch_key, reservation_uuid, model_config_fingerprint, prompt_version, schema_version, parser_version, execution_phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claiming')`,
    [
      input.runId,
      batchAttemptUuid,
      input.batchKey,
      input.reservationUuid,
      input.modelConfigFingerprint,
      BATCH_PROMPT_VERSION,
      BATCH_SCHEMA_VERSION,
      BATCH_PARSER_VERSION,
    ],
  );
  return requireAttempt(input.runId, batchAttemptUuid);
}

/** task claim 与 member insert 同事务（§23.2 C2.2）；冻结后拒绝新增成员。 */
export async function claimBatchAttemptMember(input: ClaimBatchMemberInput): Promise<ClaimedBehaviorTask | null> {
  return withBatchTransaction(async (execute) => {
    const attempt = await selectAttempt(input.runId, input.batchAttemptUuid);
    if (!attempt) throw new ExecutionBatchError("execution_batch_version_conflict", `attempt ${input.batchAttemptUuid} 不存在`);
    if (attempt.executionPhase !== "claiming" || attempt.membersFrozenAt !== null) {
      throw new ExecutionBatchError(
        "execution_batch_attempt_state",
        `attempt ${input.batchAttemptUuid} 已冻结或离开 claiming（${attempt.executionPhase}），不得新增成员——成员变化须创建新 attempt`,
      );
    }
    const claimed = await claimBehaviorTask({
      execute,
      runId: input.runId,
      taskKey: input.taskKey,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs,
      maxAttempts: input.maxAttempts,
    });
    if (!claimed) return null;
    const orderedRegionAliases = makeOrderedRegionAliases({
      taskKey: claimed.taskKey,
      unitKey: claimed.unitKey,
      anchorFragments: claimed.anchorFragments as never,
    });
    await execute(
      `INSERT INTO analysis_behavior_batch_attempt_members
         (run_id, batch_attempt_uuid, task_key, task_key_hash, request_task_attempt_id, request_lease_identity, task_alias, ordered_region_aliases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.batchAttemptUuid,
        claimed.taskKey,
        taskKeyHash(claimed.taskKey),
        claimed.attemptId,
        `${input.leaseOwner}@${claimed.leaseExpiresAt.toISOString()}`,
        input.taskAlias,
        JSON.stringify(orderedRegionAliases),
      ],
    );
    return claimed;
  });
}

/** 成员与全部 T/R 映射冻结（进入 describe 的独立原子步骤）：≥1 成员才可冻结；重复冻结幂等。 */
export async function freezeBatchAttemptMembers(input: { runId: number; batchAttemptUuid: string }): Promise<BatchAttempt> {
  const [countRows] = (await getDb().execute(
    "SELECT COUNT(*) AS n FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ?",
    [input.batchAttemptUuid],
  )) as [Array<{ n: number }>, unknown];
  if (Number(countRows[0]?.n ?? 0) === 0) {
    throw new ExecutionBatchError(
      "execution_batch_attempt_state",
      `attempt ${input.batchAttemptUuid} 零成员不得冻结——按 aborted 释放未使用预留`,
    );
  }
  const [result] = (await getDb().execute(
    `UPDATE analysis_behavior_batch_attempts SET members_frozen_at = ?
      WHERE run_id = ? AND batch_attempt_uuid = ? AND members_frozen_at IS NULL AND execution_phase = 'claiming'`,
    [mysqlDatetime(Date.now()), input.runId, input.batchAttemptUuid],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows !== 1) {
    const current = await requireAttempt(input.runId, input.batchAttemptUuid);
    if (current.membersFrozenAt !== null) return current;
    throw new ExecutionBatchError("execution_batch_version_conflict", `attempt ${input.batchAttemptUuid} 冻结条件更新失败`);
  }
  return requireAttempt(input.runId, input.batchAttemptUuid);
}

/** batch 处理权 fencing（§14.1）：空闲/过期/同 owner 可取得；存续期间其他 worker 被拒。 */
export async function acquireBatchAttemptProcessing(input: {
  runId: number;
  batchAttemptUuid: string;
  processingOwner: string;
  leaseDurationMs: number;
}): Promise<BatchProcessingGrant> {
  const expiresAt = mysqlDatetime(Date.now() + input.leaseDurationMs);
  const now = mysqlDatetime(Date.now());
  const [result] = (await getDb().execute(
    `UPDATE analysis_behavior_batch_attempts SET processing_owner = ?, processing_lease_expires_at = ?, version = version + 1
      WHERE run_id = ? AND batch_attempt_uuid = ?
        AND (processing_owner IS NULL OR processing_owner = ? OR processing_lease_expires_at IS NULL OR processing_lease_expires_at < ?)`,
    [input.processingOwner, expiresAt, input.runId, input.batchAttemptUuid, input.processingOwner, now],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows !== 1) {
    throw new ExecutionBatchError(
      "execution_batch_version_conflict",
      `attempt ${input.batchAttemptUuid} 的 batch 处理权由其他 worker 持有且未过期`,
    );
  }
  const attempt = await requireAttempt(input.runId, input.batchAttemptUuid);
  return {
    batchAttemptUuid: input.batchAttemptUuid,
    processingOwner: input.processingOwner,
    version: attempt.version,
    processingLeaseExpiresAt: expiresAt,
  };
}

/** 单向状态迁移（双 CAS：processing_owner + version）。terminalRequestKey 记录导致失败/未知
 *  终态的实际请求键，恢复按其精确保存 stage/sequence。 */
export async function transitionBatchAttempt(input: {
  runId: number;
  batchAttemptUuid: string;
  to: BatchExecutionPhase;
  processingOwner: string;
  expectedVersion: number;
  terminalRequestKey?: string | null;
}): Promise<BatchAttempt> {
  const current = await requireAttempt(input.runId, input.batchAttemptUuid);
  const allowed = PHASE_TRANSITIONS[current.executionPhase] ?? [];
  if (!allowed.includes(input.to)) {
    throw new ExecutionBatchError(
      "execution_batch_attempt_state",
      `attempt ${input.batchAttemptUuid} 不允许从 ${current.executionPhase} 迁移到 ${input.to}`,
    );
  }
  const [result] = (await getDb().execute(
    `UPDATE analysis_behavior_batch_attempts SET execution_phase = ?, terminal_request_key = ?, version = version + 1
      WHERE run_id = ? AND batch_attempt_uuid = ? AND execution_phase = ? AND version = ? AND processing_owner = ?`,
    [
      input.to,
      input.terminalRequestKey ?? current.terminalRequestKey,
      input.runId,
      input.batchAttemptUuid,
      current.executionPhase,
      input.expectedVersion,
      input.processingOwner,
    ],
  )) as [{ affectedRows: number }, unknown];
  if (result.affectedRows !== 1) {
    throw new ExecutionBatchError(
      "execution_batch_version_conflict",
      `attempt ${input.batchAttemptUuid} 状态迁移竞争失败（owner/version 不匹配）`,
    );
  }
  return requireAttempt(input.runId, input.batchAttemptUuid);
}

/** 恢复上下文：原 member/request identity 与当前 task 提交资格并列返回，不改写 request member。 */
/** JSON 列读回：mysql2 自动解析（真库）与字符串（fake）两种形状都容忍。 */
function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

export async function loadBatchAttemptForRecovery(input: { runId: number; batchAttemptUuid: string }): Promise<BatchRecoveryContext> {
  const attempt = await requireAttempt(input.runId, input.batchAttemptUuid);
  const [memberRows] = (await getDb().execute(
    `SELECT task_key, task_alias, ordered_region_aliases, request_task_attempt_id, request_lease_identity
       FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ? ORDER BY task_alias`,
    [input.batchAttemptUuid],
  )) as [Row[], unknown];
  const members: RecoveryMemberContext[] = [];
  for (const row of memberRows) {
    const taskKey = String(row.task_key);
    const [taskRows] = (await getDb().execute(
      `SELECT attempt_id, lease_owner, status FROM analysis_behavior_tasks WHERE run_id = ? AND task_key_hash = ?`,
      [input.runId, taskKeyHash(taskKey)],
    )) as [Row[], unknown];
    const taskRow = taskRows[0];
    members.push({
      taskKey,
      taskAlias: String(row.task_alias),
      orderedRegionAliases: parseJsonColumn<Array<{ anchorFragmentKey: string; regionAlias: string }>>(row.ordered_region_aliases),
      requestTaskAttemptId: String(row.request_task_attempt_id),
      requestLeaseIdentity: String(row.request_lease_identity),
      currentTask: taskRow
        ? {
            attemptId: nullableStr(taskRow.attempt_id),
            leaseOwner: nullableStr(taskRow.lease_owner),
            status: String(taskRow.status),
          }
        : null,
    });
  }
  return { attempt, members };
}

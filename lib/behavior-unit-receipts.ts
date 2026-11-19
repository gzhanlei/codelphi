import { createHash, randomUUID } from "node:crypto";
import { DETECTOR_REGISTRY_VERSION, INVENTORY_SCHEMA_VERSION } from "./behavior-inventory/index";
import { canonicalManifest, manifestHash, normalizeManifest } from "./behavior-inventory/manifest";
import type { BehaviorManifest } from "./behavior-inventory/types";
import type { Execute } from "./db";

/** Task 5 契约（2026-11-19 行为清单全量分析）：analysis_behavior_manifests 的 insert-only
 *  持久化。manifest 一旦落库即不可变——同 run 同 hash 重入幂等，同 run 不同 manifest 抛
 *  inventory_version_conflict，绝不 UPDATE/REPLACE；恢复路径重算 hash 验证持久化内容，
 *  篡改或版本（inventory schema / detector registry）不一致一律拒绝。 */

export type InventoryPersistenceErrorCode = "inventory_version_conflict" | "inventory_manifest_tampered";

export class InventoryPersistenceError extends Error {
  code: InventoryPersistenceErrorCode;
  constructor(code: InventoryPersistenceErrorCode, message: string) {
    super(message);
    this.name = "InventoryPersistenceError";
    this.code = code;
  }
}

interface PersistedManifestRow {
  manifestJson: string;
  manifestHash: string;
}

async function selectManifestRow(execute: Execute, runId: number): Promise<PersistedManifestRow | null> {
  const [rows] = (await execute(
    "SELECT manifest_json, manifest_hash FROM analysis_behavior_manifests WHERE run_id = ?",
    [runId],
  )) as [Array<{ manifest_json: unknown; manifest_hash: unknown }>, unknown];
  if (rows.length === 0) return null;
  const raw = rows[0].manifest_json;
  return {
    manifestJson: typeof raw === "string" ? raw : JSON.stringify(raw),
    manifestHash: String(rows[0].manifest_hash),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

function parseStoredManifest(manifestJson: string, runId: number): BehaviorManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest is not valid JSON; refusing to resume from unverifiable content`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest is not a JSON object; refusing to resume from unverifiable content`,
    );
  }
  return parsed as BehaviorManifest;
}

/** 持久化 manifest 校验：内容完整性（重算 canonical hash）先于版本协商，篡改永远优先暴露。
 *  规范化本身被拒绝（如非法区间）同样意味着内容不是本管线写出的，按篡改处理。 */
function verifyPersistedManifest(row: PersistedManifestRow, runId: number): BehaviorManifest {
  const manifest = parseStoredManifest(row.manifestJson, runId);
  let recomputed: string;
  try {
    recomputed = manifestHash(manifest);
  } catch {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest cannot be normalized; refusing to resume from unverifiable content`,
    );
  }
  if (recomputed !== row.manifestHash) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} behavior manifest hash mismatch: persisted content was modified after insert; refusing to resume`,
    );
  }
  if (
    manifest.inventorySchemaVersion !== INVENTORY_SCHEMA_VERSION ||
    manifest.detectorRegistryVersion !== DETECTOR_REGISTRY_VERSION
  ) {
    throw new InventoryPersistenceError(
      "inventory_version_conflict",
      `run ${runId} behavior manifest was written by inventory schema ${String(manifest.inventorySchemaVersion)} ` +
        `/ detector registry ${String(manifest.detectorRegistryVersion)}, current code expects ` +
        `${INVENTORY_SCHEMA_VERSION} / ${DETECTOR_REGISTRY_VERSION}; create a new run instead of resuming`,
    );
  }
  return normalizeManifest(manifest);
}

/**
 * 首次写入 run 的不可变 manifest。同 run 同 hash 的重入（含并发唯一键冲突后的重试）幂等成功；
 * 同 run 不同 manifest 抛 inventory_version_conflict——调用方必须开新 run，本函数绝不改写已存行。
 */
export async function insertManifestIfAbsent(execute: Execute, runId: number, manifest: BehaviorManifest): Promise<void> {
  const canonical = canonicalManifest(manifest);
  const hash = manifestHash(manifest);
  try {
    await execute(
      `INSERT INTO analysis_behavior_manifests
         (run_id, after_sha, scope_fingerprint, inventory_schema_version, detector_registry_version, manifest_json, manifest_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        manifest.afterSha,
        manifest.scopeFingerprint,
        manifest.inventorySchemaVersion,
        manifest.detectorRegistryVersion,
        canonical,
        hash,
      ],
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await selectManifestRow(execute, runId);
    if (existing && existing.manifestHash === hash) return;
    throw new InventoryPersistenceError(
      "inventory_version_conflict",
      `run ${runId} already has a different behavior manifest; refusing to overwrite, create a new run instead`,
    );
  }
}

/** 恢复时读取并验证 run 的 manifest：缺失、JSON 损坏或 hash 不符 → tampered；版本不符 → conflict。 */
export async function loadVerifiedManifest(execute: Execute, runId: number): Promise<BehaviorManifest> {
  const row = await selectManifestRow(execute, runId);
  if (!row) {
    throw new InventoryPersistenceError(
      "inventory_manifest_tampered",
      `run ${runId} has no persisted behavior manifest; refusing to resume from missing content`,
    );
  }
  return verifyPersistedManifest(row, runId);
}

/** Task 8 契约（2026-11-19 行为清单全量分析，D7）：执行任务租约与条件提交。
 *  - 领取是**单条原子条件 UPDATE**：status→running、写 lease_owner/lease_expires_at/attempt_id、
 *    attempts 自增，谓词在数据库写入时判定——只有 pending、重试预算内（attempts < maxAttempts）
 *    的 failed/unresolved、或租约已过期的 running 可被领取；成功终态（extracted/no_behavior）
 *    永不匹配，恢复时绝不重新执行。
 *  - 提交与失败标记都带 run_id + task_key_hash + attempt_id + lease_owner + status='running'
 *    条件：只有当前 attempt 能写终态；陈旧 attempt 的迟到提交返回 false 且绝不覆盖
 *    result_json，迟到失败标记为 no-op（外部 LLM 调用与 DB 提交无法组成原子事务，
 *    本设计是 at-least-once 执行 + 条件提交幂等，过期 attempt 由 attempts 计数与
 *    llm_call_receipts.attempt_id 保持可审计）。
 *  - 崩溃恢复只处理过期任务，已完成结果保持不动；过期租约的重新领取不受 attempts
 *    上限约束（由运行预算兜底，D7），failed/unresolved 的重试受 maxAttempts 约束。
 *  - abort-before-first-call（Task 13 领取后尚未发起任何 LLM 调用即放弃）与硬失败不同：
 *    预算走 releaseUnused 全额释放而非 settle，任务状态经 markBehaviorTaskFailure 的
 *    abortedBeforeExecution 恢复为 pending 并清租约——不记录伪失败、不消耗重试预算。 */

export type BehaviorTaskLeaseErrorCode = "behavior_task_lease_lost";

export class BehaviorTaskLeaseError extends Error {
  code: BehaviorTaskLeaseErrorCode;
  constructor(code: BehaviorTaskLeaseErrorCode, message: string) {
    super(message);
    this.name = "BehaviorTaskLeaseError";
    this.code = code;
  }
}

/** 执行任务终态（提交口径）：extracted/no_behavior 为成功终态，unresolved 为语义未决。 */
export type BehaviorTaskOutcome = "extracted" | "no_behavior" | "unresolved";

export interface ClaimTaskInput {
  execute: Execute;
  runId: number;
  taskKey: string;
  leaseOwner: string;
  leaseDurationMs: number;
  /** failed/unresolved 的重试预算（含首次执行）；过期 running 的恢复领取不受其约束。 */
  maxAttempts: number;
  /** 测试与恢复可注入的时钟，默认 Date.now()；租约判定与写入共用同一时钟。 */
  nowMs?: number;
}

export interface ClaimedBehaviorTask {
  runId: number;
  taskKey: string;
  unitKey: string;
  kind: string;
  primaryPath: string;
  primaryRanges: unknown;
  contextRanges: unknown;
  anchorFragments: unknown;
  detector: string;
  detectorVersion: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  attempts: number;
}

export interface LeaseInput {
  execute: Execute;
  runId: number;
  taskKey: string;
  attemptId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  nowMs?: number;
}

export interface CommitTaskResultInput {
  execute: Execute;
  runId: number;
  taskKey: string;
  attemptId: string;
  leaseOwner: string;
  outcome: BehaviorTaskOutcome;
  result: unknown;
  scenarioCount: number;
  reviewedCount: number;
  unresolvedAnchorCount: number;
}

export interface TaskFailureInput {
  execute: Execute;
  runId: number;
  taskKey: string;
  attemptId: string;
  leaseOwner: string;
  error: string;
  /** true = 首次 LLM 调用前放弃（预算走 releaseUnused 而非 settle）：
   *  任务恢复 pending 并清租约，不记录伪失败、不消耗重试预算。 */
  abortedBeforeExecution?: boolean;
}

interface UpdateResult {
  affectedRows: number;
}

function taskKeyHash(taskKey: string): string {
  return createHash("sha256").update(taskKey, "utf8").digest("hex");
}

function mysqlDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function requirePositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer, got ${String(value)}`);
  }
}

function requireNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, got ${String(value)}`);
  }
}

function validateAttemptIdentity(input: { runId: number; taskKey: string; attemptId: string; leaseOwner: string }): void {
  requirePositiveInt(input.runId, "runId");
  requireNonEmpty(input.taskKey, "taskKey");
  requireNonEmpty(input.attemptId, "attemptId");
  requireNonEmpty(input.leaseOwner, "leaseOwner");
}

function parseJsonColumn(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

interface ClaimedTaskRow {
  unit_key: unknown;
  kind: unknown;
  primary_path: unknown;
  primary_ranges: unknown;
  context_ranges: unknown;
  anchor_fragments: unknown;
  detector: unknown;
  detector_version: unknown;
  attempts: unknown;
}

/**
 * 原子领取执行任务：单条条件 UPDATE 完成 running/租约/attempt 写入与 attempts 自增，
 * 受影响行数为 1 才表示领取成功（返回 null 表示被抢占或不可领取，调用方据此释放预算）。
 * 成功后按 run_id + task_key_hash 读回任务内容供执行使用。
 */
export async function claimBehaviorTask(input: ClaimTaskInput): Promise<ClaimedBehaviorTask | null> {
  requirePositiveInt(input.runId, "runId");
  requireNonEmpty(input.taskKey, "taskKey");
  requireNonEmpty(input.leaseOwner, "leaseOwner");
  requirePositiveInt(input.leaseDurationMs, "leaseDurationMs");
  requirePositiveInt(input.maxAttempts, "maxAttempts");
  const nowMs = input.nowMs ?? Date.now();
  const attemptId = randomUUID();
  const hash = taskKeyHash(input.taskKey);
  const leaseExpiresAt = new Date(nowMs + input.leaseDurationMs);
  const [result] = (await input.execute(
    `UPDATE analysis_behavior_tasks
        SET status = 'running',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_id = ?,
            attempts = attempts + 1,
            last_error = NULL
      WHERE run_id = ?
        AND task_key_hash = ?
        AND (
             status = 'pending'
             OR (status IN ('failed', 'unresolved') AND attempts < ?)
             OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`,
    [input.leaseOwner, mysqlDatetime(leaseExpiresAt.getTime()), attemptId, input.runId, hash, input.maxAttempts, mysqlDatetime(nowMs)],
  )) as [UpdateResult, unknown];
  if (result.affectedRows !== 1) return null;
  const [rows] = (await input.execute(
    `SELECT unit_key, kind, primary_path, primary_ranges, context_ranges, anchor_fragments, detector, detector_version, attempts
       FROM analysis_behavior_tasks
      WHERE run_id = ? AND task_key_hash = ?`,
    [input.runId, hash],
  )) as [ClaimedTaskRow[], unknown];
  const row = rows[0];
  if (!row) return null;
  return {
    runId: input.runId,
    taskKey: input.taskKey,
    unitKey: String(row.unit_key),
    kind: String(row.kind),
    primaryPath: String(row.primary_path),
    primaryRanges: parseJsonColumn(row.primary_ranges),
    contextRanges: parseJsonColumn(row.context_ranges),
    anchorFragments: parseJsonColumn(row.anchor_fragments),
    detector: String(row.detector),
    detectorVersion: String(row.detector_version),
    attemptId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt,
    attempts: Number(row.attempts),
  };
}

/** 续租：只有当前 attempt（attempt_id + lease_owner + running）且租约尚未过期时可延长；
 *  受影响行数不为 1 抛 behavior_task_lease_lost——调用方必须停止执行并放弃提交。 */
export async function renewBehaviorTaskLease(input: LeaseInput): Promise<void> {
  validateAttemptIdentity(input);
  requirePositiveInt(input.leaseDurationMs, "leaseDurationMs");
  const nowMs = input.nowMs ?? Date.now();
  const [result] = (await input.execute(
    `UPDATE analysis_behavior_tasks
        SET lease_expires_at = ?
      WHERE run_id = ?
        AND task_key_hash = ?
        AND attempt_id = ?
        AND lease_owner = ?
        AND status = 'running'
        AND lease_expires_at > ?`,
    [
      mysqlDatetime(nowMs + input.leaseDurationMs),
      input.runId,
      taskKeyHash(input.taskKey),
      input.attemptId,
      input.leaseOwner,
      mysqlDatetime(nowMs),
    ],
  )) as [UpdateResult, unknown];
  if (result.affectedRows !== 1) {
    throw new BehaviorTaskLeaseError(
      "behavior_task_lease_lost",
      `run ${input.runId} task ${input.taskKey} attempt ${input.attemptId} no longer holds a live lease; abort execution without committing`,
    );
  }
}

/**
 * 条件提交终态结果：只有当前 attempt（run_id + task_key_hash + attempt_id + lease_owner +
 * status='running'）能写入。返回 false 表示该 attempt 已陈旧（租约被回收或已被提交），
 * 绝不覆盖既有 result_json；迟到但身份仍当前的提交（租约过期尚未被重领）允许落库。
 */
export async function commitBehaviorTaskResult(input: CommitTaskResultInput): Promise<boolean> {
  validateAttemptIdentity(input);
  if (input.outcome !== "extracted" && input.outcome !== "no_behavior" && input.outcome !== "unresolved") {
    throw new Error(`outcome must be extracted, no_behavior or unresolved, got ${String(input.outcome)}`);
  }
  requireNonNegativeInt(input.scenarioCount, "scenarioCount");
  requireNonNegativeInt(input.reviewedCount, "reviewedCount");
  requireNonNegativeInt(input.unresolvedAnchorCount, "unresolvedAnchorCount");
  const resultJson = JSON.stringify(input.result);
  const [result] = (await input.execute(
    `UPDATE analysis_behavior_tasks
        SET status = ?,
            result_json = ?,
            scenario_count = ?,
            reviewed_count = ?,
            unresolved_anchor_count = ?,
            last_error = NULL
      WHERE run_id = ?
        AND task_key_hash = ?
        AND attempt_id = ?
        AND lease_owner = ?
        AND status = 'running'`,
    [
      input.outcome,
      resultJson,
      input.scenarioCount,
      input.reviewedCount,
      input.unresolvedAnchorCount,
      input.runId,
      taskKeyHash(input.taskKey),
      input.attemptId,
      input.leaseOwner,
    ],
  )) as [UpdateResult, unknown];
  return result.affectedRows === 1;
}

/**
 * 标记当前 attempt 失败（status='failed' + last_error，等待定向重试）；陈旧 attempt 的
 * 迟到标记为 no-op，绝不覆盖新 attempt 的 running 状态。
 * abortedBeforeExecution=true 时改为恢复 pending 并清租约（首次 LLM 调用前放弃，
 * 预算走 releaseUnused 全额释放而非 settle），不记录伪失败、不消耗重试预算。
 */
export async function markBehaviorTaskFailure(input: TaskFailureInput): Promise<void> {
  validateAttemptIdentity(input);
  requireNonEmpty(input.error, "error");
  const hash = taskKeyHash(input.taskKey);
  if (input.abortedBeforeExecution === true) {
    await input.execute(
      `UPDATE analysis_behavior_tasks
          SET status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = NULL
        WHERE run_id = ?
          AND task_key_hash = ?
          AND attempt_id = ?
          AND lease_owner = ?
          AND status = 'running'`,
      [input.runId, hash, input.attemptId, input.leaseOwner],
    );
    return;
  }
  await input.execute(
    `UPDATE analysis_behavior_tasks
        SET status = 'failed',
            last_error = ?
      WHERE run_id = ?
        AND task_key_hash = ?
        AND attempt_id = ?
        AND lease_owner = ?
        AND status = 'running'`,
    [input.error, input.runId, hash, input.attemptId, input.leaseOwner],
  );
}

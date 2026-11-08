import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { getDb } from "../db";
import { RESERVATION_TTL_MINUTES, DEADLOCK_RETRIES, FIRST_RUN_UNITS, TRIAL_UNITS } from "./constants";

/**
 * 额度账务核心（契约 docs/codelphi-billing-ledger-contract.md v1.5 冻结版，M1-T2）。
 *
 * 全局锁序（契约 §6）：account → run → reserve_requests/reservations → wallets（wallet_id 升序）；
 * 操作只锁触及的最小实体集。死锁/锁等待超时做有限重试（DEADLOCK_RETRIES），BillingError 业务拒绝不重试。
 * 所有钱包/预留变更必须经本模块（唯一事实源纪律，契约 §2）；调用方只允许传参，不允许自带 SQL。
 *
 * 实现审查重点（评审指定，§14）：事务隔离级别行为、真实锁获取顺序、唯一键竞争回滚（D19 全新事务重读）、
 * ledger 重放与钱包快照一致性。
 */

/** 契约 §5 错误类型：调用方据此决定提示语义；BillingError 一律不触发死锁重试。 */
export type BillingErrorCode =
  | "idempotency_conflict"
  | "billing_state_conflict"
  | "quota_exceeded"
  | "reconciliation_hold"
  | "deadlock_retry_exhausted";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BillingError";
  }
}

export interface AllocationSnapshot {
  walletId: number;
  units: number;
}

export interface ReserveResult {
  attempt: number;
  allocations: AllocationSnapshot[];
  /** true = 命中持久请求记录返回原结果（同请求重试/迟到重放），未做任何新分配。 */
  reused: boolean;
  requestStatus?: string;
}

export interface RunSettlementResult {
  requestedActualUnits: number;
  capturedUnitsTotal: number;
  releasedUnitsTotal: number;
  unfundedUnits: number;
  runSettlementStatus: "fully_settled" | "partially_settled" | "unfunded";
  attemptSettlements: Array<{ attempt: number; captured: number; released: number; via: string }>;
  /** true = 读到既有 run 级结算请求（重复 capture 幂等返回），本次零变动。 */
  reused: boolean;
}

export interface ReleaseResult {
  released: boolean;
}

export interface HeartbeatResult {
  renewed: boolean;
}

export interface ReserveGateContext {
  conn: PoolConnection;
  account: AccountRow;
  runId: number;
  units: number;
}

export interface ReserveOptions {
  /**
   * 新任务闸门钩子（M1-T3 注入频率/并发/消费上限检查）；仅 reserveForNewRun 执行（D14：
   * 结算预留 reserveSettlementTopUp 不复用新任务闸门）。抛 BillingError 即拒绝。
   */
  gate?: (ctx: ReserveGateContext) => Promise<void>;
  /** 结算异常/部分结算的用户通知钩子（M4-T4 接通知系统前为空实现）。 */
  notify?: (event: { type: "partially_settled" | "unfunded"; runId: number; unfundedUnits: number }) => Promise<void>;
}

interface AccountRow {
  account_id: number;
  plan_id: string;
  plan_status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  reconciliation_hold: number;
}

interface WalletRow {
  wallet_id: number;
  quota_type: string;
  remaining_sau: number;
  reserved_sau: number;
}

interface ReservationRow {
  reservation_id: number;
  wallet_id: number;
  units: number;
  status: string;
  quota_type: string;
  /** 锁内读出的钱包当前余额——快照与绝对值写入的权威值（预检与分配同锁段，无 TOCTOU）。 */
  wallet_remaining: number;
  wallet_reserved: number;
}

interface ReserveRequestRow {
  request_id: string;
  run_id: number;
  account_id: number;
  requested_units: number;
  reservation_attempt: number;
  allocation_snapshot: string | null;
  status: string;
}

function isRetryableLockError(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  return code === "ER_LOCK_DEADLOCK" || code === "ER_LOCK_WAIT_TIMEOUT";
}

/** 契约 §6：死锁/锁等待超时有限重试；BillingError（业务拒绝）立即上抛不重试；重试耗尽 → deadlock_retry_exhausted。 */
async function runInBillingTransaction<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  for (let round = 1; round <= DEADLOCK_RETRIES; round += 1) {
    const conn = await getDb().getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      conn.release();
      return result;
    } catch (error) {
      try {
        await conn.rollback();
      } finally {
        conn.release();
      }
      if (error instanceof BillingError) throw error;
      if (!isRetryableLockError(error)) throw error;
      // 可重试锁错误：继续下一轮；轮次耗尽后由循环外抛 deadlock_retry_exhausted（契约 §5）
    }
  }
  throw new BillingError("deadlock_retry_exhausted", `lock contention persisted after ${DEADLOCK_RETRIES} retries`);
}

// ── 锁定原语（严格按锁序：account → run → requests/reservations → wallets）──

async function lockAccountForUpdate(conn: PoolConnection, accountId: number): Promise<AccountRow> {
  const [rows] = await conn.execute(
    `SELECT account_id, plan_id, plan_status, current_period_start, current_period_end, reconciliation_hold
     FROM billing_accounts WHERE account_id = ? FOR UPDATE`,
    [accountId],
  );
  const row = (rows as AccountRow[])[0];
  if (!row) throw new BillingError("billing_state_conflict", `billing account ${accountId} does not exist`);
  return row;
}

async function lockRunForUpdate(conn: PoolConnection, runId: number): Promise<{ id: number; account_id: number; billing_reservation_attempt: number }> {
  const [rows] = await conn.execute(
    `SELECT id, account_id, billing_reservation_attempt FROM analysis_runs WHERE id = ? FOR UPDATE`,
    [runId],
  );
  const row = (rows as Array<{ id: number; account_id: number; billing_reservation_attempt: number }>)[0];
  if (!row) throw new BillingError("billing_state_conflict", `analysis run ${runId} does not exist`);
  return row;
}

/** capture/release 未传 accountId：先无锁读固化归属（B13——归属创建后不变，预读安全），再按锁序锁 account。 */
async function readRunAccountId(conn: PoolConnection, runId: number): Promise<number> {
  const [rows] = await conn.execute(`SELECT account_id FROM analysis_runs WHERE id = ?`, [runId]);
  const row = (rows as Array<{ account_id: number | null }>)[0];
  if (!row?.account_id) throw new BillingError("billing_state_conflict", `analysis run ${runId} has no settled account ownership`);
  return Number(row.account_id);
}

async function selectReserveRequest(conn: PoolConnection, requestId: string): Promise<ReserveRequestRow | null> {
  const [rows] = await conn.execute(
    `SELECT request_id, run_id, account_id, requested_units, reservation_attempt, allocation_snapshot, status
     FROM billing_reserve_requests WHERE request_id = ?`,
    [requestId],
  );
  return (rows as ReserveRequestRow[])[0] ?? null;
}

async function lockAttemptReservations(conn: PoolConnection, runId: number, attempt: number): Promise<ReservationRow[]> {
  const [rows] = await conn.execute(
    `SELECT r.reservation_id, r.wallet_id, r.units, r.status, w.quota_type, w.remaining_sau AS wallet_remaining, w.reserved_sau AS wallet_reserved
     FROM billing_reservations r
     JOIN billing_quota_wallets w ON w.wallet_id = r.wallet_id
     WHERE r.run_id = ? AND r.reservation_attempt = ?
     ORDER BY r.wallet_id ASC
     FOR UPDATE`,
    [runId, attempt],
  );
  return rows as ReservationRow[];
}

/**
 * 钱包选择（契约 §3.2 四条件）+ 分摊顺序（§6.1：trial → plan → gift → pack，pack 按 expires_at FIFO）。
 * periodId 过滤延迟到 M3 履约落地（首发仅 trial 钱包，plan 钱包周期权威值由 M3-T4 定义）。
 */
async function lockWalletsForAllocation(
  conn: PoolConnection,
  accountId: number,
  options: { trialOnly: boolean },
): Promise<WalletRow[]> {
  const [rows] = await conn.execute(
    `SELECT wallet_id, quota_type, remaining_sau, reserved_sau
     FROM billing_quota_wallets
     WHERE account_id = ?
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW(3))
       ${options.trialOnly ? "AND quota_type = 'trial'" : ""}
     ORDER BY CASE quota_type WHEN 'trial' THEN 0 WHEN 'plan' THEN 1 WHEN 'gift' THEN 2 ELSE 3 END, expires_at ASC, wallet_id ASC
     FOR UPDATE`,
    [accountId],
  );
  return rows as WalletRow[];
}

/** 契约 §7.0 预留前状态判断——全系统唯一实现（路由/闸门禁止另写）。 */
export function assertReservationEligibility(account: AccountRow): void {
  if (account.reconciliation_hold) throw new BillingError("reconciliation_hold", "account is under reconciliation hold");
  if (account.plan_status === "grace" || account.plan_status === "expired") {
    throw new BillingError("billing_state_conflict", `account state ${account.plan_status} rejects new analysis`);
  }
  // trialing / active 合法：trialing 的额度来源由钱包选择层限制为 trial 钱包（契约 §7.0）
}

/** 计划给定行集的捕获/释放拆分：捕获按分摊顺序端优先，差额留在跨界行及其后（等价逆序退还，D5）。 */
function planCaptureAllocation(rows: ReservationRow[], actualUnits: number): Array<{ row: ReservationRow; captured: number; released: number }> {
  let need = actualUnits;
  return rows.map((row) => {
    const captured = Math.min(row.units, Math.max(need, 0));
    need -= captured;
    return { row, captured, released: row.units - captured };
  });
}

async function insertLedgerEntry(
  conn: PoolConnection,
  entry: {
    accountId: number;
    walletId: number;
    runId: number | null;
    idempotencyKey: string;
    reservationAttempt: number | null;
    action: string;
    quotaType: string;
    units: number;
    reason?: string | null;
    balanceAfterRemaining: number;
    balanceAfterReserved: number;
  },
) {
  await conn.execute(
    `INSERT INTO billing_ledger
      (account_id, wallet_id, run_id, idempotency_key, reservation_attempt, action, quota_type, units,
       reason, balance_after_remaining, balance_after_reserved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.accountId,
      entry.walletId,
      entry.runId,
      entry.idempotencyKey,
      entry.reservationAttempt,
      entry.action,
      entry.quotaType,
      entry.units,
      entry.reason ?? null,
      entry.balanceAfterRemaining,
      entry.balanceAfterReserved,
    ],
  );
}

/** 预留一行（reservations active + ledger reserved + 钱包 reserved += alloc），balance 快照按行写入。 */
async function reserveWalletSlice(
  conn: PoolConnection,
  input: { runId: number; attempt: number; accountId: number; wallet: WalletRow; units: number },
) {
  const { wallet } = input;
  await conn.execute(
    `INSERT INTO billing_reservations (run_id, reservation_attempt, account_id, wallet_id, units, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'active', DATE_ADD(NOW(3), INTERVAL ? MINUTE))`,
    [input.runId, input.attempt, input.accountId, wallet.wallet_id, input.units, RESERVATION_TTL_MINUTES],
  );
  await insertLedgerEntry(conn, {
    accountId: input.accountId,
    walletId: wallet.wallet_id,
    runId: input.runId,
    idempotencyKey: `rsv:${input.runId}:${input.attempt}:${wallet.wallet_id}`,
    reservationAttempt: input.attempt,
    action: "reserved",
    quotaType: wallet.quota_type,
    units: input.units,
    balanceAfterRemaining: wallet.remaining_sau,
    balanceAfterReserved: wallet.reserved_sau + input.units,
  });
  // 绝对值写入（锁内读旧值计算）：不依赖 UPDATE SET 的求值顺序；balance_after_* 为本行写入后的钱包快照（契约 §2）
  const newReserved = wallet.reserved_sau + input.units;
  await conn.execute(
    `UPDATE billing_quota_wallets
     SET reserved_sau = ?, balance_after_remaining = ?, balance_after_reserved = ?
     WHERE wallet_id = ?`,
    [newReserved, wallet.remaining_sau, newReserved, wallet.wallet_id],
  );
}

/** 结算一行的捕获/释放写入：钱包两列扣减 + ledger captured/released + reservation 终态。 */
async function settleReservationSlice(
  conn: PoolConnection,
  input: { runId: number; attempt: number; accountId: number; row: ReservationRow; captured: number; released: number },
) {
  const { row } = input;
  // 快照 = 本行写入后的钱包余额（该 attempt 内每钱包恰一行，行内捕获+释放一次完成）
  const newRemaining = row.wallet_remaining - input.captured;
  const newReserved = row.wallet_reserved - row.units;
  if (input.captured > 0) {
    await insertLedgerEntry(conn, {
      accountId: input.accountId,
      walletId: row.wallet_id,
      runId: input.runId,
      idempotencyKey: `cap:${input.runId}:${input.attempt}:${row.wallet_id}`,
      reservationAttempt: input.attempt,
      action: "captured",
      quotaType: row.quota_type,
      units: input.captured,
      balanceAfterRemaining: newRemaining,
      balanceAfterReserved: newReserved,
    });
  }
  if (input.released > 0) {
    await insertLedgerEntry(conn, {
      accountId: input.accountId,
      walletId: row.wallet_id,
      runId: input.runId,
      idempotencyKey: `rel:${input.runId}:${input.attempt}:${row.wallet_id}:settlement_difference`,
      reservationAttempt: input.attempt,
      action: "released",
      quotaType: row.quota_type,
      units: input.released,
      reason: "settlement_difference",
      balanceAfterRemaining: newRemaining,
      balanceAfterReserved: newReserved,
    });
  }
  await conn.execute(
    `UPDATE billing_quota_wallets
     SET remaining_sau = ?, reserved_sau = ?, balance_after_remaining = ?, balance_after_reserved = ?
     WHERE wallet_id = ?`,
    [newRemaining, newReserved, newRemaining, newReserved, row.wallet_id],
  );
  await conn.execute(`UPDATE billing_reservations SET status = 'captured' WHERE reservation_id = ?`, [row.reservation_id]);
}

async function insertSettlement(
  conn: PoolConnection,
  input: { runId: number; attempt: number; accountId: number; original: number; captured: number; released: number; via: string },
) {
  await conn.execute(
    `INSERT INTO billing_settlements
      (run_id, reservation_attempt, account_id, original_units, captured_units, released_units, status, via, per_wallet_json)
     VALUES (?, ?, ?, ?, ?, ?, 'settled', ?, NULL)`,
    [input.runId, input.attempt, input.accountId, input.original, input.captured, input.released, input.via],
  );
}

/** run 级状态映射（D20）：unfunded=0 → fully_settled；captured>0 且 unfunded>0 → partially_settled；captured=0 且 unfunded>0 → unfunded。 */
export function runSettlementStatus(capturedTotal: number, unfundedUnits: number): RunSettlementResult["runSettlementStatus"] {
  if (unfundedUnits === 0) return "fully_settled";
  if (capturedTotal > 0) return "partially_settled";
  return "unfunded";
}

/** 结算异常（D4）：INSERT IGNORE 幂等——exception 已存在则不动；attempt = 与异常直接关联的最后已持久化 attempt（§4.6）。 */
async function insertSettlementException(
  conn: PoolConnection,
  input: { runId: number; attempt: number; accountId: number; type: string; actual: number; captured: number; unfunded: number },
) {
  await conn.execute(
    `INSERT IGNORE INTO billing_settlement_exceptions
      (run_id, reservation_attempt, account_id, exception_type, actual_units, captured_units, unfunded_units, idempotency_key, reconciliation_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    [input.runId, input.attempt, input.accountId, input.type, input.actual, input.captured, input.unfunded, `exc:${input.runId}:${input.attempt}:${input.type}`],
  );
}

async function mirrorRequestStatus(conn: PoolConnection, runId: number, attempt: number, status: string) {
  await conn.execute(`UPDATE billing_reserve_requests SET status = ? WHERE run_id = ? AND reservation_attempt = ?`, [status, runId, attempt]);
}

async function insertRunSettlementRequest(
  conn: PoolConnection,
  input: {
    runId: number;
    accountId: number;
    requestedActualUnits: number;
    capturedTotal: number;
    releasedTotal: number;
    unfunded: number;
    attemptsUsed: number[];
  },
): Promise<RunSettlementResult> {
  const status = runSettlementStatus(input.capturedTotal, input.unfunded);
  await conn.execute(
    `INSERT INTO billing_settlement_requests
      (request_id, run_id, account_id, requested_actual_units, captured_units_total, released_units_total, unfunded_units, run_settlement_status, attempts_used_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.runId,
      input.accountId,
      input.requestedActualUnits,
      input.capturedTotal,
      input.releasedTotal,
      input.unfunded,
      status,
      JSON.stringify(input.attemptsUsed),
    ],
  );
  return {
    requestedActualUnits: input.requestedActualUnits,
    capturedUnitsTotal: input.capturedTotal,
    releasedUnitsTotal: input.releasedTotal,
    unfundedUnits: input.unfunded,
    runSettlementStatus: status,
    attemptSettlements: [],
    reused: false,
  };
}

// ── 对外操作 ──

/**
 * 新任务预留（契约 §6.1）：请求幂等（D13/D16/D18）→ 指纹校验 → 闸门（唯一状态判断）→ 终结校验 →
 * attempt 权威递增（D11）→ 多钱包分摊（单事务）→ 请求行落库。
 * 并发唯一键冲突（D19）：请求行 INSERT 撞 `request_id` 唯一键 → 整体回滚 → 全新事务重读 → 指纹收敛；
 * 重读始终查无 = 并发异常，有限重试，不得创建新 attempt。
 */
export async function reserveForNewRun(
  runId: number,
  accountId: number,
  units: number,
  requestId: string,
  options: ReserveOptions = {},
): Promise<ReserveResult> {
  try {
    return await runInBillingTransaction((conn) => reserveForNewRunInTransaction(conn, runId, accountId, units, requestId, options));
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "ER_DUP_ENTRY") throw error;
    // D19 收敛：唯一键冲突的写入已随事务回滚；在全新事务中重读持久记录并按指纹收敛
    for (let retry = 0; retry < DEADLOCK_RETRIES; retry += 1) {
      const existing = await runInBillingTransaction(async (conn) => selectReserveRequest(conn, requestId));
      if (!existing) continue;
      const fingerprintMatches = existing.run_id === runId && existing.account_id === accountId && existing.requested_units === units;
      if (!fingerprintMatches) throw new BillingError("idempotency_conflict", `request ${requestId} was created with different parameters`);
      let allocations: AllocationSnapshot[] = [];
      try {
        allocations = existing.allocation_snapshot ? (JSON.parse(existing.allocation_snapshot) as AllocationSnapshot[]) : [];
      } catch {
        allocations = [];
      }
      return { attempt: existing.reservation_attempt, allocations, reused: true, requestStatus: existing.status };
    }
    throw new BillingError("billing_state_conflict", `request ${requestId} clash cleared but the request record never became visible`);
  }
}

/**
 * 事务内新任务预留（供入队组合使用）：调用方持有事务与 account/run 锁序；
 * 本函数不做死锁重试（外层事务负责），异常随外层事务回滚。
 */
export async function reserveForNewRunInTransaction(
  conn: PoolConnection,
  runId: number,
  accountId: number,
  units: number,
  requestId: string,
  options: ReserveOptions = {},
): Promise<ReserveResult> {
  {
    const account = await lockAccountForUpdate(conn, accountId);
    const run = await lockRunForUpdate(conn, runId);
    if (Number(run.account_id) !== Number(accountId)) {
      throw new BillingError("billing_state_conflict", `run ${runId} belongs to account ${run.account_id}, not ${accountId}`);
    }

    // 请求幂等（D13/D16/D18）：命中先于闸门——账户状态后续变化不阻断旧请求合法重放
    const existing = await selectReserveRequest(conn, requestId);
    if (existing) {
      const fingerprintMatches = existing.run_id === runId && existing.account_id === accountId && existing.requested_units === units;
      if (!fingerprintMatches) throw new BillingError("idempotency_conflict", `request ${requestId} was created with different parameters`);
      let allocations: AllocationSnapshot[] = [];
      try {
        allocations = existing.allocation_snapshot ? (JSON.parse(existing.allocation_snapshot) as AllocationSnapshot[]) : [];
      } catch {
        allocations = [];
      }
      return { attempt: existing.reservation_attempt, allocations, reused: true, requestStatus: existing.status };
    }

    // 新任务闸门（唯一状态判断 + 可注入的频率/并发/消费上限）
    assertReservationEligibility(account);
    if (options.gate) await options.gate({ conn, account, runId, units });

    // attempt 终结校验（D12）：前序 attempt 全部 reservations 无 active 行才允许新 attempt
    const [activeRows] = await conn.execute(
      `SELECT reservation_id FROM billing_reservations WHERE run_id = ? AND reservation_attempt = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
      [runId, run.billing_reservation_attempt],
    );
    if ((activeRows as unknown[]).length > 0) {
      throw new BillingError("billing_state_conflict", `run ${runId} attempt ${run.billing_reservation_attempt} still has active reservations`);
    }

    const attempt = run.billing_reservation_attempt + 1;
    await conn.execute(`UPDATE analysis_runs SET billing_reservation_attempt = ? WHERE id = ?`, [attempt, runId]);

    // 多钱包分摊（D3）：trial → plan → gift → pack（pack FIFO）；trialing 只允许 trial 钱包（§7.0）
    const trialOnly = account.plan_status === "trialing";
    const wallets = await lockWalletsForAllocation(conn, accountId, { trialOnly });
    let need = units;
    const plan: Array<{ wallet: WalletRow; units: number }> = [];
    for (const wallet of wallets) {
      const available = wallet.remaining_sau - wallet.reserved_sau;
      const alloc = Math.min(available, need);
      if (alloc > 0) {
        plan.push({ wallet, units: alloc });
        need -= alloc;
      }
      if (need === 0) break;
    }
    if (need > 0) throw new BillingError("quota_exceeded", `available ${units - need} SAU is below requested ${units} SAU`);

    const allocations: AllocationSnapshot[] = [];
    for (const item of plan) {
      await reserveWalletSlice(conn, { runId, attempt, accountId, wallet: item.wallet, units: item.units });
      allocations.push({ walletId: item.wallet.wallet_id, units: item.units });
    }
    await conn.execute(
      `INSERT INTO billing_reserve_requests (request_id, run_id, account_id, requested_units, reservation_attempt, allocation_snapshot, status)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved')`,
      [requestId, runId, accountId, units, attempt, JSON.stringify(allocations)],
    );
    return { attempt, allocations, reused: false };
  }
}

/**
 * 结算专用预留（D14/D16，仅 capture 内部调用）：不做订阅状态机/频率/并发/消费上限检查；
 * 钱包锁持有段内预检（预检与分配同锁段同权威值）；不足返回 quota_exceeded 且零持久变更（无空 attempt）；
 * 自行负责 attempt 递增。调用前置：外层事务已持有 account 与 run 行锁（v1.5 锁序精确化）。
 */
async function reserveSettlementTopUp(
  conn: PoolConnection,
  runId: number,
  account: AccountRow,
  units: number,
  purpose: "overage_topup" | "expired_rekill",
): Promise<{ ok: true; attempt: number } | { ok: false }> {
  if (account.reconciliation_hold) return { ok: false };
  const run = await lockRunForUpdate(conn, runId);
  const wallets = await lockWalletsForAllocation(conn, account.account_id, { trialOnly: false });
  let need = units;
  const plan: Array<{ wallet: WalletRow; units: number }> = [];
  for (const wallet of wallets) {
    const available = wallet.remaining_sau - wallet.reserved_sau;
    const alloc = Math.min(available, need);
    if (alloc > 0) {
      plan.push({ wallet, units: alloc });
      need -= alloc;
    }
    if (need === 0) break;
  }
  if (need > 0) return { ok: false };

  const attempt = run.billing_reservation_attempt + 1;
  await conn.execute(`UPDATE analysis_runs SET billing_reservation_attempt = ? WHERE id = ?`, [attempt, runId]);
  for (const item of plan) {
    await reserveWalletSlice(conn, { runId, attempt, accountId: account.account_id, wallet: item.wallet, units: item.units });
  }
  // 预留随即结算（D7 链）：同锁段内捕获全额
  const rows = await lockAttemptReservations(conn, runId, attempt);
  const allocation = planCaptureAllocation(rows, units);
  for (const item of allocation) {
    await settleReservationSlice(conn, { runId, attempt, accountId: account.account_id, row: item.row, captured: item.captured, released: item.released });
  }
  await insertSettlement(conn, {
    runId,
    attempt,
    accountId: account.account_id,
    original: units,
    captured: units,
    released: 0,
    via: purpose,
  });
  return { ok: true, attempt };
}

// ── Trial 授权（契约 M1-T4）：发放 = trial_grants 行 + Trial 钱包 + granted 流水，同一事务；──
// 并发幂等靠 trial_grants.user_id 主键 + 钱包 source_key 唯一双保险；归属冻结见契约 P1-3
// （仅个人工作区创建触发；owner 转移不迁移；授权永久保留原 user_id + account_id）。

export interface TrialGrantResult {
  granted: boolean;
}

/** 幂等哨兵：授权行已存在 → 事务回滚（无任何写入）后按 granted:false 返回。 */
class TrialAlreadyGranted extends Error {}

export async function grantTrialQuota(input: { userId: number; accountId: number; source: "workspace_creation" | "backfill"; units?: number }): Promise<TrialGrantResult> {
  const units = input.units ?? TRIAL_UNITS;
  try {
    return await runInBillingTransaction(async (conn) => {
      try {
        await conn.execute(
          `INSERT INTO trial_grants (user_id, account_id, granted_units, source) VALUES (?, ?, ?, ?)`,
          [input.userId, input.accountId, units, input.source],
        );
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") throw new TrialAlreadyGranted();
        throw error;
      }
      const sourceKey = `trial:${input.userId}`;
      const [walletRows] = await conn.execute(
        `INSERT INTO billing_quota_wallets (account_id, quota_type, remaining_sau, reserved_sau, source_key, status, balance_after_remaining, balance_after_reserved)
         VALUES (?, 'trial', ?, 0, ?, 'active', ?, 0)`,
        [input.accountId, units, sourceKey, units],
      );
      const walletId = Number((walletRows as { insertId: number }).insertId);
      await insertLedgerEntry(conn, {
        accountId: input.accountId,
        walletId,
        runId: null,
        idempotencyKey: `grt:trial:${input.userId}:trial`,
        reservationAttempt: null,
        action: "granted",
        quotaType: "trial",
        units,
        balanceAfterRemaining: units,
        balanceAfterReserved: 0,
      });
      return { granted: true };
    });
  } catch (error) {
    if (error instanceof TrialAlreadyGranted) return { granted: false };
    throw error;
  }
}

// ── 预留 TTL 清理（契约 §6.5，M1-T6）：处置核心在 core（账务写唯一入口），调度骨架在 sweep.ts ──

export interface StaleReservationSweepResult {
  renewed: number;
  expired: number;
  released: number;
  /** 处置中遇到账面不一致（如钱包不变式违反）的行数——已写 inconsistent exception，待人工对账。 */
  errored: number;
  /** succeeded 且缺 run 级结算请求的 run——由调用方（sweep）逐个触发 capture 恢复结算（D15：不释放其预留）。 */
  recoveryRunIds: number[];
}

interface StaleCandidateRow {
  reservation_id: number;
  run_id: number;
  reservation_attempt: number;
  account_id: number;
  wallet_id: number;
  units: number;
}

/**
 * 过期预留处置（契约 §6.5 五行处置表）。调用方持有 GET_LOCK 的连接（B6：锁与语句同连接）；
 * 逐候选先锁 run 再锁 reservation（锁序），reservation 重读非 active 即跳过（与 release/sweep 收敛）。
 * succeeded 分支不在此处置（扫描二由调用方触发 capture 恢复结算，D15）。
 */
export async function expireStaleReservationsOnce(
  conn: PoolConnection,
  options: { freshWindowMinutes: number; ttlMinutes: number; limit?: number },
): Promise<StaleReservationSweepResult> {
  const result: StaleReservationSweepResult = { renewed: 0, expired: 0, released: 0, errored: 0, recoveryRunIds: [] };
  const [candidates] = await conn.execute(
    `SELECT r.reservation_id, r.run_id, r.reservation_attempt, r.account_id, r.wallet_id, r.units
     FROM billing_reservations r
     WHERE r.status = 'active' AND r.expires_at <= NOW(3)
     ORDER BY r.reservation_id ASC
     LIMIT ?`,
    [options.limit ?? 200],
  );
  for (const candidate of candidates as StaleCandidateRow[]) {
    try {
    // 锁序：先 run 后 reservation（契约 §6 全局锁序）；心跳新鲜度在锁内用 SQL 墙钟判定（时区坑规避）
    const [runRows] = await conn.execute(
      `SELECT id, status, (last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= DATE_SUB(NOW(3), INTERVAL ? MINUTE)) AS heartbeatFresh
       FROM analysis_runs WHERE id = ? FOR UPDATE`,
      [options.freshWindowMinutes, candidate.run_id],
    );
    const run = (runRows as Array<{ id: number; status: string; heartbeatFresh: number }>)[0] ?? null;
    if (!run) continue;
    const [resRows] = await conn.execute(
      `SELECT reservation_id, wallet_id, units, status FROM billing_reservations WHERE reservation_id = ? FOR UPDATE`,
      [candidate.reservation_id],
    );
    const reservation = (resRows as Array<{ reservation_id: number; wallet_id: number; units: number; status: string }>)[0];
    if (!reservation || reservation.status !== "active") continue; // 与 release/sweep 收敛：已被结清

    if (run.status === "succeeded") {
      // 扫描二（D15）：成功 run 的结算恢复走 capture，不在此释放
      if (!result.recoveryRunIds.includes(Number(run.id))) result.recoveryRunIds.push(Number(run.id));
      continue;
    }

    if (run.status === "running") {
      if (Number(run.heartbeatFresh) === 1) {
        // 心跳新鲜：续期跳过（只延 expires_at，不写 ledger、不动钱包）
        await conn.execute(
          `UPDATE billing_reservations SET expires_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE reservation_id = ?`,
          [options.ttlMinutes, reservation.reservation_id],
        );
        result.renewed += 1;
        continue;
      }
      // 心跳过期：释放预留（run 保持 running，交超时/恢复机制终态；其 capture/release 遇非 active 行幂等收敛）
      await expireReservationRow(conn, {
        runId: candidate.run_id,
        attempt: candidate.reservation_attempt,
        reservationId: reservation.reservation_id,
        accountId: candidate.account_id,
        walletId: reservation.wallet_id,
        units: reservation.units,
        requestMirror: "expired",
        reason: "ttl_expired",
      });
      result.expired += 1;
      continue;
    }

    if (run.status === "failed" || run.status === "canceled") {
      // 失败路径 release 未达（崩溃/竞态）→ 此处置收敛（与失败路径 release 行锁先到先得）
      await expireReservationRow(conn, {
        runId: candidate.run_id,
        attempt: candidate.reservation_attempt,
        reservationId: reservation.reservation_id,
        accountId: candidate.account_id,
        walletId: reservation.wallet_id,
        units: reservation.units,
        requestMirror: "released",
        reason: "analysis_failed",
      });
      result.released += 1;
      continue;
    }

    // queued 悬挂（无 running 无心跳）：同 running 过期行处置
    await expireReservationRow(conn, {
      runId: candidate.run_id,
      attempt: candidate.reservation_attempt,
      reservationId: reservation.reservation_id,
      accountId: candidate.account_id,
      walletId: reservation.wallet_id,
      units: reservation.units,
      requestMirror: "expired",
      reason: "ttl_expired",
    });
    result.expired += 1;
    } catch (error) {
      // 单行处置失败（如账面不变式违反）：写 inconsistent exception + 计数告警，继续下一行——
      // 不静默平账（契约 §11.2 第 4 条），不阻断整批
      console.error("[billing] sweep disposal failed for reservation", { reservationId: candidate.reservation_id, error });
      try {
        await insertSettlementException(conn, {
          runId: candidate.run_id,
          attempt: candidate.reservation_attempt,
          accountId: candidate.account_id,
          type: "inconsistent_reservation",
          actual: candidate.units,
          captured: 0,
          unfunded: candidate.units,
        });
      } catch {
        /* exception 写失败也要继续 */
      }
      result.errored += 1;
    }
  }
  return result;
}

/** 过期/悬挂预留的释放写入：ledger released + 钱包绝对值回减 + reservation 终态 + 请求行状态镜像。 */
async function expireReservationRow(
  conn: PoolConnection,
  input: {
    runId: number;
    attempt: number;
    reservationId: number;
    accountId: number;
    walletId: number;
    units: number;
    requestMirror: "expired" | "released";
    reason: string;
  },
) {
  const [walletRows] = await conn.execute(
    `SELECT remaining_sau AS remainingSau, reserved_sau AS reservedSau, quota_type FROM billing_quota_wallets WHERE wallet_id = ? FOR UPDATE`,
    [input.walletId],
  );
  const wallet = (walletRows as Array<{ remainingSau: number; reservedSau: number; quota_type: string }>)[0];
  if (!wallet) return;
  const newReserved = wallet.reservedSau - input.units;
  await insertLedgerEntry(conn, {
    accountId: input.accountId,
    walletId: input.walletId,
    runId: input.runId,
    idempotencyKey: `rel:${input.runId}:${input.attempt}:${input.walletId}:${input.reason}`,
    reservationAttempt: input.attempt,
    action: "released",
    quotaType: wallet.quota_type,
    units: input.units,
    reason: input.reason,
    balanceAfterRemaining: wallet.remainingSau,
    balanceAfterReserved: newReserved,
  });
  await conn.execute(
    `UPDATE billing_quota_wallets SET reserved_sau = ?, balance_after_remaining = ?, balance_after_reserved = ? WHERE wallet_id = ?`,
    [newReserved, wallet.remainingSau, newReserved, input.walletId],
  );
  await conn.execute(`UPDATE billing_reservations SET status = 'expired' WHERE reservation_id = ?`, [input.reservationId]);
  await conn.execute(`UPDATE billing_reserve_requests SET status = ? WHERE run_id = ? AND reservation_attempt = ?`, [input.requestMirror, input.runId, input.attempt]);
}

// ── 入队组合（契约 §9：锁 account → INSERT run（attempt=0）→ reserveForNewRun，同一事务）──

export interface EnqueueInput {
  repositoryId: number;
  beforeSha: string | null;
  afterSha: string;
  trigger: "manual" | "push";
  /** reserve 请求身份：每次入队调用生成新 UUID（同请求网络重试才复用同 ID）。 */
  requestId: string;
  gate?: ReserveOptions["gate"];
}

export interface EnqueueResult {
  runId: number;
  attempt: number | null;
  allocations: AllocationSnapshot[];
  /** true = 复用既有活跃 run（同 sha）或并发竞争收敛到赢家，本次未创建新 run/预留。 */
  reused: boolean;
}

async function resolveRunOwnership(conn: PoolConnection, repositoryId: number): Promise<number> {
  const [rows] = await conn.execute(
    `SELECT p.organization_id AS organizationId
     FROM repositories repo JOIN products p ON p.id = repo.product_id
     WHERE repo.id = ?`,
    [repositoryId],
  );
  const row = (rows as Array<{ organizationId: number | null }>)[0];
  if (!row?.organizationId) throw new BillingError("billing_state_conflict", `repository ${repositoryId} has no owning organization`);
  return Number(row.organizationId);
}

async function findActiveRunRow(conn: PoolConnection, repositoryId: number, afterSha: string): Promise<number | null> {
  const [rows] = await conn.execute(
    `SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ? AND status IN ('queued', 'running') LIMIT 1`,
    [repositoryId, afterSha],
  );
  const row = (rows as Array<{ id: number }>)[0];
  return row ? Number(row.id) : null;
}

/** 事务内入队全流程（供两阶段投递的持有事务方调用）；调用方负责死锁重试与 D19/020 冲突收敛。 */
export async function enqueueRunWithReservationInTransaction(conn: PoolConnection, input: EnqueueInput): Promise<EnqueueResult> {
  const accountId = await resolveRunOwnership(conn, input.repositoryId);
  const account = await lockAccountForUpdate(conn, accountId);
  const existingRunId = await findActiveRunRow(conn, input.repositoryId, input.afterSha);
  if (existingRunId !== null) return { runId: existingRunId, attempt: null, allocations: [], reused: true };

  const [insertResult] = await conn.execute(
    `INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status, account_id)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
    [input.repositoryId, input.trigger, input.beforeSha, input.afterSha, accountId],
  );
  const runId = Number((insertResult as { insertId: number }).insertId);
  const reserve = await reserveForNewRunInTransaction(conn, runId, accountId, FIRST_RUN_UNITS, input.requestId, { gate: input.gate });
  return { runId, attempt: reserve.attempt, allocations: reserve.allocations, reused: false };
}

/**
 * 入队组合（契约 §9）：单事务完成「锁 account → INSERT run → 预留」；
 * 收敛两条唯一键竞争——run 表 020 活跃唯一（回滚后复用赢家）与 reserve_requests 主键（D19 指纹收敛）；
 * 非唯一键冲突原样上抛（死锁重试由事务执行器自理）。
 */
export async function enqueueRunWithReservation(input: EnqueueInput): Promise<EnqueueResult> {
  for (let round = 1; round <= DEADLOCK_RETRIES; round += 1) {
    try {
      return await runInBillingTransaction((conn) => enqueueRunWithReservationInTransaction(conn, input));
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "ER_DUP_ENTRY" || round >= DEADLOCK_RETRIES) throw error;
      // 已回滚：全新事务收敛（D19：先指纹读请求记录；020：再找活跃赢家）；都未命中则重试完整流程
      const converged = await runInBillingTransaction(async (conn) => {
        const accountId = await resolveRunOwnership(conn, input.repositoryId);
        const existing = await selectReserveRequest(conn, input.requestId);
        if (existing && existing.run_id && existing.account_id === accountId) {
          let allocations: AllocationSnapshot[] = [];
          try {
            allocations = existing.allocation_snapshot ? (JSON.parse(existing.allocation_snapshot) as AllocationSnapshot[]) : [];
          } catch {
            allocations = [];
          }
          return { runId: Number(existing.run_id), attempt: existing.reservation_attempt, allocations, reused: true };
        }
        const winner = await findActiveRunRow(conn, input.repositoryId, input.afterSha);
        if (winner !== null) return { runId: winner, attempt: null, allocations: [], reused: true };
        return null;
      });
      if (converged) return converged;
    }
  }
  throw new BillingError("billing_state_conflict", `enqueue clash for repository ${input.repositoryId} sha ${input.afterSha} did not converge`);
}

/** 账户当前可用 SAU（trial+plan+gift+pack 有效钱包的 remaining-reserved 之和；§3.2 四条件简化读取）。 */
export async function availableSau(accountId: number): Promise<number> {
  const [rows] = await getDb().execute(
    `SELECT COALESCE(SUM(remaining_sau - reserved_sau), 0) AS available
     FROM billing_quota_wallets
     WHERE account_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW(3))`,
    [accountId],
  );
  return Number((rows as Array<{ available: number }>)[0]?.available ?? 0);
}

/** 执行入口预留检查（契约 §6.6/§9）：run 是否存在 active 预留。 */
export async function hasActiveReservation(runId: number): Promise<boolean> {
  const [rows] = await getDb().execute(
    `SELECT reservation_id FROM billing_reservations WHERE run_id = ? AND status = 'active' LIMIT 1`,
    [runId],
  );
  return (rows as unknown[]).length > 0;
}

/** 契约 §5 错误码 → HTTP 状态映射（路由层使用）。 */
export function billingHttpStatus(code: BillingErrorCode): number {
  switch (code) {
    case "quota_exceeded":
      return 402;
    case "reconciliation_hold":
    case "billing_state_conflict":
    case "idempotency_conflict":
      return 409;
    default:
      return 409;
  }
}

/**
 * run 级结算（契约 §6.4）：run 级请求幂等（D8）→ 四状态分支（D10）→ 正常/超额/过期三条结算链（D7/D16）→
 * settlements（每参与 attempt）+ requests（一次写终态，D20 映射）+ 请求行状态镜像。
 * capture 失败不得改写 run 的分析状态（D15）——由调用方保证：捕获在 saveResult 提交后触发，错误只告警。
 */
export async function capture(runId: number, actualUnits: number, options: ReserveOptions = {}): Promise<RunSettlementResult> {
  return runInBillingTransaction(async (conn) => {
    const accountId = await readRunAccountId(conn, runId);
    const account = await lockAccountForUpdate(conn, accountId);
    const run = await lockRunForUpdate(conn, runId);

    // 第 0 步：run 级幂等（D8）
    const [existingRows] = await conn.execute(
      `SELECT request_id, requested_actual_units, captured_units_total, released_units_total, unfunded_units, run_settlement_status
       FROM billing_settlement_requests WHERE run_id = ?`,
      [runId],
    );
    const existing = (existingRows as Array<{
      request_id: string;
      requested_actual_units: number;
      captured_units_total: number;
      released_units_total: number;
      unfunded_units: number;
      run_settlement_status: RunSettlementResult["runSettlementStatus"];
    }>)[0];
    if (existing) {
      if (existing.requested_actual_units !== actualUnits) {
        throw new BillingError("idempotency_conflict", `run ${runId} was settled with requested_actual_units=${existing.requested_actual_units}`);
      }
      return {
        requestedActualUnits: existing.requested_actual_units,
        capturedUnitsTotal: existing.captured_units_total,
        releasedUnitsTotal: existing.released_units_total,
        unfundedUnits: existing.unfunded_units,
        runSettlementStatus: existing.run_settlement_status,
        attemptSettlements: [],
        reused: true,
      };
    }

    const attempt = run.billing_reservation_attempt;
    if (attempt <= 0) throw new BillingError("billing_state_conflict", `run ${runId} has no reservation attempt to settle`);
    const rows = await lockAttemptReservations(conn, runId, attempt);
    const statuses = new Set(rows.map((row) => row.status));

    // 第 1 步：四状态分支（D10）
    if (statuses.size > 1) {
      // 混合状态 = 账务异常：禁止猜测补救（多钱包分摊本应同事务同状态）
      await insertSettlementException(conn, { runId, attempt, accountId, type: "inconsistent_reservation", actual: actualUnits, captured: 0, unfunded: actualUnits });
      throw new BillingError("billing_state_conflict", `run ${runId} attempt ${attempt} has mixed reservation statuses; reconciliation required`);
    }
    const state = rows.length === 0 ? "none" : [...statuses][0];

    if (state === "captured") {
      // settlements 应已在第 0 步命中；无记录 = 账务异常
      await insertSettlementException(conn, { runId, attempt, accountId, type: "inconsistent_reservation", actual: actualUnits, captured: 0, unfunded: actualUnits });
      throw new BillingError("billing_state_conflict", `run ${runId} attempt ${attempt} is captured without a settlement record`);
    }
    if (state === "released" || state === "none") {
      throw new BillingError("billing_state_conflict", `run ${runId} attempt ${attempt} was released; re-analysis goes through run re-dispatch`);
    }

    if (state === "active") {
      // 第 2 步：正常/差额/超额结算
      const totalReserved = rows.reduce((sum, row) => sum + row.units, 0);
      if (actualUnits <= totalReserved) {
        const allocation = planCaptureAllocation(rows, actualUnits);
        let captured = 0;
        let released = 0;
        for (const item of allocation) {
          await settleReservationSlice(conn, { runId, attempt, accountId, row: item.row, captured: item.captured, released: item.released });
          captured += item.captured;
          released += item.released;
        }
        await insertSettlement(conn, { runId, attempt, accountId, original: totalReserved, captured, released, via: "normal" });
        await mirrorRequestStatus(conn, runId, attempt, "captured");
        return insertRunSettlementRequest(conn, {
          runId,
          accountId,
          requestedActualUnits: actualUnits,
          capturedTotal: captured,
          releasedTotal: released,
          unfunded: 0,
          attemptsUsed: [attempt],
        });
      }

      // 超额（D7 + D16）：同事务先结清原 attempt，再 top-up 差额
      for (const row of rows) {
        await settleReservationSlice(conn, { runId, attempt, accountId, row, captured: row.units, released: 0 });
      }
      await insertSettlement(conn, { runId, attempt, accountId, original: totalReserved, captured: totalReserved, released: 0, via: "normal" });
      await mirrorRequestStatus(conn, runId, attempt, "captured");
      const shortfall = actualUnits - totalReserved;
      const topUp = await reserveSettlementTopUp(conn, runId, account, shortfall, "overage_topup");
      if (topUp.ok) {
        await insertRunSettlementRequest(conn, {
          runId,
          accountId,
          requestedActualUnits: actualUnits,
          capturedTotal: actualUnits,
          releasedTotal: 0,
          unfunded: 0,
          attemptsUsed: [attempt, topUp.attempt],
        });
        return {
          requestedActualUnits: actualUnits,
          capturedUnitsTotal: actualUnits,
          releasedUnitsTotal: 0,
          unfundedUnits: 0,
          runSettlementStatus: "fully_settled",
          attemptSettlements: [
            { attempt, captured: totalReserved, released: 0, via: "normal" },
            { attempt: topUp.attempt, captured: shortfall, released: 0, via: "overage_topup" },
          ],
          reused: false,
        };
      }
      // top-up 不足：原 attempt 捕获照常提交（本事务），差额进 exception（attempt = 原已捕获 attempt）
      await insertRunSettlementRequest(conn, {
        runId,
        accountId,
        requestedActualUnits: actualUnits,
        capturedTotal: totalReserved,
        releasedTotal: 0,
        unfunded: shortfall,
        attemptsUsed: [attempt],
      });
      await insertSettlementException(conn, { runId, attempt, accountId, type: "unfunded_usage", actual: actualUnits, captured: totalReserved, unfunded: shortfall });
      if (options.notify) {
        await options.notify({ type: "partially_settled", runId, unfundedUnits: shortfall });
      }
      return {
        requestedActualUnits: actualUnits,
        capturedUnitsTotal: totalReserved,
        releasedUnitsTotal: 0,
        unfundedUnits: shortfall,
        runSettlementStatus: "partially_settled",
        attemptSettlements: [{ attempt, captured: totalReserved, released: 0, via: "normal" }],
        reused: false,
      };
    }

    // 第 3 步：过期路径（全部 expired——预留已被 sweep 释放）
    const topUp = await reserveSettlementTopUp(conn, runId, account, actualUnits, "expired_rekill");
    if (topUp.ok) {
      await insertRunSettlementRequest(conn, {
        runId,
        accountId,
        requestedActualUnits: actualUnits,
        capturedTotal: actualUnits,
        releasedTotal: 0,
        unfunded: 0,
        attemptsUsed: [topUp.attempt],
      });
      return {
        requestedActualUnits: actualUnits,
        capturedUnitsTotal: actualUnits,
        releasedUnitsTotal: 0,
        unfundedUnits: 0,
        runSettlementStatus: "fully_settled",
        attemptSettlements: [{ attempt: topUp.attempt, captured: actualUnits, released: 0, via: "expired_rekill" }],
        reused: false,
      };
    }
    // top-up 不足：捕获为 0 → requests = unfunded（D20），exception 归属已过期的 attempt（真实存在）
    await insertRunSettlementRequest(conn, {
      runId,
      accountId,
      requestedActualUnits: actualUnits,
      capturedTotal: 0,
      releasedTotal: 0,
      unfunded: actualUnits,
      attemptsUsed: [attempt],
    });
    await insertSettlementException(conn, { runId, attempt, accountId, type: "unfunded_usage", actual: actualUnits, captured: 0, unfunded: actualUnits });
    if (options.notify) {
      await options.notify({ type: "unfunded", runId, unfundedUnits: actualUnits });
    }
    return {
      requestedActualUnits: actualUnits,
      capturedUnitsTotal: 0,
      releasedUnitsTotal: 0,
      unfundedUnits: actualUnits,
      runSettlementStatus: "unfunded",
      attemptSettlements: [],
      reused: false,
    };
  });
}

/**
 * 失败释放（契约 §6.6）：调用方先独立短事务置 run failed，再调用本函数；
 * 全部 active 预留 → released（ledger + 钱包 reserved 减除 + 请求行镜像）；非 active 行幂等跳过；
 * 释放事务失败 → 残留 active 预留由 M1-T6 sweep 兜底。
 */
export async function release(runId: number, reason: string): Promise<ReleaseResult> {
  return runInBillingTransaction(async (conn) => {
    const accountId = await readRunAccountId(conn, runId);
    await lockAccountForUpdate(conn, accountId);
    const run = await lockRunForUpdate(conn, runId);
    const rows = await lockAttemptReservations(conn, runId, run.billing_reservation_attempt);
    const active = rows.filter((row) => row.status === "active");
    if (active.length === 0) return { released: false };
    for (const row of active) {
      const newReserved = row.wallet_reserved - row.units;
      await insertLedgerEntry(conn, {
        accountId,
        walletId: row.wallet_id,
        runId,
        idempotencyKey: `rel:${runId}:${run.billing_reservation_attempt}:${row.wallet_id}:${reason}`,
        reservationAttempt: run.billing_reservation_attempt,
        action: "released",
        quotaType: row.quota_type,
        units: row.units,
        reason,
        balanceAfterRemaining: row.wallet_remaining,
        balanceAfterReserved: newReserved,
      });
      await conn.execute(
        `UPDATE billing_quota_wallets
         SET reserved_sau = ?, balance_after_remaining = ?, balance_after_reserved = ?
         WHERE wallet_id = ?`,
        [newReserved, row.wallet_remaining, newReserved, row.wallet_id],
      );
      await conn.execute(`UPDATE billing_reservations SET status = 'released' WHERE reservation_id = ?`, [row.reservation_id]);
    }
    await mirrorRequestStatus(conn, runId, run.billing_reservation_attempt, "released");
    return { released: true };
  });
}

/**
 * 心跳（契约 §6.3）：锁序 run → reservations；续期 active 预留 + last_heartbeat_at 同事务；
 * 0 行影响 = 预留已被 sweep 结清 → 禁止复活（仅告警，终局由 capture 分支处理）。
 */
export async function heartbeat(runId: number): Promise<HeartbeatResult> {
  return runInBillingTransaction(async (conn) => {
    await lockRunForUpdate(conn, runId);
    await conn.execute(`UPDATE analysis_runs SET last_heartbeat_at = NOW(3) WHERE id = ?`, [runId]);
    const [result] = await conn.execute(
      `UPDATE billing_reservations SET expires_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE) WHERE run_id = ? AND status = 'active'`,
      [RESERVATION_TTL_MINUTES, runId],
    );
    const renewed = Number((result as { affectedRows?: number }).affectedRows ?? 0) > 0;
    if (!renewed) {
      // 无复活规则：heartbeat 不得重建已结清的预留
      console.warn("[billing] heartbeat found no active reservation; capture will settle via its state branches", { runId });
    }
    return { renewed };
  });
}

import type { PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { chandlerBaseUrl } from "./env";
import { decryptToken, encryptToken } from "./token-crypto";

/**
 * Chandler 用户 token 持久化与刷新（契约 M3-T1/P7）：
 * - 刷新通道 = POST /v1/auth/refresh（JSON body {refresh_token}，无需 client 凭证；旋转式——
 *   旧 refresh token 一次性作废，因此并发双刷新必须被用户级锁串行化）；
 * - GET_LOCK 用户级串行 → 短事务/语句重读 → 持锁期间做外部刷新（不在 DB 事务内等网络）→ 写回；
 * - 刷新失败（远端明确拒绝）→ 清行 → 结构化 not_bound 引导重新登录；超时/5xx 保留行可重试；
 * - key_version 支持密钥轮换（旧密钥保留可解密）。
 */

export class ChandlerTokenError extends Error {
  constructor(readonly code: "not_bound" | "config_missing" | "refresh_failed" | "refresh_rejected", message: string) {
    super(`[${code}] ${message}`);
    this.name = "ChandlerTokenError";
  }
}

export interface ChandlerTokenPayload {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
}

interface TokenRow {
  access_token: Buffer;
  refresh_token: Buffer | null;
  key_version: string;
  token_expires_at: string | Date | null;
}

const EXPIRY_MARGIN_MS = 60_000; // 临期 60 秒视为过期（AIRecord 同口径）
const REFRESH_LOCK_TIMEOUT_SECONDS = 5;

async function withTokenLock<T>(userId: number, work: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getDb().getConnection();
  try {
    const [rows] = await conn.execute(`SELECT GET_LOCK(?, ?) AS acquired`, [`chandler-token:${userId}`, REFRESH_LOCK_TIMEOUT_SECONDS]);
    const acquired = Number((rows as Array<{ acquired: number }>)[0]?.acquired ?? 0) === 1;
    if (!acquired) throw new ChandlerTokenError("refresh_failed", `token refresh lock busy for user ${userId}`);
    try {
      return await work(conn);
    } finally {
      await conn.execute(`SELECT RELEASE_LOCK(?)`, [`chandler-token:${userId}`]);
      conn.release();
    }
  } catch (error) {
    conn.release();
    throw error;
  }
}

/** OAuth 回调 / 刷新成功后写入（upsert）；GET_LOCK 已串行化同用户，无并发覆写窗口。 */
export async function storeChandlerTokens(userId: number, payload: ChandlerTokenPayload): Promise<void> {
  const access = encryptToken(payload.accessToken);
  const refresh = payload.refreshToken ? encryptToken(payload.refreshToken) : null;
  const expiresAt = payload.expiresIn ? new Date(Date.now() + payload.expiresIn * 1_000) : null;
  const conn = await getDb().getConnection();
  try {
    await conn.execute(
      `INSERT INTO chandler_tokens (user_id, access_token, refresh_token, key_version, token_expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token = VALUES(access_token),
         refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
         key_version = VALUES(key_version),
         token_expires_at = VALUES(token_expires_at)`,
      [userId, access.cipher, refresh?.cipher ?? null, access.keyVersion, expiresAt],
    );
  } finally {
    conn.release();
  }
}

export async function clearChandlerTokens(userId: number): Promise<void> {
  const conn = await getDb().getConnection();
  try {
    await conn.execute(`DELETE FROM chandler_tokens WHERE user_id = ?`, [userId]);
  } finally {
    conn.release();
  }
}

/**
 * 返回该用户可用的 Chandler access token：临期（60s 余量）先刷新。
 * 刷新失败（远端明确拒绝）→ 清行 + not_bound（409 引导重新登录）；超时/5xx 保留行可重试。
 */
export async function getValidUserToken(userId: number): Promise<string> {
  return withTokenLock(userId, async (conn) => {
    const [rows] = await conn.execute(
      `SELECT access_token, refresh_token, key_version, token_expires_at
       FROM chandler_tokens WHERE user_id = ?`,
      [userId],
    );
    const row = (rows as TokenRow[])[0];
    if (!row) throw new ChandlerTokenError("not_bound", `user ${userId} has no bound chandler account`);

    const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : null;
    const stillValid = expiresAt === null || expiresAt > Date.now() + EXPIRY_MARGIN_MS;
    if (stillValid) {
      return decryptToken(Buffer.from(row.access_token), row.key_version);
    }

    // 过期：持锁期间外部刷新（不在 DB 事务内等网络；GET_LOCK 串行化同用户并发刷新）
    if (!row.refresh_token) {
      await conn.execute(`DELETE FROM chandler_tokens WHERE user_id = ?`, [userId]);
      throw new ChandlerTokenError("not_bound", `user ${userId} token expired without refresh token`);
    }
    const refreshToken = decryptToken(Buffer.from(row.refresh_token), row.key_version);
    let payload: ChandlerTokenPayload;
    try {
      payload = await refreshChandlerTokens(refreshToken);
    } catch (error) {
      // 远端明确拒绝（4xx：旋转式旧 token 失效/无效）→ 清行引导重登录；超时/5xx 保留行可重试
      if (error instanceof ChandlerTokenError && error.code === "refresh_rejected") {
        await conn.execute(`DELETE FROM chandler_tokens WHERE user_id = ?`, [userId]);
      }
      throw error;
    }
    await storeChandlerTokens(userId, payload);
    return payload.accessToken;
  });
}

async function refreshChandlerTokens(refreshToken: string): Promise<ChandlerTokenPayload> {
  let response: Response;
  try {
    response = await fetch(`${chandlerBaseUrl()}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ChandlerTokenError("refresh_failed", `chandler refresh unreachable: ${String(error)}`);
  }
  if (!response.ok) {
    // 4xx = 远端明确拒绝（旋转式旧 token 失效/无效，可判定）；5xx = 平台抖动（保留行重试）
    const code = response.status;
    if (code >= 400 && code < 500) {
      throw new ChandlerTokenError("refresh_rejected", `chandler refresh rejected (${code})`);
    }
    throw new ChandlerTokenError("refresh_failed", `chandler refresh error (${code})`);
  }
  const payload = unwrapEnvelope(await response.json().catch(() => null));
  const accessToken = (payload as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new ChandlerTokenError("refresh_failed", "chandler refresh returned no access_token");
  }
  return {
    accessToken,
    refreshToken: typeof (payload as { refresh_token?: unknown }).refresh_token === "string" ? (payload as { refresh_token: string }).refresh_token : null,
    expiresIn: typeof (payload as { expires_in?: unknown }).expires_in === "number" ? (payload as { expires_in: number }).expires_in : null,
  };
}

function unwrapEnvelope(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) return (value as { data: unknown }).data;
  return value;
}

import { createHash, randomBytes } from "node:crypto";
import type { Execute } from "../db";

/**
 * A1 MCP OAuth PKCE 连接流（docs/specsight-gap-improvement-plan.md §4.1）+ 自动发现配套。
 * 授权码、访问 token 与 refresh token 只存 SHA-256 哈希；码 10 分钟一次性；
 * access 1 小时；refresh 30 天且每次刷新旋转并顺延；30 天未使用必须重连（last_used_at 判定）；
 * 回跳地址必须与注册客户端一致（RFC 6749）。
 */

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Execute 参数类型只收 string|number|null；DATETIME(3) 用该格式串。 */
function mysqlDatetime(date: Date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

/** 批准页主体：会话用户（chandler_sub）→ users.id。 */
export async function resolveUserIdBySub(execute: Execute, sub: string): Promise<number | null> {
  const [rows] = (await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [sub])) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number(rows[0].id) : null;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 30 天未使用需重连（计划 §4.1）。 */
const IDLE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** RFC 7591 动态客户端注册：开放注册（client_id 非机密），真正的闸门是授权页人工批准 + 回跳地址精确匹配。 */
export async function registerClient(connection: { execute: Execute }, input: {
  clientName: string;
  redirectUris: string[];
}): Promise<{ clientId: string }> {
  const clientId = `mcp_${randomBytes(12).toString("hex")}`;
  await connection.execute(
    "INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)",
    [clientId, input.clientName.slice(0, 191), JSON.stringify(input.redirectUris)],
  );
  return { clientId };
}

export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

/** client_id 查注册客户端并精确匹配回跳地址；不匹配一律返回 null。 */
export async function resolveClient(connection: { execute: Execute }, clientId: string, redirectUri: string): Promise<ResolvedClient | null> {
  const [rows] = (await connection.execute(
    "SELECT client_id AS clientId, client_name AS clientName, redirect_uris AS redirectUris FROM mcp_oauth_clients WHERE client_id = ? LIMIT 1",
    [clientId],
  )) as [Array<{ clientId: string; clientName: string; redirectUris: string }>, unknown];
  const client = rows[0];
  if (!client) return null;
  let redirectUris: string[];
  try {
    redirectUris = JSON.parse(client.redirectUris) as string[];
  } catch {
    return null;
  }
  if (!Array.isArray(redirectUris) || !redirectUris.includes(redirectUri)) return null;
  return { clientId: client.clientId, clientName: client.clientName, redirectUris };
}

export interface ApprovedGrant {
  id: number;
  /** 授权码明文，只在批准时返回一次。 */
  code: string;
}

/** 批准页提交：建授权记录（绑定注册 client），返回一次性授权码（哈希落库）。 */
export async function approveGrant(connection: { execute: Execute }, input: {
  organizationId: number;
  userId: number;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
}): Promise<ApprovedGrant> {
  const code = randomBytes(24).toString("hex");
  const insertResult = (await connection.execute(
    `INSERT INTO mcp_oauth_grants (organization_id, user_id, client_id, client_name, redirect_uri, code_hash, code_challenge, code_challenge_method, code_expires_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, NOW(3))`,
    [input.organizationId, input.userId, input.clientId, input.clientName.slice(0, 191), input.redirectUri, sha256(code), input.codeChallenge, mysqlDatetime(new Date(Date.now() + CODE_TTL_MS))],
  )) as unknown;
  const first = Array.isArray(insertResult) ? insertResult[0] : insertResult;
  return { id: Number((first as { insertId: number }).insertId), code };
}

interface GrantRow {
  id: number;
  organizationId: number;
  userId: number;
  codeHash: string | null;
  codeChallenge: string;
  codeExpiresAt: Date | null;
  redirectUri: string;
  clientId: string | null;
}

export interface IssuedTokens {
  grantId: number;
  organizationId: number;
  userId: number;
  accessToken: string;
  /** 秒（access token 寿命，1 小时）。 */
  expiresIn: number;
  refreshToken: string;
}

/** PKCE S256 校验：base64url(sha256(verifier)) 必须等于批准时的 challenge。 */
function challengeMatches(codeChallenge: string, verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url") === codeChallenge;
}

/** 授权码换 token：码一次性、10 分钟内、verifier 过 PKCE、回跳地址与 client 一致；发 access+refresh 双 token。 */
export async function exchangeCodeForToken(connection: { execute: Execute }, input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<IssuedTokens | null> {
  const [rows] = (await connection.execute(
    `SELECT id, organization_id AS organizationId, user_id AS userId, code_hash AS codeHash,
            code_challenge AS codeChallenge, code_expires_at AS codeExpiresAt, redirect_uri AS redirectUri, client_id AS clientId
     FROM mcp_oauth_grants WHERE code_hash = ?`,
    [sha256(input.code)],
  )) as [GrantRow[], unknown];
  const grant = rows[0];
  if (!grant || !grant.codeHash) return null;
  if (grant.redirectUri !== input.redirectUri) return null;
  if (!grant.clientId || grant.clientId !== input.clientId) return null;
  if (!grant.codeExpiresAt || grant.codeExpiresAt.getTime() < Date.now()) return null;
  if (!challengeMatches(grant.codeChallenge, input.codeVerifier)) return null;
  const accessToken = randomBytes(24).toString("hex");
  const refreshToken = randomBytes(24).toString("hex");
  // 码一次性：双 token 写入同行的同时清掉 code_hash，重复交换直接落空
  const updateResult = (await connection.execute(
    `UPDATE mcp_oauth_grants
     SET token_hash = ?, token_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_used_at = NOW(3), code_hash = NULL, code_expires_at = NULL
     WHERE id = ? AND code_hash = ?`,
    [
      sha256(accessToken),
      mysqlDatetime(new Date(Date.now() + TOKEN_TTL_MS)),
      sha256(refreshToken),
      mysqlDatetime(new Date(Date.now() + REFRESH_TTL_MS)),
      grant.id,
      grant.codeHash,
    ],
  )) as unknown;
  const updateFirst = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  const affected = Number((updateFirst as { affectedRows?: number }).affectedRows ?? 0);
  if (affected === 0) return null;
  return { grantId: grant.id, organizationId: grant.organizationId, userId: grant.userId, accessToken, expiresIn: TOKEN_TTL_MS / 1000, refreshToken };
}

/** refresh 换新 token（双 token 旋转并顺延 30 天）；client 必须一致；30 天未使用（idle）直接失效要求重连。 */
export async function refreshAccessToken(connection: { execute: Execute }, input: {
  refreshToken: string;
  clientId: string;
}): Promise<IssuedTokens | null> {
  const [rows] = (await connection.execute(
    `SELECT id, organization_id AS organizationId, user_id AS userId, client_id AS clientId,
            refresh_expires_at AS refreshExpiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
     FROM mcp_oauth_grants WHERE refresh_hash = ?`,
    [sha256(input.refreshToken)],
  )) as [Array<{ id: number; organizationId: number; userId: number; clientId: string | null; refreshExpiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null }>, unknown];
  const grant = rows[0];
  if (!grant) return null;
  if (grant.revokedAt) return null;
  if (!grant.clientId || grant.clientId !== input.clientId) return null;
  if (!grant.refreshExpiresAt || grant.refreshExpiresAt.getTime() < Date.now()) return null;
  const idleAnchor = grant.lastUsedAt ?? grant.refreshExpiresAt;
  if (Date.now() - idleAnchor.getTime() > IDLE_LIMIT_MS) return null;
  const accessToken = randomBytes(24).toString("hex");
  const refreshToken = randomBytes(24).toString("hex");
  // 旋转：旧 refresh 立即作废（WHERE 命中旧哈希），未命中（并发重放）落空
  const updateResult = (await connection.execute(
    `UPDATE mcp_oauth_grants
     SET token_hash = ?, token_expires_at = ?, refresh_hash = ?, refresh_expires_at = ?, last_used_at = NOW(3)
     WHERE id = ? AND refresh_hash = ?`,
    [
      sha256(accessToken),
      mysqlDatetime(new Date(Date.now() + TOKEN_TTL_MS)),
      sha256(refreshToken),
      mysqlDatetime(new Date(Date.now() + REFRESH_TTL_MS)),
      grant.id,
      sha256(input.refreshToken),
    ],
  )) as unknown;
  const updateFirst = Array.isArray(updateResult) ? updateResult[0] : updateResult;
  const affected = Number((updateFirst as { affectedRows?: number }).affectedRows ?? 0);
  if (affected === 0) return null;
  return { grantId: grant.id, organizationId: grant.organizationId, userId: grant.userId, accessToken, expiresIn: TOKEN_TTL_MS / 1000, refreshToken };
}

export interface McpTokenIdentity {
  grantId: number;
  organizationId: number;
  userId: number;
}

/** token 身份：哈希查找 + 未过期 + 未撤销 + 30 天内用过（否则要求重连）。命中即刷新 last_used_at。 */
export async function verifyAccessToken(connection: { execute: Execute }, plaintext: string): Promise<McpTokenIdentity | null> {
  const [rows] = (await connection.execute(
    `SELECT id, organization_id AS organizationId, user_id AS userId, token_expires_at AS tokenExpiresAt,
            last_used_at AS lastUsedAt, revoked_at AS revokedAt
     FROM mcp_oauth_grants WHERE token_hash = ?`,
    [sha256(plaintext)],
  )) as [Array<{ id: number; organizationId: number; userId: number; tokenExpiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null }>, unknown];
  const grant = rows[0];
  if (!grant) return null;
  if (grant.revokedAt) return null;
  if (!grant.tokenExpiresAt || grant.tokenExpiresAt.getTime() < Date.now()) return null;
  // 30 天未使用必须重连；批准后从未使用（lastUsedAt NULL）按批准时间容忍一个 TTL 周期
  const idleAnchor = grant.lastUsedAt ?? grant.tokenExpiresAt;
  if (Date.now() - idleAnchor.getTime() > IDLE_LIMIT_MS + TOKEN_TTL_MS) return null;
  await connection.execute("UPDATE mcp_oauth_grants SET last_used_at = NOW(3) WHERE id = ?", [grant.id]);
  return { grantId: grant.id, organizationId: grant.organizationId, userId: grant.userId };
}

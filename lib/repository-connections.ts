import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { getDb } from "./db";
import { requiredEnv } from "./env";
import { decryptSecret, encryptSecret } from "./secret-box";
import {
  normalizeRepositoryConnectionInput,
  RepositoryConnectionError,
  verifyRepositoryCredentials,
  type RepositoryProvider,
  type VerifiedRepositoryAccount,
} from "./repository-providers";

type Execute = (sql: string, parameters: Array<string | number | null>) => Promise<unknown>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface RepositoryConnectionState {
  id: number;
  provider: RepositoryProvider;
  displayName: string;
  accountLogin: string;
  baseUrl: string;
  tokenHint: string;
  status: "active" | "disconnected";
  lastError: string | null;
  lastCheckedAt: Date | string | null;
}

interface ConnectionRow extends RepositoryConnectionState {
  token_encrypted: string;
}

function connectionIdentity(provider: RepositoryProvider, baseUrl: string, accountLogin: string) {
  return createHash("sha256").update(`${provider}\n${baseUrl}\n${accountLogin.toLowerCase()}`).digest("hex");
}

function tokenHint(token: string) {
  return token.length > 4 ? `····${token.slice(-4)}` : "····";
}

function connectionErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 512) : "连接检查失败";
}

export async function createRepositoryConnection(
  organizationId: number,
  raw: unknown,
  execute: Execute = (sql, parameters) => getDb().execute(sql, parameters),
  fetcher: Fetcher = fetch,
) {
  const input = normalizeRepositoryConnectionInput(raw);
  const account = await verifyRepositoryCredentials(input, fetcher);
  await execute(
    `INSERT INTO repository_connections
      (organization_id, provider, identity_hash, display_name, account_login, base_url,
       token_encrypted, token_hint, status, last_error, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, CURRENT_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       display_name = VALUES(display_name), token_encrypted = VALUES(token_encrypted),
       token_hint = VALUES(token_hint), status = 'active', last_error = NULL,
       last_checked_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)`,
    [
      organizationId,
      input.provider,
      connectionIdentity(input.provider, input.baseUrl, account.accountLogin),
      account.displayName,
      account.accountLogin,
      input.baseUrl,
      encryptSecret(input.token, requiredEnv("SESSION_SECRET")),
      tokenHint(input.token),
    ],
  );
  return { status: "active" as const, provider: input.provider, accountLogin: account.accountLogin };
}

export async function listRepositoryConnections(
  organizationId: number,
  execute: Execute = (sql, parameters) => getDb().execute(sql, parameters),
): Promise<RepositoryConnectionState[]> {
  const [rows] = await execute(
    `SELECT id, provider, display_name AS displayName, account_login AS accountLogin,
            base_url AS baseUrl, token_hint AS tokenHint, status, last_error AS lastError,
            last_checked_at AS lastCheckedAt
     FROM repository_connections WHERE organization_id = ?
     ORDER BY provider, account_login, id`,
    [organizationId],
  ) as [RepositoryConnectionState[], unknown];
  return rows;
}

async function getScopedConnection(id: number, organizationId: number, execute: Execute) {
  const [rows] = await execute(
    `SELECT id, provider, display_name AS displayName, account_login AS accountLogin,
            base_url AS baseUrl, token_hint AS tokenHint, status, last_error AS lastError,
            last_checked_at AS lastCheckedAt, token_encrypted
     FROM repository_connections WHERE id = ? AND organization_id = ? LIMIT 1`,
    [id, organizationId],
  ) as [ConnectionRow[], unknown];
  return rows[0];
}

async function saveCheckSuccess(id: number, account: VerifiedRepositoryAccount, execute: Execute) {
  await execute(
    `UPDATE repository_connections SET display_name = ?, account_login = ?, status = 'active',
     last_error = NULL, last_checked_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [account.displayName, account.accountLogin, id],
  );
}

export async function checkRepositoryConnection(
  id: number,
  organizationId: number,
  execute: Execute = (sql, parameters) => getDb().execute(sql, parameters),
  fetcher: Fetcher = fetch,
) {
  const connection = await getScopedConnection(id, organizationId, execute);
  if (!connection) return { status: 404, body: { error: "连接不存在或不属于当前工作区" } };
  try {
    const input = {
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      token: decryptSecret(connection.token_encrypted, requiredEnv("SESSION_SECRET")),
    };
    const account = await verifyRepositoryCredentials(input, fetcher);
    await saveCheckSuccess(id, account, execute);
    return { status: 200, body: { status: "active", accountLogin: account.accountLogin } };
  } catch (error) {
    const message = connectionErrorMessage(error);
    await execute(
      `UPDATE repository_connections SET status = 'disconnected', last_error = ?,
       last_checked_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [message, id],
    );
    return { status: 503, body: { status: "disconnected", error: message } };
  }
}

export async function deleteRepositoryConnection(
  id: number,
  organizationId: number,
  execute: Execute = (sql, parameters) => getDb().execute(sql, parameters),
) {
  await execute(
    "DELETE FROM repository_connections WHERE id = ? AND organization_id = ?",
    [id, organizationId],
  );
  return { status: "deleted" as const };
}

export function repositoryConnectionError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, message: error.issues[0]?.message ?? "连接信息无效" };
  if (error instanceof RepositoryConnectionError) return { status: error.status, message: error.message };
  return { status: 500, message: "无法保存代码仓库连接，请稍后重试" };
}

import { defaultExecute, type Execute } from "./db";
import { requiredEnv } from "./env";
import { decryptSecret, encryptSecret } from "./secret-box";

interface AppCredentials {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  pem: string;
  webhookSecret?: string;
}

interface Installation {
  id: number;
  account: { login: string; type: string };
}


function integrationSecret() {
  return requiredEnv("SESSION_SECRET");
}

export async function saveGitHubApp(credentials: AppCredentials, execute: Execute = defaultExecute) {
  const secret = integrationSecret();
  await execute(
    `INSERT INTO github_apps
      (slug, app_id, client_id, client_secret_encrypted, pem_encrypted, webhook_secret_encrypted)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       app_id = VALUES(app_id), client_secret_encrypted = VALUES(client_secret_encrypted),
       pem_encrypted = VALUES(pem_encrypted), webhook_secret_encrypted = VALUES(webhook_secret_encrypted),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      credentials.slug,
      credentials.appId,
      credentials.clientId,
      encryptSecret(credentials.clientSecret, secret),
      encryptSecret(credentials.pem, secret),
      credentials.webhookSecret ? encryptSecret(credentials.webhookSecret, secret) : null,
    ],
  );
}

function readApp(row: { id: number; slug: string; app_id: number; client_id: string; client_secret_encrypted: string; pem_encrypted: string; webhook_secret_encrypted: string | null }) {
  const secret = integrationSecret();
  return {
    id: row.id,
    appId: row.app_id,
    slug: row.slug,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret_encrypted, secret),
    pem: decryptSecret(row.pem_encrypted, secret),
    webhookSecret: row.webhook_secret_encrypted ? decryptSecret(row.webhook_secret_encrypted, secret) : undefined,
  };
}

export async function getGitHubAppBySlug(slug: string, execute: Execute = defaultExecute) {
  const [rows] = await execute(
    "SELECT id, slug, app_id, client_id, client_secret_encrypted, pem_encrypted, webhook_secret_encrypted FROM github_apps WHERE slug = ? LIMIT 1",
    [slug],
  ) as [Array<{ id: number; slug: string; app_id: number; client_id: string; client_secret_encrypted: string; pem_encrypted: string; webhook_secret_encrypted: string | null }>, unknown];
  const row = rows[0];
  return row ? readApp(row) : null;
}

export async function getLatestGitHubApp(execute: Execute = defaultExecute) {
  const [rows] = await execute(
    "SELECT id, slug, app_id, client_id, client_secret_encrypted, pem_encrypted, webhook_secret_encrypted FROM github_apps ORDER BY id DESC LIMIT 1",
    [],
  ) as [Array<{ id: number; slug: string; app_id: number; client_id: string; client_secret_encrypted: string; pem_encrypted: string; webhook_secret_encrypted: string | null }>, unknown];
  const row = rows[0];
  return row ? readApp(row) : null;
}

export async function saveInstallation(appId: number, installation: Installation, organizationOrExecute: number | Execute = 1, maybeExecute?: Execute) {
  const organizationId = typeof organizationOrExecute === "number" ? organizationOrExecute : 1;
  const execute = typeof organizationOrExecute === "function" ? organizationOrExecute : maybeExecute ?? defaultExecute;
  await execute(
    `INSERT INTO github_connections (app_id, installation_id, account_login, account_type, status, organization_id)
     VALUES (?, ?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE
       account_login = IF(organization_id = VALUES(organization_id), VALUES(account_login), account_login),
       account_type = IF(organization_id = VALUES(organization_id), VALUES(account_type), account_type),
       status = IF(organization_id = VALUES(organization_id), 'active', status),
       updated_at = IF(organization_id = VALUES(organization_id), CURRENT_TIMESTAMP(3), updated_at)`,
    [appId, installation.id, installation.account.login, installation.account.type, organizationId],
  );
  const [savedRows] = await execute(
    "SELECT organization_id FROM github_connections WHERE installation_id = ? LIMIT 1",
    [installation.id],
  ) as [Array<{ organization_id: number }>, unknown];
  const saved = savedRows[0];
  if (!saved || Number(saved.organization_id) !== organizationId) throw new Error("GitHub installation belongs to another workspace");
}

export async function listConnectionStates(organizationIdOrExecute?: number | Execute, maybeExecute?: Execute) {
  const organizationId = typeof organizationIdOrExecute === "number" ? organizationIdOrExecute : undefined;
  const execute = typeof organizationIdOrExecute === "function" ? organizationIdOrExecute : maybeExecute ?? defaultExecute;
  const [rows] = await execute(
    `SELECT c.id, c.account_login AS accountLogin, c.account_type AS accountType,
            c.status, a.slug AS appSlug, c.installation_id AS installationId
     FROM github_connections c JOIN github_apps a ON a.id = c.app_id
     WHERE c.organization_id = ? OR ? IS NULL
     ORDER BY c.account_login`,
    [organizationId ?? null, organizationId ?? null],
  ) as [Array<{ id: number; accountLogin: string; accountType: string; status: string; appSlug: string; installationId: number }>, unknown];
  return rows;
}

export async function getConnectionWithApp(id: number, organizationOrExecute?: number | Execute, maybeExecute?: Execute) {
  const organizationId = typeof organizationOrExecute === "number" ? organizationOrExecute : undefined;
  const execute = typeof organizationOrExecute === "function" ? organizationOrExecute : maybeExecute ?? defaultExecute;
  const [rows] = await execute(
    `SELECT a.id, a.slug, a.app_id, a.client_id, a.client_secret_encrypted, a.pem_encrypted,
            a.webhook_secret_encrypted, c.id AS connection_id, c.installation_id, c.account_login, c.account_type, c.status, c.organization_id
     FROM github_connections c JOIN github_apps a ON a.id = c.app_id
     WHERE c.id = ? AND (? IS NULL OR c.organization_id = ?) LIMIT 1`,
    [id, organizationId ?? null, organizationId ?? null],
  ) as [Array<{ id: number; slug: string; app_id: number; client_id: string; client_secret_encrypted: string; pem_encrypted: string; webhook_secret_encrypted: string | null; connection_id: number; installation_id: number; account_login: string; account_type: string; status: string; organization_id: number }>, unknown];
  const row = rows[0];
  if (!row) return null;
  return { ...readApp(row), connectionId: row.connection_id, installationId: row.installation_id, accountLogin: row.account_login, accountType: row.account_type, status: row.status, organizationId: row.organization_id };
}

export async function setConnectionStatus(id: number, status: "active" | "disconnected", organizationOrExecute?: number | Execute, maybeExecute?: Execute) {
  const organizationId = typeof organizationOrExecute === "number" ? organizationOrExecute : undefined;
  const execute = typeof organizationOrExecute === "function" ? organizationOrExecute : maybeExecute ?? defaultExecute;
  await execute(
    "UPDATE github_connections SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND (? IS NULL OR organization_id = ?)",
    [status, id, organizationId ?? null, organizationId ?? null],
  );
}

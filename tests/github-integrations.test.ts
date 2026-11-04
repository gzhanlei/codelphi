import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubAppBySlug, getConnectionWithApp, listConnectionStates, saveGitHubApp, saveInstallation, setConnectionStatus } from "../lib/github-integrations";
import { encryptSecret } from "../lib/secret-box";

describe("GitHub integration persistence", () => {
  beforeEach(() => vi.stubEnv("SESSION_SECRET", "test-session-secret"));

  it("encrypts app credentials and decrypts them only when read", async () => {
    const queries: Array<{ sql: string; parameters: unknown[] }> = [];
    let encryptedPem = "";
    const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
      queries.push({ sql, parameters });
      if (sql.includes("INSERT INTO github_apps")) {
        encryptedPem = String(parameters[4]);
        return [{}];
      }
      if (sql.includes("SELECT id, slug, app_id, client_id, client_secret_encrypted, pem_encrypted, webhook_secret_encrypted FROM github_apps WHERE slug = ?") ) {
        return [[{ id: 1, slug: "radar-test", app_id: 123, client_id: "Iv1.test", client_secret_encrypted: parameters[0] === "radar-test" ? queries[0].parameters[3] : "", pem_encrypted: encryptedPem, webhook_secret_encrypted: queries[0].parameters[5] }]];
      }
      return [[]];
    });

    await saveGitHubApp({ appId: 123, slug: "radar-test", clientId: "Iv1.test", clientSecret: "secret", pem: "private-pem", webhookSecret: "hook" }, execute);
    expect(encryptedPem).not.toBe("private-pem");
    expect(encryptedPem).not.toContain("private-pem");
    const app = await getGitHubAppBySlug("radar-test", execute);
    expect(app).toMatchObject({ id: 1, appId: 123, clientId: "Iv1.test", clientSecret: "secret", pem: "private-pem", webhookSecret: "hook" });
  });

  it("upserts installations and returns connection states", async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO github_connections")) return [{}];
      if (sql.includes("SELECT organization_id FROM github_connections")) return [[{ organization_id: 1 }]];
      if (sql.includes("FROM github_connections c JOIN github_apps a")) {
        return [[{ id: 9, accountLogin: "gzhanlei", accountType: "User", status: "active", appSlug: "radar-test", installationId: 42 }]];
      }
      return [[]];
    });
    await saveInstallation(1, { id: 42, account: { login: "gzhanlei", type: "User" } }, execute);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"), expect.arrayContaining([42, 1]));
    expect(execute.mock.calls[0][0]).toContain("status = IF(organization_id = VALUES(organization_id), 'active', status)");
    expect(await listConnectionStates(execute)).toEqual([{ id: 9, accountLogin: "gzhanlei", accountType: "User", status: "active", appSlug: "radar-test", installationId: 42 }]);
  });

  it("does not transfer an installation to another workspace", async () => {
    const execute = vi.fn(async (sql: string) => sql.includes("SELECT organization_id FROM github_connections") ? [[{ organization_id: 1 }]] : [{}]);
    await expect(saveInstallation(1, { id: 42, account: { login: "gzhanlei", type: "User" } }, 2, execute)).rejects.toThrow("another workspace");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain("INSERT INTO github_connections");
    expect(execute.mock.calls[0][0]).toContain("account_login = IF(organization_id = VALUES(organization_id)");
  });

  it("loads scoped connections and returns null for another workspace", async () => {
    const credentials = {
      client_secret_encrypted: encryptSecret("secret", "test-session-secret"),
      pem_encrypted: encryptSecret("pem", "test-session-secret"),
      webhook_secret_encrypted: null,
    };
    const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
      if (parameters[0] === 99) return [[]];
      return [[{ id: 1, slug: "radar", app_id: 1, client_id: "client", ...credentials, connection_id: 9, installation_id: 42, account_login: "radar", account_type: "User", status: "active", organization_id: 7 }]];
    });
    const connection = await getConnectionWithApp(9, 7, execute);
    expect(connection).toMatchObject({ connectionId: 9, organizationId: 7, clientSecret: "secret", pem: "pem" });
    expect(execute.mock.calls[0][1]).toEqual([9, 7, 7]);
    expect(await getConnectionWithApp(99, execute)).toBeNull();
    expect(execute.mock.calls[1][1]).toEqual([99, null, null]);
  });

  it("scopes connection status changes to the requested workspace", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: Array<string | number | null>) => [{}]);
    await setConnectionStatus(9, "disconnected", 7, execute);
    expect(execute.mock.calls[0][1]).toEqual(["disconnected", 9, 7, 7]);
  });
});

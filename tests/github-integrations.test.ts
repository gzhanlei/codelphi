import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitHubAppBySlug, listConnectionStates, saveGitHubApp, saveInstallation } from "../lib/github-integrations";

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
      if (sql.includes("FROM github_connections c JOIN github_apps a")) {
        return [[{ id: 9, accountLogin: "gzhanlei", accountType: "User", status: "active", appSlug: "radar-test", installationId: 42 }]];
      }
      return [[]];
    });
    await saveInstallation(1, { id: 42, account: { login: "gzhanlei", type: "User" } }, execute);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("ON DUPLICATE KEY UPDATE"), expect.arrayContaining([42, "active"]));
    expect(await listConnectionStates(execute)).toEqual([{ id: 9, accountLogin: "gzhanlei", accountType: "User", status: "active", appSlug: "radar-test", installationId: 42 }]);
  });
});

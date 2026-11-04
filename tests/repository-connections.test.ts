import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRepositoryConnection,
  createRepositoryConnection,
  deleteRepositoryConnection,
  listRepositoryConnections,
  repositoryConnectionError,
} from "../lib/repository-connections";
import { encryptSecret } from "../lib/secret-box";

const secret = "connection-test-secret";
type Parameters = Array<string | number | null>;

describe("repository connection persistence", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("REPOSITORY_HOST_ALLOWLIST", "git.example.com");
  });

  it("verifies before saving and encrypts the token", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: Parameters) => [{}]);
    const fetcher = vi.fn(async () => Response.json({ login: "radar-user", name: "Radar" }));
    const result = await createRepositoryConnection(4, { provider: "gitee", token: "gitee-secret" }, execute, fetcher);
    expect(result).toEqual({ status: "active", provider: "gitee", accountLogin: "radar-user" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [sql, parameters] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO repository_connections");
    expect(parameters[0]).toBe(4);
    expect(parameters[6]).not.toBe("gitee-secret");
    expect(String(parameters[6])).not.toContain("gitee-secret");
    expect(parameters[7]).toBe("····cret");
    expect(result).not.toHaveProperty("token");
  });

  it("does not save credentials rejected by the provider", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: Parameters) => [{}]);
    await expect(createRepositoryConnection(4, { provider: "gitee", token: "invalid" }, execute, async () => new Response("denied", { status: 401 }))).rejects.toThrow("令牌无效");
    expect(execute).not.toHaveBeenCalled();
  });

  it("lists only presentation fields for the current workspace", async () => {
    const row = { id: 9, provider: "gitee", displayName: "Radar", accountLogin: "radar-user", baseUrl: "https://gitee.com", tokenHint: "····cret", status: "active", lastError: null, lastCheckedAt: null };
    const execute = vi.fn(async (_sql: string, _parameters: Parameters) => [[row]]);
    expect(await listRepositoryConnections(4, execute)).toEqual([row]);
    expect(execute.mock.calls[0][0]).not.toContain("token_encrypted");
    expect(execute.mock.calls[0][1]).toEqual([4]);
  });

  it("checks a saved token within its workspace and refreshes the account", async () => {
    const encrypted = encryptSecret("gitlab-secret", secret);
    const execute = vi.fn(async (sql: string, _parameters: Parameters) => {
      if (sql.includes("FROM repository_connections WHERE id = ? AND organization_id = ?")) {
        return [[{ id: 9, provider: "gitlab", displayName: "Old", accountLogin: "old", baseUrl: "https://git.example.com", tokenHint: "····cret", status: "disconnected", lastError: "denied", lastCheckedAt: null, token_encrypted: encrypted }]];
      }
      return [{}];
    });
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ username: "new-user", name: "New User" }));
    const result = await checkRepositoryConnection(9, 4, execute, fetcher);
    expect(result.status).toBe(200);
    expect(execute.mock.calls[0][1]).toEqual([9, 4]);
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ "PRIVATE-TOKEN": "gitlab-secret" });
    expect(execute.mock.calls[1][0]).toContain("status = 'active'");
    expect(execute.mock.calls[1][1]).toEqual(["New User", "new-user", 9]);
  });

  it("marks failed checks disconnected without exposing the token", async () => {
    const encrypted = encryptSecret("do-not-leak", secret);
    const execute = vi.fn(async (sql: string, _parameters: Parameters) => {
      if (sql.includes("FROM repository_connections")) return [[{ id: 9, provider: "gitee", displayName: "Radar", accountLogin: "radar", baseUrl: "https://gitee.com", tokenHint: "····", status: "active", lastError: null, lastCheckedAt: null, token_encrypted: encrypted }]];
      return [{}];
    });
    const result = await checkRepositoryConnection(9, 4, execute, async () => new Response("denied", { status: 403 }));
    expect(result.status).toBe(503);
    expect(result.body.error).not.toContain("do-not-leak");
    expect(execute.mock.calls[1][1]).toEqual([expect.stringContaining("权限不足"), 9]);
  });

  it("returns 404 for another workspace's connection", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: Parameters) => [[]]);
    const result = await checkRepositoryConnection(9, 4, execute);
    expect(result.status).toBe(404);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("deletes the saved credential within its workspace", async () => {
    const execute = vi.fn(async (_sql: string, _parameters: Parameters) => [{}]);
    expect(await deleteRepositoryConnection(9, 4, execute)).toEqual({ status: "deleted" });
    expect(execute.mock.calls[0][0]).toContain("DELETE FROM repository_connections WHERE id = ? AND organization_id = ?");
    expect(execute.mock.calls[0][1]).toEqual([9, 4]);
  });

  it("maps validation, verification, and storage errors", async () => {
    expect(repositoryConnectionError(await createRepositoryConnection(4, { provider: "gitee", token: "" }).catch((error: unknown) => error))).toMatchObject({ status: 400 });
    expect(repositoryConnectionError(new Error("database details"))).toEqual({ status: 500, message: "无法保存代码仓库连接，请稍后重试" });
  });

  it("marks corrupted encrypted credentials disconnected instead of throwing", async () => {
    const execute = vi.fn(async (sql: string, _parameters: Parameters) => {
      if (sql.includes("FROM repository_connections")) return [[{ id: 9, provider: "gitee", displayName: "Radar", accountLogin: "radar", baseUrl: "https://gitee.com", tokenHint: "····", status: "active", lastError: null, lastCheckedAt: null, token_encrypted: "corrupted" }]];
      return [{}];
    });
    const fetcher = vi.fn(async () => Response.json({ login: "radar" }));
    const result = await checkRepositoryConnection(9, 4, execute, fetcher);
    expect(result.status).toBe(503);
    expect(result.body.status).toBe("disconnected");
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute.mock.calls[1][0]).toContain("status = 'disconnected'");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeRepositoryConnectionInput,
  RepositoryConnectionError,
  repositoryProviderLabel,
  verifyRepositoryCredentials,
} from "../lib/repository-providers";

beforeEach(() => vi.stubEnv("REPOSITORY_HOST_ALLOWLIST", "git.example.com:443,gitlab.example.com,gitea.example.com"));
afterEach(() => vi.unstubAllEnvs());

describe("repository provider inputs", () => {
  it("normalizes hosted and self-managed service addresses", () => {
    expect(normalizeRepositoryConnectionInput({ provider: "gitee", token: " secret " })).toEqual({ provider: "gitee", baseUrl: "https://gitee.com", token: "secret" });
    expect(normalizeRepositoryConnectionInput({ provider: "gitlab", baseUrl: "https://git.example.com/", token: "secret" }).baseUrl).toBe("https://git.example.com");
    expect(normalizeRepositoryConnectionInput({ provider: "gitea", baseUrl: "https://git.example.com/team/", token: "secret" }).baseUrl).toBe("https://git.example.com/team");
    expect(repositoryProviderLabel("gitea")).toBe("Gitea");
    expect(normalizeRepositoryConnectionInput({ provider: "gitlab", baseUrl: "https://gitlab.com", token: "secret" }).baseUrl).toBe("https://gitlab.com");
  });

  it("requires an exact host and port allowlist match", () => {
    expect(() => normalizeRepositoryConnectionInput({ provider: "gitlab", baseUrl: "https://unapproved.example.com", token: "secret" })).toThrow("REPOSITORY_HOST_ALLOWLIST");
    expect(() => normalizeRepositoryConnectionInput({ provider: "gitlab", baseUrl: "https://git.example.com:8443", token: "secret" })).toThrow("REPOSITORY_HOST_ALLOWLIST");
  });
  it.each([
    [{ provider: "gitlab", token: "secret" }, "请输入自有 Git 服务"],
    [{ provider: "gitlab", baseUrl: "not-a-url", token: "secret" }, "服务地址无效"],
    [{ provider: "gitlab", baseUrl: "http://git.example.com", token: "secret" }, "必须使用 HTTPS"],
    [{ provider: "gitea", baseUrl: "https://user:pass@git.example.com", token: "secret" }, "不能包含账号"],
  ])("rejects unsafe or incomplete input %#", (input, message) => {
    expect(() => normalizeRepositoryConnectionInput(input)).toThrow(message);
  });
});

describe("repository credential verification", () => {
  it("verifies a Gitee token without returning it", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ login: "radar-user", name: "Radar 用户" }));
    const account = await verifyRepositoryCredentials({ provider: "gitee", token: "gitee-secret" }, fetcher);
    expect(account).toEqual({ accountLogin: "radar-user", displayName: "Radar 用户" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://gitee.com/api/v5/user?access_token=gitee-secret");
    expect(init?.redirect).toBe("error");
    expect(account).not.toHaveProperty("token");
  });

  it("uses the provider-specific API and authentication header", async () => {
    const gitlabFetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ username: "gitlab-user", name: "" }));
    await expect(verifyRepositoryCredentials({ provider: "gitlab", baseUrl: "https://gitlab.example.com", token: "gitlab-secret" }, gitlabFetch)).resolves.toEqual({ accountLogin: "gitlab-user", displayName: "gitlab-user" });
    expect(gitlabFetch.mock.calls[0][0]).toBe("https://gitlab.example.com/api/v4/user");
    expect(gitlabFetch.mock.calls[0][1]?.headers).toMatchObject({ "PRIVATE-TOKEN": "gitlab-secret" });

    const giteaFetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ login: "gitea-user" }));
    await verifyRepositoryCredentials({ provider: "gitea", baseUrl: "https://gitea.example.com", token: "gitea-secret" }, giteaFetch);
    expect(giteaFetch.mock.calls[0][0]).toBe("https://gitea.example.com/api/v1/user");
    expect(giteaFetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "token gitea-secret" });
  });

  it.each([[401], [403]])("explains rejected token status %i", async (status) => {
    const error = await verifyRepositoryCredentials({ provider: "gitee", token: "do-not-leak" }, async () => new Response("denied", { status })).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RepositoryConnectionError);
    expect((error as RepositoryConnectionError).status).toBe(400);
    expect((error as Error).message).toContain("权限不足");
    expect((error as Error).message).not.toContain("do-not-leak");
  });

  it("classifies incompatible addresses and temporary failures", async () => {
    await expect(verifyRepositoryCredentials({ provider: "gitlab", baseUrl: "https://git.example.com", token: "secret" }, async () => new Response("not found", { status: 404 }))).rejects.toThrow("检查服务地址和平台类型");
    await expect(verifyRepositoryCredentials({ provider: "gitlab", baseUrl: "https://git.example.com", token: "secret" }, async () => new Response("down", { status: 503 }))).rejects.toMatchObject({ status: 502 });
    await expect(verifyRepositoryCredentials({ provider: "gitee", token: "secret" }, async () => { throw new Error("socket secret"); })).rejects.toThrow("无法连接代码平台");
  });

  it("rejects malformed account responses", async () => {
    await expect(verifyRepositoryCredentials({ provider: "gitee", token: "secret" }, async () => Response.json({ unexpected: true }))).rejects.toThrow("账号信息");
    await expect(verifyRepositoryCredentials({ provider: "gitee", token: "secret" }, async () => new Response("not-json", { headers: { "Content-Type": "application/json" } }))).rejects.toThrow("无法解析");
  });
});

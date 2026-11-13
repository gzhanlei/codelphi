import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveGrant, exchangeCodeForToken, refreshAccessToken, verifyAccessToken, registerClient, resolveClient, sha256 } from "../lib/mcp/oauth";

const execute = vi.fn();
const connection = { execute } as never;

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([[]]);
});

const verifier = "correct-horse-battery-staple-1234567890";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const clientId = "mcp_00112233445566778899aabb";
const redirectUri = "https://claude.ai/callback";

describe("mcp oauth pkce (A1)", () => {
  it("hashes with sha-256 (hex) — nothing sensitive is stored in the clear", () => {
    expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approves a grant: persists only hashes, binds the registered client, returns the plaintext code once", async () => {
    execute.mockResolvedValue([{ insertId: 3 }]);
    const grant = await approveGrant(connection, {
      organizationId: 5, userId: 11, clientId, clientName: "Claude Web", redirectUri, codeChallenge: challenge,
    });
    expect(grant.code).toMatch(/^[0-9a-f]{40,}$/);
    const params = execute.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(grant.code);
    expect(params).toContain(sha256(grant.code));
    expect(params).toContain(clientId);
  });

  it("exchanges a valid code + verifier for a token once; mismatched verifier/redirect/client is rejected", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT")) {
        return [[{
          id: 3, organizationId: 5, userId: 11, codeHash: sha256("issued-code"), clientId,
          codeChallenge: challenge, codeChallengeMethod: "S256",
          codeExpiresAt: new Date(Date.now() + 60_000), redirectUri,
        }]];
      }
      return [{ affectedRows: 1 }];
    });
    const token = await exchangeCodeForToken(connection, {
      code: "issued-code", codeVerifier: verifier, redirectUri, clientId,
    });
    expect(token?.accessToken).toMatch(/^[0-9a-f]{40,}$/);
    expect(token?.refreshToken).toMatch(/^[0-9a-f]{40,}$/);
    expect(token?.organizationId).toBe(5);
    // 错误 verifier → 拒绝（PKCE 的意义所在）
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: "wrong-verifier-wrong-verifier-123456", redirectUri, clientId })).toBeNull();
    // 回跳地址不匹配 → 拒绝
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri: "https://evil.example/callback", clientId })).toBeNull();
    // client 不匹配 → 拒绝
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri, clientId: "mcp_other" })).toBeNull();
    // 已交换过的码（code_hash 已清）→ 拒绝（一次性）
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT")) {
        return [[{ id: 3, organizationId: 5, userId: 11, codeHash: null, clientId, codeChallenge: challenge, codeExpiresAt: new Date(Date.now() + 60_000), redirectUri }]];
      }
      return [{ affectedRows: 1 }];
    });
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri, clientId })).toBeNull();
    // 过期授权码 → 拒绝
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT")) {
        return [[{ id: 3, organizationId: 5, userId: 11, codeHash: sha256("issued-code"), clientId, codeChallenge: challenge, codeExpiresAt: new Date(Date.now() - 60_000), redirectUri }]];
      }
      return [{ affectedRows: 1 }];
    });
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri, clientId })).toBeNull();
  });

  it("verifies an access token to its org/user; rejects unknown, expired, revoked and 30-day-idle tokens", async () => {
    const ok = async (row: Record<string, unknown>) => {
      execute.mockImplementation(async (sql: string) => (String(sql).includes("SELECT")
        ? [[row]]
        : [{ affectedRows: 1 }]));
    };
    await ok({ id: 3, organizationId: 5, userId: 11, tokenExpiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date(), revokedAt: null });
    expect(await verifyAccessToken(connection, "some-token")).toEqual({ grantId: 3, organizationId: 5, userId: 11 });
    // 未知 token
    await ok({}); // 空行
    expect(await verifyAccessToken(connection, "unknown")).toBeNull();
    // 过期
    await ok({ id: 3, organizationId: 5, userId: 11, tokenExpiresAt: new Date(Date.now() - 60_000), lastUsedAt: new Date(), revokedAt: null });
    expect(await verifyAccessToken(connection, "some-token")).toBeNull();
    // 已撤销
    await ok({ id: 3, organizationId: 5, userId: 11, tokenExpiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date(), revokedAt: new Date() });
    expect(await verifyAccessToken(connection, "some-token")).toBeNull();
    // 30 天未使用 → 必须重连
    await ok({ id: 3, organizationId: 5, userId: 11, tokenExpiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000), revokedAt: null });
    expect(await verifyAccessToken(connection, "some-token")).toBeNull();
  });
});

describe("mcp oauth dynamic client registration (RFC 7591)", () => {
  it("registers a client and persists the redirect uri list", async () => {
    const { clientId: issued } = await registerClient(connection, { clientName: "ChatGPT Connector", redirectUris: ["https://chatgpt.com/connector_redirect"] });
    expect(issued).toMatch(/^mcp_[0-9a-f]{24}$/);
    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("mcp_oauth_clients");
    expect(params).toContain(JSON.stringify(["https://chatgpt.com/connector_redirect"]));
  });

  it("resolves a client only when the redirect uri matches the registration exactly", async () => {
    execute.mockResolvedValue([[{ clientId, clientName: "ChatGPT Connector", redirectUris: JSON.stringify([redirectUri]) }]]);
    const client = await resolveClient(connection, clientId, redirectUri);
    expect(client?.clientName).toBe("ChatGPT Connector");
    // 未注册的回跳地址 → 拒绝
    expect(await resolveClient(connection, clientId, "https://evil.example/callback")).toBeNull();
    // 未知的 client_id → 拒绝
    execute.mockResolvedValue([[]]);
    expect(await resolveClient(connection, "mcp_unknown", redirectUri)).toBeNull();
    // redirect_uris 列损坏 → 拒绝
    execute.mockResolvedValue([[{ clientId, clientName: "x", redirectUris: "not-json" }]]);
    expect(await resolveClient(connection, clientId, redirectUri)).toBeNull();
  });
});

describe("mcp oauth refresh token rotation", () => {
  const okRow = (overrides: Record<string, unknown> = {}) => ({
    id: 3, organizationId: 5, userId: 11, clientId,
    refreshExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    lastUsedAt: new Date(Date.now() - 60_000),
    revokedAt: null,
    ...overrides,
  });
  const mockGrant = async (row: Record<string, unknown>, affectedRows = 1) => {
    execute.mockImplementation(async (sql: string) => (String(sql).includes("SELECT") ? [[row]] : [{ affectedRows }]));
  };

  it("rotates both tokens and extends the refresh window on success", async () => {
    await mockGrant(okRow());
    const token = await refreshAccessToken(connection, { refreshToken: "current-refresh", clientId });
    expect(token?.accessToken).toMatch(/^[0-9a-f]{40,}$/);
    expect(token?.refreshToken).toMatch(/^[0-9a-f]{40,}$/);
    // 旋转：UPDATE 以旧 refresh 哈希为条件，且新 refresh 哈希不等于旧的
    const updateCall = execute.mock.calls.find(([sql]) => String(sql).includes("UPDATE")) as unknown as [string, unknown[]];
    expect(updateCall[1]).toContain(sha256("current-refresh"));
    expect(updateCall[1]).toContain(sha256(token!.refreshToken));
    expect(token!.refreshToken).not.toBe("current-refresh");
  });

  it("rejects replayed (already rotated), expired, revoked, idle and client-mismatched refresh tokens", async () => {
    // 并发重放：WHERE 命中 0 行 → 拒绝
    await mockGrant(okRow(), 0);
    expect(await refreshAccessToken(connection, { refreshToken: "replayed", clientId })).toBeNull();
    // 过期
    await mockGrant(okRow({ refreshExpiresAt: new Date(Date.now() - 60_000) }));
    expect(await refreshAccessToken(connection, { refreshToken: "expired", clientId })).toBeNull();
    // 已撤销
    await mockGrant(okRow({ revokedAt: new Date() }));
    expect(await refreshAccessToken(connection, { refreshToken: "revoked", clientId })).toBeNull();
    // 30 天未使用 → 必须重连
    await mockGrant(okRow({ lastUsedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) }));
    expect(await refreshAccessToken(connection, { refreshToken: "idle", clientId })).toBeNull();
    // client 不匹配
    await mockGrant(okRow({ clientId: "mcp_other" }));
    expect(await refreshAccessToken(connection, { refreshToken: "other-client", clientId })).toBeNull();
    // 未知 refresh
    await mockGrant({});
    expect(await refreshAccessToken(connection, { refreshToken: "unknown", clientId })).toBeNull();
  });
});

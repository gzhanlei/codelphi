import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveGrant, exchangeCodeForToken, verifyAccessToken, sha256 } from "../lib/mcp/oauth";

const execute = vi.fn();
const connection = { execute } as never;

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([[]]);
});

const verifier = "correct-horse-battery-staple-1234567890";
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe("mcp oauth pkce (A1)", () => {
  it("hashes with sha-256 (hex) — nothing sensitive is stored in the clear", () => {
    expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approves a grant: persists only hashes, returns the plaintext code once", async () => {
    execute.mockResolvedValue([{ insertId: 3 }]);
    const grant = await approveGrant(connection, {
      organizationId: 5, userId: 11, clientName: "Claude Web", redirectUri: "https://claude.ai/callback", codeChallenge: challenge,
    });
    expect(grant.code).toMatch(/^[0-9a-f]{40,}$/);
    const params = execute.mock.calls[0][1] as unknown[];
    expect(params).not.toContain(grant.code);
    expect(params).toContain(sha256(grant.code));
  });

  it("exchanges a valid code + verifier for a token once; wrong verifier is rejected", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT")) {
        return [[{
          id: 3, organizationId: 5, userId: 11, codeHash: sha256("issued-code"),
          codeChallenge: challenge, codeChallengeMethod: "S256",
          codeExpiresAt: new Date(Date.now() + 60_000), redirectUri: "https://claude.ai/callback", usedAt: null,
        }]];
      }
      return [{ affectedRows: 1 }];
    });
    const token = await exchangeCodeForToken(connection, {
      code: "issued-code", codeVerifier: verifier, redirectUri: "https://claude.ai/callback",
    });
    expect(token?.plaintext).toMatch(/^[0-9a-f]{40,}$/);
    expect(token?.organizationId).toBe(5);
    // 错误 verifier → 拒绝（PKCE 的意义所在）
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: "wrong-verifier-wrong-verifier-123456", redirectUri: "https://claude.ai/callback" })).toBeNull();
    // 回跳地址不匹配 → 拒绝
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri: "https://evil.example/callback" })).toBeNull();
    // 过期授权码 → 拒绝
    execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT")) {
        return [[{ id: 3, codeHash: sha256("issued-code"), codeChallenge: challenge, codeExpiresAt: new Date(Date.now() - 60_000), redirectUri: "https://claude.ai/callback", usedAt: null }]];
      }
      return [{ affectedRows: 1 }];
    });
    expect(await exchangeCodeForToken(connection, { code: "issued-code", codeVerifier: verifier, redirectUri: "https://claude.ai/callback" })).toBeNull();
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

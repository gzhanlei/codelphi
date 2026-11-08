import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken, loadTokenKeyring } from "../lib/token-crypto";
import { clearChandlerTokens, getValidUserToken, storeChandlerTokens } from "../lib/chandler-token";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const KEYS = JSON.stringify({ "1": Buffer.alloc(32, 1).toString("base64"), "2": Buffer.alloc(32, 2).toString("base64") });

function harness(rows: Array<Record<string, unknown>> = [], options: { lockAcquired?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const conns: Array<{ release: ReturnType<typeof vi.fn> }> = [];
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT GET_LOCK")) return [[{ acquired: options.lockAcquired === false ? 0 : 1 }]];
          if (sql.includes("SELECT RELEASE_LOCK")) return [{ result: 1 }];
          if (sql.includes("FROM chandler_tokens WHERE user_id")) return [rows, []];
          return [{ affectedRows: 1 }];
        }),
        beginTransaction: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        release: vi.fn(),
      };
      conns.push(conn);
      return conn;
    }),
  };
  return { calls, conns, db, sqls: () => calls.map((c) => c.sql) };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  const keyring = loadTokenKeyring(KEYS, "1");
  const access = encryptToken("stale-access", keyring);
  const refresh = encryptToken("refresh-1", keyring);
  return {
    access_token: access.cipher,
    refresh_token: refresh.cipher,
    key_version: access.keyVersion,
    token_expires_at: new Date(Date.now() - 1_000),
    ...overrides,
  };
}

function stubRefresh(ok: boolean, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(ok ? JSON.stringify(body) : "rejected", { status: ok ? 200 : 400 })));
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("token crypto keyring", () => {
  it("round-trips encrypt/decrypt with the current version", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY_VERSION", "2");
    const { cipher, keyVersion } = encryptToken("secret-token");
    expect(keyVersion).toBe("2");
    expect(decryptToken(cipher, "2")).toBe("secret-token");
  });

  it("decrypts older versions still present in the keyring (rotation)", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY_VERSION", "2");
    const old = encryptToken("legacy", loadTokenKeyring(KEYS, "1"));
    expect(decryptToken(old.cipher, "1")).toBe("legacy");
  });

  it("rejects malformed keyrings instead of silently weakening", () => {
    expect(() => loadTokenKeyring("not json")).toThrow("not valid JSON");
    expect(() => loadTokenKeyring(JSON.stringify({ "1": "short" }))).toThrow("32 bytes");
    expect(() => loadTokenKeyring(KEYS, "9")).toThrow("no key");
  });
});

describe("getValidUserToken", () => {
  it("returns a still-valid access token without refreshing", async () => {
    const h = harness([{ access_token: encryptToken("fresh", loadTokenKeyring(KEYS, "1")).cipher, refresh_token: null, key_version: "1", token_expires_at: new Date(Date.now() + 600_000) }]);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect(await getValidUserToken(1)).toBe("fresh");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes an expired token via /v1/auth/refresh and stores the rotated pair", async () => {
    const h = harness([makeRow()]);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    stubRefresh(true, { data: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } });
    expect(await getValidUserToken(1)).toBe("new-access");
    const upsert = h.calls.find((c) => c.sql.includes("INSERT INTO chandler_tokens"))!;
    // 旋转式：新 refresh token 必须落库（COALESCE 保留旧值仅在刷新响应缺失时）
    expect(upsert.params[2]).not.toBeNull();
    expect(h.sqls().some((sql) => sql.includes("RELEASE_LOCK"))).toBe(true);
    expect(h.conns[0].release).toHaveBeenCalled();
  });

  it("clears the row and reports not_bound when refresh is rejected (4xx, rotated token)", async () => {
    const h = harness([makeRow()]);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    stubRefresh(false, { error: "invalid_grant" });
    await expect(getValidUserToken(1)).rejects.toMatchObject({ code: "refresh_rejected" });
    expect(h.sqls().some((sql) => sql.includes("DELETE FROM chandler_tokens"))).toBe(true);
  });

  it("keeps the row retryable when refresh times out (5xx / network)", async () => {
    const h = harness([makeRow()]);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream error", { status: 502 })));
    await expect(getValidUserToken(1)).rejects.toMatchObject({ code: "refresh_failed" });
    expect(h.sqls().some((sql) => sql.includes("DELETE FROM chandler_tokens"))).toBe(false);
  });

  it("reports not_bound when the user has no stored token", async () => {
    const h = harness([]);
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    await expect(getValidUserToken(1)).rejects.toMatchObject({ code: "not_bound" });
  });

  it("reports lock-busy as retryable when another request is refreshing", async () => {
    const h = harness([makeRow()], { lockAcquired: false });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    await expect(getValidUserToken(1)).rejects.toMatchObject({ code: "refresh_failed" });
  });
});

describe("storeChandlerTokens / clearChandlerTokens", () => {
  it("upserts encrypted tokens and keeps the old refresh token when absent", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", KEYS);
    await storeChandlerTokens(1, { accessToken: "a", expiresIn: 60 });
    const call = h.calls.find((c) => c.sql.includes("INSERT INTO chandler_tokens"))!;
    expect(call.sql).toContain("COALESCE(VALUES(refresh_token), refresh_token)");
    expect(call.params[2]).toBeNull();
  });

  it("deletes the row on demand", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    await clearChandlerTokens(1);
    expect(h.sqls().some((sql) => sql.includes("DELETE FROM chandler_tokens"))).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom, consumeRateLimit } from "../lib/rate-limit";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

interface Route {
  match: (sql: string) => boolean;
  handle: (params: unknown[]) => unknown;
}

function harness(options: { rowCount?: number; failConnection?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const routes: Route[] = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> }> = [];
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      if (options.failConnection) throw new Error("database unreachable");
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          for (const route of routes) if (route.match(sql)) return [route.handle(params), []];
          return [[{ count: options.rowCount ?? 0, windowStart: new Date(0) }], []];
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
  return {
    calls,
    conns,
    db,
    on(match: string, handle: (params: unknown[]) => unknown, opts: { first?: boolean } = {}) {
      const route = { match: (sql: string) => sql.includes(match), handle };
      if (opts.first) routes.unshift(route);
      else routes.push(route);
    },
  };
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
  vi.unstubAllEnvs();
});

describe("consumeRateLimit", () => {
  it("allows and persists the incremented count inside the window", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "secret-1");
    const result = await consumeRateLimit({ kind: "ip", identity: "1.2.3.4", limit: 10, windowSeconds: 3600 });
    expect(result.allowed).toBe(true);
    const upsert = h.calls.find((c) => c.sql.includes("ON DUPLICATE KEY UPDATE"));
    // 锁内绝对值写入：count = 旧值 + 1；ODKU 的 IF(window_start = ...) 仅作防御兜底（P1-5）
    expect(upsert?.params[2]).toBe(1);
    expect(h.conns[0].commit).toHaveBeenCalledOnce();
  });

  it("denies with a window-aligned Retry-After once the limit is reached (P1-5)", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "secret-1");
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const windowSeconds = 3600;
      h.on("SELECT count, window_start", () => [{ count: 10, windowStart: new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000) }]);
      const result = await consumeRateLimit({ kind: "ip", identity: "1.2.3.4", limit: 10, windowSeconds });
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
      expect(h.conns[0].commit).toHaveBeenCalledOnce();
      // 拒绝路径零写入
      expect(h.calls.some((c) => c.sql.includes("INSERT INTO rate_limit_hits"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the count when the fixed window rolls over", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "secret-1");
    const now = Date.now();
    vi.useFakeTimers({ now });
    try {
      const windowSeconds = 3600;
      // 上一窗口的旧行：window_start 与当前窗口不匹配 → 计数归零重开
      h.on("SELECT count, window_start", () => [{ count: 10, windowStart: new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000 - windowSeconds * 1000) }]);
      const result = await consumeRateLimit({ kind: "user", identity: "u-1", limit: 10, windowSeconds });
      expect(result.allowed).toBe(true);
      const upsert = h.calls.find((c) => c.sql.includes("ON DUPLICATE KEY UPDATE"));
      expect(upsert?.params[2]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when the database is unreachable and warns (protection measure, not a blocker)", async () => {
    const h = harness({ failConnection: true });
    vi.mocked(getDb).mockReturnValue(h.db as never);
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "secret-1");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await consumeRateLimit({ kind: "ip", identity: "1.2.3.4", limit: 1, windowSeconds: 3600 });
      expect(result.allowed).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("disables itself without the HMAC secret instead of hashing with an empty key", async () => {
    const h = harness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    delete process.env.RATE_LIMIT_KEY_SECRET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await consumeRateLimit({ kind: "ip", identity: "1.2.3.4", limit: 1, windowSeconds: 3600 });
      expect(result.allowed).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keys different identities independently (same key text, different HMAC per kind/identity)", async () => {
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "secret-1");
    const h1 = harness();
    vi.mocked(getDb).mockReturnValue(h1.db as never);
    const a = await consumeRateLimit({ kind: "ip", identity: "1.2.3.4", limit: 1, windowSeconds: 3600 });
    const h2 = harness();
    vi.mocked(getDb).mockReturnValue(h2.db as never);
    const b = await consumeRateLimit({ kind: "user", identity: "1.2.3.4", limit: 1, windowSeconds: 3600 });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    // ip: 与 user: 同 identity 也必须是不同 HMAC 键
    const keyA = h1.calls.find((c) => c.sql.includes("SELECT count"))?.params[0];
    const keyB = h2.calls.find((c) => c.sql.includes("SELECT count"))?.params[0];
    expect(keyA).not.toBe(keyB);
  });
});

describe("clientIpFrom", () => {
  it("takes the right-most hop of X-Forwarded-For by default (trusted proxy count = 1)", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" });
    expect(clientIpFrom(headers)).toBe("10.0.0.2");
  });

  it("honours TRUSTED_PROXY_COUNT for deeper proxy chains", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "2");
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" });
    expect(clientIpFrom(headers)).toBe("10.0.0.1");
  });

  it("ignores a client-supplied first entry that would spoof the identity", () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4" });
    // 单跳 XFF 且无反代信息：仍取最右（部署形态下该值由我方反代写入）
    expect(clientIpFrom(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip then unknown", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});

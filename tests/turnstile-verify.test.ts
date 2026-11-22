import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnstileEnforced, verifyTurnstileToken } from "../lib/turnstile-verify";

/** CoDelphi 自有人机验证（信任合作伙伴模式）：成对 env 才启用，路由内 siteverify，fail-closed。 */
describe("turnstile-verify", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function freshModule() {
    return await import("../lib/turnstile-verify");
  }

  function siteverifyResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  it("未配置/只配其一时不启用：verify 直接放行且不请求 siteverify", async () => {
    const { verifyTurnstileToken } = await freshModule();
    const fetcher = vi.fn();
    await expect(verifyTurnstileToken("", "login", undefined, fetcher)).resolves.toEqual({ ok: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("TURNSTILE_SITE_KEY 与 SECRET 必须成对：只配其一视为未启用", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    let { turnstileEnforced } = await freshModule();
    expect(turnstileEnforced()).toBe(false);
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    ({ turnstileEnforced } = await freshModule());
    expect(turnstileEnforced()).toBe(true);
  });

  it("启用后：成功 token（action 匹配）→ ok，且携带 secret/remoteip 上送", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    const { verifyTurnstileToken } = await freshModule();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => siteverifyResponse({ success: true, action: "login" }));
    const result = await verifyTurnstileToken("0.valid-token", "login", "1.2.3.4", fetcher as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toContain("secret=0x4AAA_secret");
    expect(String(init.body)).toContain("response=0.valid-token");
    expect(String(init.body)).toContain("remoteip=1.2.3.4");
  });

  it("启用后：空/超长 token 直接拒绝，不出网", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    const { verifyTurnstileToken } = await freshModule();
    const fetcher = vi.fn();
    await expect(verifyTurnstileToken("", "login", undefined, fetcher as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_failed" });
    await expect(verifyTurnstileToken("x".repeat(2049), "login", undefined, fetcher as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_failed" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("启用后：siteverify 判失败或 action 不匹配 → turnstile_failed", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    const { verifyTurnstileToken } = await freshModule();
    const rejected = vi.fn(async () => siteverifyResponse({ success: false, "error-codes": ["invalid-input-response"] }));
    await expect(verifyTurnstileToken("0.token", "login", undefined, rejected as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_failed" });
    const wrongAction = vi.fn(async () => siteverifyResponse({ success: true, action: "register" }));
    await expect(verifyTurnstileToken("0.token", "login", undefined, wrongAction as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_failed" });
  });

  it("启用后：siteverify 不可达/HTTP 异常 → fail-closed turnstile_unavailable", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    const { verifyTurnstileToken } = await freshModule();
    const unreachable = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(verifyTurnstileToken("0.token", "login", undefined, unreachable as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_unavailable" });
    const httpError = vi.fn(async () => siteverifyResponse({}, 500));
    await expect(verifyTurnstileToken("0.token", "login", undefined, httpError as unknown as typeof fetch)).resolves.toEqual({ ok: false, code: "turnstile_unavailable" });
  });
});

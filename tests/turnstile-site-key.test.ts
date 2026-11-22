import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTurnstileSiteKey } from "../lib/turnstile-site-key";

/** site key 解析（指南 v3.12）：capabilities 优先并配对强制开关，env 仅兜底，成功结果短缓存。 */
describe("resolveTurnstileSiteKey", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("CHANDLER_BASE_URL", "https://chandler.test");
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_env");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  async function freshResolve() {
    const module = await import("../lib/turnstile-site-key");
    return module.resolveTurnstileSiteKey();
  }

  it("capabilities 返回 site key 时优先采用（换新自动跟随）", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ turnstile_site_key: "0x4AAA_live" }), { status: 200 })) as typeof fetch;
    await expect(freshResolve()).resolves.toBe("0x4AAA_live");
  });

  it("capabilities 未下发 site key（gate 关闭）→ 返回空，不渲染 widget", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ sms_otp_enabled: false }), { status: 200 })) as typeof fetch;
    await expect(freshResolve()).resolves.toBe("");
  });

  it("capabilities 不可达 → 回退 env 兜底", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await expect(freshResolve()).resolves.toBe("0x4AAA_env");
  });

  it("成功结果短缓存，缓存期内不再请求 capabilities", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ turnstile_site_key: "0x4AAA_live" }), { status: 200 }));
    globalThis.fetch = fetcher as unknown as typeof fetch;
    await freshResolve();
    await freshResolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

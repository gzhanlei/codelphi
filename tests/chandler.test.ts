import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeChandlerOAuth, assertChandlerAllowed, isChandlerEmailAllowed } from "../lib/chandler";

describe("Chandler OAuth boundary", () => {
  beforeEach(() => {
    vi.stubEnv("CHANDLER_CLIENT_ID", "test-client");
    vi.stubEnv("CHANDLER_CLIENT_SECRET", "test-secret");
    vi.stubEnv("CHANDLER_BASE_URL", "https://api.chandler.work");
  });
  it("allows Chandler users by default and enforces only an explicit allowlist", () => {
    const allowed = new Set(["person@example.com"]);
    expect(isChandlerEmailAllowed("PERSON@example.com", allowed)).toBe(true);
    expect(isChandlerEmailAllowed("other@example.com", allowed)).toBe(false);
    expect(isChandlerEmailAllowed(undefined, allowed)).toBe(false);
    expect(isChandlerEmailAllowed("person@example.com", new Set())).toBe(true);
    expect(isChandlerEmailAllowed("other@example.com", new Set())).toBe(true);
    expect(isChandlerEmailAllowed(undefined, new Set())).toBe(true);
    expect(isChandlerEmailAllowed(undefined, new Set())).toBe(true);
  });

  it("does not require a user list unless the deployment explicitly enables one", () => {
    expect(() => assertChandlerAllowed("person@example.com", new Set())).not.toThrow();
    expect(() => assertChandlerAllowed(undefined, new Set())).not.toThrow();
    expect(() => assertChandlerAllowed("person@example.com", new Set(["person@example.com"]))).not.toThrow();
    expect(() => assertChandlerAllowed("other@example.com", new Set(["person@example.com"]))).toThrow("forbidden");
  });

  it("exchanges PKCE credentials and normalizes the profile", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(JSON.stringify({ data: { access_token: "access-token" } }), { status: 200 });
      return new Response(JSON.stringify({ data: { sub: "usr_1", email: " PERSON@example.com ", name: null, picture: null } }), { status: 200 });
    });

    const { profile, tokens } = await completeChandlerOAuth({ code: "auth-code", verifier: "pkce-verifier", redirectUri: "http://localhost:3008/auth/callback" }, fetcher);
    expect(profile).toEqual({ sub: "usr_1", email: "person@example.com", name: undefined, picture: undefined });
    // refresh_token / expires_in 随 token 响应透传（M3-T1：加密落库由 chandler-token 负责）
    expect(tokens).toEqual({ accessToken: "access-token" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.chandler.work/v1/oauth/token");
    expect(calls[0].init?.body).toBeInstanceOf(URLSearchParams);
    expect((calls[0].init?.body as URLSearchParams).get("code_verifier")).toBe("pkce-verifier");
    expect(calls[1].init?.headers).toEqual({ Authorization: "Bearer access-token" });
  });

  it("handles absent emails and preserves explicitly empty profile fields", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "usr_2", name: "", picture: "" }), { status: 200 }));
    await expect(completeChandlerOAuth({ code: "code", verifier: "v", redirectUri: "http://localhost/cb" }, fetcher)).resolves.toEqual({ profile: { sub: "usr_2", email: undefined, name: "", picture: "" }, tokens: { accessToken: "a" } });
  });

  it("surfaces token and userinfo failures with stable error codes", async () => {
    await expect(completeChandlerOAuth({ code: "bad", verifier: "v", redirectUri: "http://localhost/cb" }, async () => new Response("no", { status: 401 }))).rejects.toThrow("token_exchange_failed");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("no", { status: 500 }));
    await expect(completeChandlerOAuth({ code: "bad", verifier: "v", redirectUri: "http://localhost/cb" }, fetcher)).rejects.toThrow("userinfo_failed");
  });
});

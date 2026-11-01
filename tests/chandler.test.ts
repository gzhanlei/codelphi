import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeChandlerOAuth, assertChandlerAllowed, isChandlerEmailAllowed } from "../lib/chandler";

describe("Chandler OAuth boundary", () => {
  beforeEach(() => {
    vi.stubEnv("CHANDLER_CLIENT_ID", "test-client");
    vi.stubEnv("CHANDLER_CLIENT_SECRET", "test-secret");
    vi.stubEnv("CHANDLER_BASE_URL", "https://api.chandler.work");
  });
  it("applies the production allowlist and accepts development without one", () => {
    const allowed = new Set(["person@example.com"]);
    expect(isChandlerEmailAllowed("PERSON@example.com", allowed, true)).toBe(true);
    expect(isChandlerEmailAllowed("other@example.com", allowed, true)).toBe(false);
    expect(isChandlerEmailAllowed(undefined, allowed, true)).toBe(false);
    expect(isChandlerEmailAllowed("person@example.com", new Set(), true)).toBe(false);
    expect(isChandlerEmailAllowed(undefined, new Set(), false)).toBe(true);
  });

  it("rejects a profile outside the production allowlist", () => {
    expect(() => assertChandlerAllowed("person@example.com", new Set(), true)).toThrow("forbidden");
    expect(() => assertChandlerAllowed("person@example.com", new Set(["person@example.com"]), true)).not.toThrow();
  });

  it("exchanges PKCE credentials and normalizes the profile", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response(JSON.stringify({ data: { access_token: "access-token" } }), { status: 200 });
      return new Response(JSON.stringify({ data: { sub: "usr_1", email: " PERSON@example.com ", name: null, picture: null } }), { status: 200 });
    });

    const profile = await completeChandlerOAuth({ code: "auth-code", verifier: "pkce-verifier", redirectUri: "http://localhost:3008/auth/callback" }, fetcher);
    expect(profile).toEqual({ sub: "usr_1", email: "person@example.com", name: undefined, picture: undefined });
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
    await expect(completeChandlerOAuth({ code: "code", verifier: "v", redirectUri: "http://localhost/cb" }, fetcher)).resolves.toEqual({ sub: "usr_2", email: undefined, name: "", picture: "" });
  });

  it("surfaces token and userinfo failures with stable error codes", async () => {
    await expect(completeChandlerOAuth({ code: "bad", verifier: "v", redirectUri: "http://localhost/cb" }, async () => new Response("no", { status: 401 }))).rejects.toThrow("token_exchange_failed");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("no", { status: 500 }));
    await expect(completeChandlerOAuth({ code: "bad", verifier: "v", redirectUri: "http://localhost/cb" }, fetcher)).rejects.toThrow("userinfo_failed");
  });
});

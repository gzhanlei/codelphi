import { describe, expect, it } from "vitest";
import { oauthErrorCode, oauthFailurePath, parseOAuthCallback, requireOAuthCallback } from "../lib/oauth-request";

describe("OAuth callback request", () => {
  it("accepts a matching state and preserves a safe return path", () => {
    expect(parseOAuthCallback({ code: "code", state: "state", expectedState: "state", verifier: "verifier", next: "/products/radar" })).toEqual({ code: "code", verifier: "verifier", next: "/products/radar" });
  });

  it("rejects missing or mismatched credentials", () => {
    expect(parseOAuthCallback({ code: "code", state: "wrong", expectedState: "state", verifier: "verifier", next: "/" })).toBeNull();
    expect(parseOAuthCallback({ code: null, state: "state", expectedState: "state", verifier: "verifier", next: "/" })).toBeNull();
    expect(parseOAuthCallback({ code: "code", state: null, expectedState: "state", verifier: "verifier", next: "/" })).toBeNull();
    expect(parseOAuthCallback({ code: "code", state: "state", expectedState: undefined, verifier: "verifier", next: "/" })).toBeNull();
    expect(parseOAuthCallback({ code: "code", state: "state", expectedState: "state", verifier: undefined, next: "/" })).toBeNull();
  });

  it("falls back to the dashboard for unsafe return paths", () => {
    expect(parseOAuthCallback({ code: "code", state: "state", expectedState: "state", verifier: "verifier", next: "//evil.example" })?.next).toBe("/");
  });

  it("maps only known OAuth failures to public error codes", () => {
    expect(oauthErrorCode(new Error("token_exchange_failed"))).toBe("token_exchange_failed");
    expect(oauthErrorCode(new Error("userinfo_failed"))).toBe("userinfo_failed");
    expect(oauthErrorCode(new Error("database down"))).toBe("userinfo_failed");
    expect(oauthErrorCode(null)).toBe("userinfo_failed");
  });

  it("requires valid callback input and maps failures to destinations", () => {
    expect(() => requireOAuthCallback({ code: null, state: null, verifier: undefined, next: null })).toThrow("invalid_oauth_state");
    expect(oauthFailurePath(new Error("invalid_oauth_state"))).toBe("/login?error=invalid_oauth_state");
    expect(oauthFailurePath(new Error("forbidden"))).toBe("/forbidden");
    expect(oauthFailurePath(new Error("token_exchange_failed"))).toBe("/login?error=token_exchange_failed");
  });
});

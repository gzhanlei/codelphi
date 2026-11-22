import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/auth/callback/route";
import { completeChandlerOAuth } from "@/lib/chandler";
import { establishCodelphiSession } from "@/lib/chandler-auth";

vi.mock("@/lib/chandler", () => ({
  completeChandlerOAuth: vi.fn(),
  assertChandlerAllowed: vi.fn(),
}));
// 会话落地面（写用户行/存令牌/建会话）已在 chandler-auth.test.ts 覆盖；这里只断言回调正确委托。
vi.mock("@/lib/chandler-auth", () => ({ establishCodelphiSession: vi.fn(async () => undefined) }));

function callback(cookie = "") {
  return new NextRequest("https://codelphi.com/auth/callback?code=code&state=state", { headers: { cookie } });
}

describe("Chandler OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "https://codelphi.com");
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
  });

  it("creates a session via the shared bootstrap and uses the safe default next path when the optional cookie is absent", async () => {
    const profile = { sub: "user-1", email: "person@example.com" };
    vi.mocked(completeChandlerOAuth).mockResolvedValue({
      profile,
      tokens: { accessToken: "at", refreshToken: "rt", expiresIn: 3600 },
    });
    const response = await GET(callback("codelphi_oauth_state=state; codelphi_oauth_verifier=verifier"));
    expect(response.headers.get("location")).toBe("https://codelphi.com/");
    expect(establishCodelphiSession).toHaveBeenCalledWith(profile, { accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  });

  it("rejects a missing state cookie before exchanging credentials", async () => {
    const response = await GET(callback("codelphi_oauth_verifier=verifier"));
    expect(response.headers.get("location")).toBe("https://codelphi.com/login?error=invalid_oauth_state");
    expect(completeChandlerOAuth).not.toHaveBeenCalled();
    expect(establishCodelphiSession).not.toHaveBeenCalled();
  });
});

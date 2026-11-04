import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/auth/callback/route";
import { completeChandlerOAuth } from "@/lib/chandler";
import { createSession } from "@/lib/session";
import { upsertRadarUser } from "@/lib/users";

vi.mock("@/lib/chandler", () => ({ completeChandlerOAuth: vi.fn(), assertChandlerAllowed: vi.fn() }));
vi.mock("@/lib/session", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/users", () => ({ upsertRadarUser: vi.fn() }));

function callback(cookie = "") {
  return new NextRequest("https://radar.chandler.work/auth/callback?code=code&state=state", { headers: { cookie } });
}

describe("Chandler OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "https://radar.chandler.work");
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
  });

  it("creates a session and uses the safe default next path when the optional cookie is absent", async () => {
    const profile = { sub: "user-1", email: "person@example.com" };
    vi.mocked(completeChandlerOAuth).mockResolvedValue(profile);
    const response = await GET(callback("radar_oauth_state=state; radar_oauth_verifier=verifier"));
    expect(response.headers.get("location")).toBe("https://radar.chandler.work/");
    expect(upsertRadarUser).toHaveBeenCalledWith(profile);
    expect(createSession).toHaveBeenCalledWith(profile);
  });

  it("rejects a missing state cookie before exchanging credentials", async () => {
    const response = await GET(callback("radar_oauth_verifier=verifier"));
    expect(response.headers.get("location")).toBe("https://radar.chandler.work/login?error=invalid_oauth_state");
    expect(completeChandlerOAuth).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChandlerAuthError,
  chandlerProfileFromAuthUser,
  establishCodelphiSession,
  loginChandlerUser,
  registerChandlerUser,
  sendChandlerRegisterCode,
  verifyChandlerMfa,
} from "../lib/chandler-auth";
import { createSession } from "../lib/session";
import { storeChandlerTokens } from "../lib/chandler-token";
import { upsertCodelphiUser } from "../lib/users";

vi.mock("../lib/session", () => ({ createSession: vi.fn(async () => undefined) }));
vi.mock("../lib/chandler-token", () => ({ storeChandlerTokens: vi.fn(async () => undefined) }));
vi.mock("../lib/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/users")>();
  return { ...actual, upsertCodelphiUser: vi.fn(async () => undefined), findUserIdBySub: vi.fn(async () => 7) };
});
vi.mock("../lib/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/env")>(),
  chandlerBaseUrl: () => "https://chandler.test",
}));

const authResponse = {
  data: {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    user: { id: "user-uuid-1", email: "Person@Example.com", display_name: "韩雷", avatar: "https://a/p.png" },
  },
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Chandler 密码注册/登录客户端", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("注册成功：解析 AuthResponse 并把 user 映射为 SessionUser（sub=用户 id），勾选同意时透传 agree_policies，且不携带 cf_turnstile_response", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, authResponse));
    const result = await registerChandlerUser(
      { email: "person@example.com", password: "Passw0rd!", emailCode: "123456", agreePolicies: true },
      fetcher,
    );
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(init.method).toBe("POST");
    expect(body).toEqual({
      email: "person@example.com",
      password: "Passw0rd!",
      display_name: undefined,
      email_code: "123456",
      agree_policies: true,
    });
    expect("cf_turnstile_response" in body).toBe(false);
    expect(result.mfaRequired).toBeFalsy();
    expect(result.user?.id).toBe("user-uuid-1");
    expect(result.tokens).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    expect(chandlerProfileFromAuthUser(result.user!)).toEqual({
      sub: "user-uuid-1",
      email: "person@example.com",
      name: "韩雷",
      picture: "https://a/p.png",
    });
  });

  it("邮箱验证码错误映射为 email_code_invalid，邮箱已占用映射为 email_taken", async () => {
    const badCode = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(400, { error: { code: "auth.invalid_code", message: "验证码错误" } }));
    await expect(registerChandlerUser({ email: "a@b.c", password: "Passw0rd!", emailCode: "000000" }, badCode))
      .rejects.toMatchObject({ code: "email_code_invalid" });
    const taken = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(409, { error: { code: "auth.email_taken", message: "邮箱已注册" } }));
    await expect(registerChandlerUser({ email: "a@b.c", password: "Passw0rd!", emailCode: "123456" }, taken))
      .rejects.toMatchObject({ code: "email_taken" });
  });

  it("发送注册验证码：成功返回 sent，冷却期映射为 otp_cooldown", async () => {
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { status: "sent" }));
    await expect(sendChandlerRegisterCode("a@b.c", ok)).resolves.toBeUndefined();
    const [, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@b.c" });
    const cooldown = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(429, { error: { code: "auth.otp_cooldown", message: "发送过于频繁" } }));
    await expect(sendChandlerRegisterCode("a@b.c", cooldown)).rejects.toMatchObject({ code: "otp_cooldown" });
  });

  it("登录成功返回用户与令牌；428 返回 MFA 挑战而非抛错", async () => {
    const ok = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, authResponse));
    const result = await loginChandlerUser({ account: "person@example.com", password: "Passw0rd!" }, ok);
    expect(result.mfaRequired).toBeFalsy();
    expect(result.user?.id).toBe("user-uuid-1");
    const [, init] = ok.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ email: "person@example.com", password: "Passw0rd!" });

    const mfa = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(428, { mfa_required: true, mfa_token: "mfa-1" }));
    const challenge = await loginChandlerUser({ account: "u", password: "p" }, mfa);
    expect(challenge).toEqual({ mfaRequired: true, mfaToken: "mfa-1" });
  });

  it("登录失败按 Chandler 错误码映射：401 凭证错误、403 Turnstile 失败、5xx/网络不可达统一 unavailable", async () => {
    const unauthorized = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(401, { error: { code: "auth.invalid_credentials", message: "账号或密码错误" } }));
    await expect(loginChandlerUser({ account: "u", password: "p" }, unauthorized))
      .rejects.toMatchObject({ code: "invalid_credentials" });
    const gate = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(403, { error: { code: "auth.turnstile_failed", message: "人机验证未通过" } }));
    await expect(loginChandlerUser({ account: "u", password: "p" }, gate))
      .rejects.toMatchObject({ code: "turnstile_failed" });
    const down = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(500, { error: { code: "internal", message: "boom" } }));
    await expect(loginChandlerUser({ account: "u", password: "p" }, down))
      .rejects.toMatchObject({ code: "unavailable" });
    const unreachable = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(loginChandlerUser({ account: "u", password: "p" }, unreachable))
      .rejects.toBeInstanceOf(ChandlerAuthError);
  });

  it("MFA 验证成功返回用户与令牌", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, authResponse));
    const result = await verifyChandlerMfa({ mfaToken: "mfa-1", code: "654321" }, fetcher);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(fetcher.mock.calls[0][0]).toContain("/v1/auth/mfa/verify");
    expect(JSON.parse(String(init.body))).toEqual({ mfa_token: "mfa-1", code: "654321" });
    expect(result.user?.id).toBe("user-uuid-1");
  });

  it("establishCodelphiSession：写入用户 → 保存 Chandler 令牌 → 建会话；令牌保存失败不阻断登录", async () => {
    const profile = { sub: "user-uuid-1", email: "person@example.com" };
    await establishCodelphiSession(profile, { accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
    expect(upsertCodelphiUser).toHaveBeenCalledWith(profile);
    expect(storeChandlerTokens).toHaveBeenCalledWith(7, { accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
    expect(createSession).toHaveBeenCalledWith(profile);

    vi.mocked(storeChandlerTokens).mockRejectedValueOnce(new Error("encrypt failed"));
    await expect(establishCodelphiSession(profile, { accessToken: "at" })).resolves.toBeUndefined();
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});

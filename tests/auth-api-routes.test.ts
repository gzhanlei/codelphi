import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChandlerAuthError } from "../lib/chandler-auth";

type ChandlerAuthModule = typeof import("../lib/chandler-auth");
const loginChandlerUser = vi.fn<ChandlerAuthModule["loginChandlerUser"]>();
const registerChandlerUser = vi.fn<ChandlerAuthModule["registerChandlerUser"]>();
const sendChandlerRegisterCode = vi.fn<ChandlerAuthModule["sendChandlerRegisterCode"]>();
const verifyChandlerMfa = vi.fn<ChandlerAuthModule["verifyChandlerMfa"]>();
const establishCodelphiSession = vi.fn<ChandlerAuthModule["establishCodelphiSession"]>();

vi.mock("../lib/chandler-auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/chandler-auth")>(),
  loginChandlerUser: (...args: Parameters<ChandlerAuthModule["loginChandlerUser"]>) => loginChandlerUser(...args),
  registerChandlerUser: (...args: Parameters<ChandlerAuthModule["registerChandlerUser"]>) => registerChandlerUser(...args),
  sendChandlerRegisterCode: (...args: Parameters<ChandlerAuthModule["sendChandlerRegisterCode"]>) => sendChandlerRegisterCode(...args),
  verifyChandlerMfa: (...args: Parameters<ChandlerAuthModule["verifyChandlerMfa"]>) => verifyChandlerMfa(...args),
  establishCodelphiSession: (...args: Parameters<ChandlerAuthModule["establishCodelphiSession"]>) => establishCodelphiSession(...args),
}));
// turnstile-verify 保持真实现：默认 env 未配置 → 不启用；启用场景用 TURNSTILE_* env +
// stub 全局 fetch 模拟 siteverify 响应（route 内仅 siteverify 走全局 fetch）。

const authUser = { id: "user-uuid-1", email: "person@example.com", displayName: "韩雷", avatar: undefined };

function post(path: string, body: unknown) {
  return new NextRequest(`https://codelphi.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubSiteverify(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/auth/login", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
    vi.stubEnv("CHANDLER_BASE_URL", "http://127.0.0.1:9");
    ({ POST } = await import("../app/api/auth/login/route"));
  });

  it("人机验证未启用时直接透传 Chandler 并在成功后建立会话", async () => {
    loginChandlerUser.mockResolvedValue({ user: authUser, tokens: { accessToken: "at" } });
    const response = await POST(post("/api/auth/login", { account: "person@example.com", password: "Passw0rd!" }));
    expect(response.status).toBe(200);
    expect(loginChandlerUser).toHaveBeenCalledWith({ account: "person@example.com", password: "Passw0rd!" });
    expect(establishCodelphiSession).toHaveBeenCalledWith(
      { sub: "user-uuid-1", email: "person@example.com", name: "韩雷", picture: undefined },
      { accessToken: "at" },
    );
    expect(await response.json()).toEqual({ ok: true });
  });

  it("428 MFA 挑战原样返回 mfaToken，不建立会话", async () => {
    loginChandlerUser.mockResolvedValue({ mfaRequired: true, mfaToken: "mfa-1" });
    const response = await POST(post("/api/auth/login", { account: "u", password: "p" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, mfaRequired: true, mfaToken: "mfa-1" });
    expect(establishCodelphiSession).not.toHaveBeenCalled();
  });

  it("自有 Turnstile 启用后：缺 token 直接 403，不出网也不触发 Chandler", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await POST(post("/api/auth/login", { account: "u", password: "p" }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("turnstile_failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loginChandlerUser).not.toHaveBeenCalled();
  });

  it("自有 Turnstile 启用后：siteverify 判失败 → 403 turnstile_failed，token 不透传 Chandler", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const response = await POST(post("/api/auth/login", { account: "u", password: "p", turnstileToken: "0.bad" }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("turnstile_failed");
    expect(loginChandlerUser).not.toHaveBeenCalled();
  });

  it("自有 Turnstile 启用后：siteverify 通过 → 放行进入 Chandler 登录", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    stubSiteverify({ success: true, action: "login" });
    loginChandlerUser.mockResolvedValue({ user: authUser, tokens: { accessToken: "at" } });
    const response = await POST(post("/api/auth/login", { account: "person@example.com", password: "Passw0rd!", turnstileToken: "0.good" }));
    expect(response.status).toBe(200);
    expect(loginChandlerUser).toHaveBeenCalledWith({ account: "person@example.com", password: "Passw0rd!" });
    expect(await response.json()).toEqual({ ok: true });
  });

  it("Chandler 凭证错误映射为 401", async () => {
    loginChandlerUser.mockRejectedValue(new ChandlerAuthError("invalid_credentials", "auth.invalid_credentials"));
    const response = await POST(post("/api/auth/login", { account: "u", password: "p" }));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("invalid_credentials");
    expect(establishCodelphiSession).not.toHaveBeenCalled();
  });

  it("邮箱不在白名单时返回 403 forbidden", async () => {
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "other@example.com");
    loginChandlerUser.mockResolvedValue({ user: authUser, tokens: { accessToken: "at" } });
    const response = await POST(post("/api/auth/login", { account: "person@example.com", password: "p" }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("forbidden");
    expect(establishCodelphiSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/register", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
    vi.stubEnv("CHANDLER_BASE_URL", "http://127.0.0.1:9");
    ({ POST } = await import("../app/api/auth/register/route"));
  });

  it("注册成功后建立会话（agree_policies 勾选时透传）", async () => {
    registerChandlerUser.mockResolvedValue({ user: authUser, tokens: { accessToken: "at", refreshToken: "rt", expiresIn: 3600 } });
    const response = await POST(post("/api/auth/register", { email: "Person@Example.com", code: "123456", password: "Passw0rd!", displayName: "韩雷", agreePolicies: true }));
    expect(response.status).toBe(200);
    expect(registerChandlerUser).toHaveBeenCalledWith({
      email: "person@example.com",
      password: "Passw0rd!",
      displayName: "韩雷",
      emailCode: "123456",
      agreePolicies: true,
    });
    expect(establishCodelphiSession).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("自有 Turnstile 启用后：siteverify 通过才放行注册", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA_site");
    vi.stubEnv("TURNSTILE_SECRET", "0x4AAA_secret");
    stubSiteverify({ success: true, action: "register" });
    registerChandlerUser.mockResolvedValue({ user: authUser, tokens: { accessToken: "at" } });
    const response = await POST(post("/api/auth/register", { email: "a@b.co", code: "123456", password: "Passw0rd!", turnstileToken: "0.good" }));
    expect(response.status).toBe(200);
    expect(registerChandlerUser).toHaveBeenCalledTimes(1);

    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const rejected = await POST(post("/api/auth/register", { email: "a@b.co", code: "123456", password: "Passw0rd!", turnstileToken: "0.bad" }));
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).code).toBe("turnstile_failed");
  });

  it("邮箱已注册映射 409，弱密码映射 422，验证码错误（防枚举哨兵）映射 400 email_code_invalid", async () => {
    registerChandlerUser.mockRejectedValue(new ChandlerAuthError("email_taken", "auth.email_taken"));
    let response = await POST(post("/api/auth/register", { email: "a@b.co", code: "123456", password: "Passw0rd!" }));
    expect(response.status).toBe(409);
    registerChandlerUser.mockRejectedValue(new ChandlerAuthError("weak_password", "auth.weak_password"));
    response = await POST(post("/api/auth/register", { email: "a@b.co", code: "123456", password: "aaaaaaaa" }));
    expect(response.status).toBe(422);
    registerChandlerUser.mockRejectedValue(new ChandlerAuthError("invalid_credentials", "auth.invalid_credentials"));
    response = await POST(post("/api/auth/register", { email: "a@b.co", code: "000000", password: "Passw0rd!" }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("email_code_invalid");
    expect(establishCodelphiSession).not.toHaveBeenCalled();
  });

  it("非法请求体返回 400", async () => {
    const response = await POST(post("/api/auth/register", { email: "not-an-email", code: "", password: "" }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_input");
    expect(registerChandlerUser).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/register/send-code", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ POST } = await import("../app/api/auth/register/send-code/route"));
  });

  it("发送成功返回 sent", async () => {
    sendChandlerRegisterCode.mockResolvedValue(undefined);
    const response = await POST(post("/api/auth/register/send-code", { email: "A@B.com" }));
    expect(response.status).toBe(200);
    expect(sendChandlerRegisterCode).toHaveBeenCalledWith("a@b.com");
    expect(await response.json()).toEqual({ status: "sent" });
  });

  it("邮箱已注册映射 409，冷却期映射 429", async () => {
    sendChandlerRegisterCode.mockRejectedValue(new ChandlerAuthError("email_taken", "auth.email_taken"));
    expect((await POST(post("/api/auth/register/send-code", { email: "a@b.co" }))).status).toBe(409);
    sendChandlerRegisterCode.mockRejectedValue(new ChandlerAuthError("otp_cooldown", "auth.otp_cooldown"));
    expect((await POST(post("/api/auth/register/send-code", { email: "a@b.co" }))).status).toBe(429);
  });
});

describe("POST /api/auth/mfa", () => {
  let POST: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "");
    ({ POST } = await import("../app/api/auth/mfa/route"));
  });

  it("MFA 验证成功后建立会话；验证码错误映射 401", async () => {
    verifyChandlerMfa.mockResolvedValue({ user: authUser, tokens: { accessToken: "at" } });
    const response = await POST(post("/api/auth/mfa", { mfaToken: "mfa-1", code: "654321" }));
    expect(response.status).toBe(200);
    expect(verifyChandlerMfa).toHaveBeenCalledWith({ mfaToken: "mfa-1", code: "654321" });
    expect(establishCodelphiSession).toHaveBeenCalledTimes(1);
    verifyChandlerMfa.mockRejectedValue(new ChandlerAuthError("mfa_invalid_code", "auth.mfa_invalid_code"));
    expect((await POST(post("/api/auth/mfa", { mfaToken: "mfa-1", code: "000000" }))).status).toBe(401);
  });
});

import { z } from "zod";
import { chandlerBaseUrl } from "./env";
import { storeChandlerTokens } from "./chandler-token";
import { createSession } from "./session";
import { findUserIdBySub, upsertCodelphiUser } from "./users";
import type { SessionUser } from "./types";

/**
 * Chandler 密码注册/登录客户端（自建注册登录界面，Chandler 统一账号体系不变）：
 * - 注册走公开注册通道（verify-before-create）：POST /v1/auth/register/send-code 下发邮箱 OTP，
 *   POST /v1/auth/register 携带 email_code 注册；不携带 client_id（伙伴通道会豁免邮箱与 Turnstile 校验）。
 * - Cloudflare Turnstile token 由 CoDelphi 页面收集、随 cf_turnstile_response 透传，
 *   siteverify 由 Chandler 服务端执行（token 单次使用，CoDelphi 不得重复消费）。
 * - 登录 428 表示账号开启了 TOTP MFA，前端改走 /v1/auth/mfa/verify 完成挑战。
 * - 成功后的会话落地面与 OAuth 回调完全一致（upsert 用户 → 加密落库 Chandler 令牌 → 下发会话 cookie）。
 */

export type ChandlerAuthErrorCode =
  | "email_taken"
  | "email_code_invalid"
  | "otp_cooldown"
  | "otp_delivery_failed"
  | "invalid_credentials"
  | "weak_password"
  | "user_disabled"
  | "mfa_invalid_code"
  | "turnstile_failed"
  | "turnstile_unavailable"
  | "rate_limited"
  | "unavailable"
  | "invalid_input";

export class ChandlerAuthError extends Error {
  constructor(readonly code: ChandlerAuthErrorCode, message: string) {
    super(message);
    this.name = "ChandlerAuthError";
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ChandlerAuthUser {
  id: string;
  email?: string;
  displayName?: string;
  avatar?: string;
}

export interface ChandlerTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface ChandlerAuthOutcome {
  mfaRequired?: boolean;
  mfaToken?: string;
  user?: ChandlerAuthUser;
  tokens?: ChandlerTokens;
}

const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().optional().nullable(),
  display_name: z.string().optional().nullable(),
  avatar: z.string().optional().nullable(),
});

const authResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().optional(),
  user: authUserSchema,
});

const mfaChallengeSchema = z.object({
  mfa_required: z.boolean().optional(),
  mfa_token: z.string().min(1),
});

function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

const CHANDLER_ERROR_CODE_MAP: Record<string, ChandlerAuthErrorCode> = {
  "auth.email_taken": "email_taken",
  "auth.invalid_code": "email_code_invalid",
  "auth.email_code_required": "email_code_invalid",
  "auth.otp_cooldown": "otp_cooldown",
  "auth.otp_delivery_failed": "otp_delivery_failed",
  "auth.invalid_credentials": "invalid_credentials",
  "auth.weak_password": "weak_password",
  "auth.user_disabled": "user_disabled",
  "account.frozen": "user_disabled",
  "account.restricted": "user_disabled",
  "auth.mfa_invalid_code": "mfa_invalid_code",
  "auth.turnstile_failed": "turnstile_failed",
  "auth.turnstile_unavailable": "turnstile_unavailable",
};

function mapChandlerError(status: number, payload: unknown): ChandlerAuthError {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "string" && CHANDLER_ERROR_CODE_MAP[code]) {
    return new ChandlerAuthError(CHANDLER_ERROR_CODE_MAP[code], code);
  }
  if (status === 429) return new ChandlerAuthError("rate_limited", "rate_limited");
  if (status >= 500) return new ChandlerAuthError("unavailable", `chandler error (${status})`);
  return new ChandlerAuthError("invalid_input", `chandler error (${status})`);
}

async function postChandlerJson(path: string, body: unknown, fetcher: Fetcher, acceptStatuses: readonly number[] = []): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetcher(`${chandlerBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ChandlerAuthError("unavailable", `chandler unreachable: ${String(error)}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok && !acceptStatuses.includes(response.status)) throw mapChandlerError(response.status, payload);
  return { status: response.status, payload };
}

function parseAuthOutcome(payload: unknown): { user: ChandlerAuthUser; tokens: ChandlerTokens } {
  const parsed = authResponseSchema.safeParse(unwrap(payload));
  if (!parsed.success) throw new ChandlerAuthError("unavailable", "chandler auth response malformed");
  const user = parsed.data.user;
  return {
    user: {
      id: user.id,
      email: user.email?.trim() ? user.email.trim().toLowerCase() : undefined,
      displayName: user.display_name ?? undefined,
      avatar: user.avatar ?? undefined,
    },
    tokens: {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresIn: parsed.data.expires_in,
    },
  };
}

/** 注册前下发邮箱验证码（Chandler 60s 冷却；邮箱已注册返回 email_taken）。 */
export async function sendChandlerRegisterCode(email: string, fetcher: Fetcher = fetch): Promise<void> {
  await postChandlerJson("/v1/auth/register/send-code", { email }, fetcher);
}

export async function registerChandlerUser(
  input: { email: string; password: string; displayName?: string; emailCode: string; turnstileToken: string; agreePolicies?: boolean },
  fetcher: Fetcher = fetch,
): Promise<ChandlerAuthOutcome> {
  const { payload } = await postChandlerJson(
    "/v1/auth/register",
    {
      email: input.email,
      password: input.password,
      display_name: input.displayName?.trim() || undefined,
      email_code: input.emailCode,
      cf_turnstile_response: input.turnstileToken,
      // 指南 v3.12 §2.2：仅当用户勾选同意时上报，服务端据此记录版本化同意行
      agree_policies: input.agreePolicies === true ? true : undefined,
    },
    fetcher,
  );
  return parseAuthOutcome(payload);
}

export async function loginChandlerUser(
  input: { account: string; password: string; turnstileToken: string },
  fetcher: Fetcher = fetch,
): Promise<ChandlerAuthOutcome> {
  // 428 = MFA 挑战（非错误），透传给调用方判定
  const { payload } = await postChandlerJson(
    "/v1/auth/login",
    { email: input.account, password: input.password, cf_turnstile_response: input.turnstileToken },
    fetcher,
    [428],
  );
  const challenge = mfaChallengeSchema.safeParse(payload);
  if (challenge.success) return { mfaRequired: true, mfaToken: challenge.data.mfa_token };
  return parseAuthOutcome(payload);
}

export async function verifyChandlerMfa(
  input: { mfaToken: string; code: string },
  fetcher: Fetcher = fetch,
): Promise<ChandlerAuthOutcome> {
  const { payload } = await postChandlerJson("/v1/auth/mfa/verify", { mfa_token: input.mfaToken, code: input.code }, fetcher);
  return parseAuthOutcome(payload);
}

/** ChandlerAuthErrorCode → HTTP 状态（API 路由层映射用）。 */
export function chandlerAuthStatus(code: ChandlerAuthErrorCode): number {
  switch (code) {
    case "email_taken": return 409;
    case "otp_cooldown":
    case "rate_limited": return 429;
    case "invalid_credentials":
    case "mfa_invalid_code": return 401;
    case "weak_password": return 422;
    case "user_disabled":
    case "turnstile_failed": return 403;
    case "otp_delivery_failed":
    case "unavailable": return 502;
    case "turnstile_unavailable": return 503;
    default: return 400;
  }
}

/** AuthResponse 的 user.id 即 OAuth userinfo 的 sub，两个入口共用同一账号身份。 */
export function chandlerProfileFromAuthUser(user: ChandlerAuthUser): SessionUser {
  return { sub: user.id, email: user.email, name: user.displayName, picture: user.avatar };
}

/**
 * Chandler 认证成功（OAuth 回调或密码注册/登录）后的统一会话落地面：
 * 写 CoDelphi 用户行 → 加密落库 Chandler 令牌（支付用；失败不阻断登录，可重新登录补齐）→ 下发会话 cookie。
 */
export async function establishCodelphiSession(profile: SessionUser, tokens: ChandlerTokens): Promise<void> {
  await upsertCodelphiUser(profile);
  try {
    const userId = await findUserIdBySub(profile.sub);
    if (userId !== null) await storeChandlerTokens(userId, tokens);
  } catch (error) {
    console.warn("[billing] chandler token store failed; payments may require re-login", error);
  }
  await createSession(profile);
}

import { turnstileSecret, turnstileSiteKey } from "./env";

/**
 * CoDelphi 自有的人机验证服务端校验（Chandler 信任合作伙伴模式，指南 v3.13 §2.2/2.3）：
 * 页面级真人验证由页面归属方自行负责——本应用用自己的 Turnstile widget
 * （TURNSTILE_SITE_KEY + TURNSTILE_SECRET 成对配置），token 在本应用路由内
 * siteverify 消费（单次有效），不再向 Chandler 透传。
 *
 * - 未配置/只配其一时视为未启用：页面不渲染 widget，路由不要求 token。
 *   只配 site key 会出现「前端渲染 widget、后端却校验不了」的割裂，按
 *   Chandler 同款配对规则视为未配置并告警。
 * - siteverify 不可达/响应异常时 fail-closed（拒绝而非放行）。
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 2048;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface TurnstileVerifyResult {
  ok: boolean;
  /** ok=false 时的错误码（AUTH_ERRORS 稳定键）。 */
  code?: "turnstile_failed" | "turnstile_unavailable";
}

let warnedHalfConfigured = false;

/** 页面人机验证是否启用：site key + secret 成对配置才启用。 */
export function turnstileEnforced(): boolean {
  const siteKey = turnstileSiteKey();
  const secret = turnstileSecret();
  if (Boolean(siteKey) !== Boolean(secret)) {
    if (!warnedHalfConfigured) {
      warnedHalfConfigured = true;
      console.warn("[turnstile] TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET 必须成对配置；只配其一时人机验证不启用");
    }
    return false;
  }
  return Boolean(siteKey) && Boolean(secret);
}

export async function verifyTurnstileToken(
  token: string,
  action: string,
  remoteIp?: string,
  fetcher: Fetcher = fetch,
): Promise<TurnstileVerifyResult> {
  const secret = turnstileSecret();
  if (!turnstileEnforced()) return { ok: true };
  if (!token || token.length > MAX_TOKEN_LENGTH) return { ok: false, code: "turnstile_failed" };

  let response: Response;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    response = await fetcher(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("[turnstile] siteverify unreachable, failing closed", error);
    return { ok: false, code: "turnstile_unavailable" };
  }
  if (!response.ok) {
    console.warn(`[turnstile] siteverify HTTP ${response.status}, failing closed`);
    return { ok: false, code: "turnstile_unavailable" };
  }
  const payload = (await response.json().catch(() => null)) as { success?: boolean; action?: string } | null;
  if (!payload?.success || payload.action !== action) {
    return { ok: false, code: "turnstile_failed" };
  }
  return { ok: true };
}

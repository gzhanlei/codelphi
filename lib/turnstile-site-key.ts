import { chandlerBaseUrl, turnstileSiteKey } from "./env";

/**
 * Turnstile site key 解析（Chandler 合作伙伴指南 v3.12 §2.2/2.3）：
 * - 优先读 `GET /v1/auth/capabilities` 的 `turnstile_site_key`——该字段只在 Chandler
 *   服务端强制人机验证时才返回，widget 展示与服务端强制天然配对（site key 换新自动跟随）；
 * - capabilities 不可达（网络/5xx）时回退本地 env `TURNSTILE_SITE_KEY`（不缓存，下次再试）；
 * - 返回空 = gate 关闭，页面不渲染 widget，token 也不要求。
 */

const CAPABILITIES_TTL_MS = 60_000;
const CAPABILITIES_TIMEOUT_MS = 5_000;

let cache: { key: string; at: number } | null = null;

export async function resolveTurnstileSiteKey(): Promise<string> {
  if (cache && Date.now() - cache.at < CAPABILITIES_TTL_MS) return cache.key;
  try {
    const response = await fetch(`${chandlerBaseUrl()}/v1/auth/capabilities`, {
      cache: "no-store",
      signal: AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS),
    });
    if (response.ok) {
      const payload = (await response.json().catch(() => null)) as { data?: { turnstile_site_key?: unknown }; turnstile_site_key?: unknown } | null;
      const raw = payload?.data?.turnstile_site_key ?? payload?.turnstile_site_key;
      const key = typeof raw === "string" ? raw.trim() : "";
      cache = { key, at: Date.now() };
      return key;
    }
  } catch {
    // 落到 env 兜底
  }
  return turnstileSiteKey();
}

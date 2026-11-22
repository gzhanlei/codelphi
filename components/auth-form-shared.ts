import { pick, type UiLocale } from "@/lib/ui-locale";
import { AUTH_ERRORS } from "@/lib/ui-strings/dashboard";

/** 自建注册/登录表单共用件：API 错误码 → 界面文案，及统一的 POST 小封装。 */

export function authErrorText(code: unknown, locale: UiLocale): string {
  const entry = typeof code === "string" && AUTH_ERRORS[code] ? AUTH_ERRORS[code] : AUTH_ERRORS.unavailable;
  return pick(locale, entry);
}

export interface AuthApiResponse {
  status: number;
  data: Record<string, unknown>;
}

export async function postAuth(path: string, body: unknown): Promise<AuthApiResponse> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, data };
  } catch {
    return { status: 0, data: {} };
  }
}

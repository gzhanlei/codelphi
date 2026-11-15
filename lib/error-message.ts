import { ERROR_MESSAGES } from "./ui-strings/errors";

export function errorMessage(error: unknown, fallback: string, locale: "zh-CN" | "en" = "zh-CN") {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string" && code in ERROR_MESSAGES) return ERROR_MESSAGES[code as keyof typeof ERROR_MESSAGES][locale];
  return error instanceof Error ? error.message : fallback;
}

/**
 * Wave 4e：客户端按响应体 code 映射界面语言文案（高频通用错误），未覆盖的业务
 * 错误回退原始 message（中文），无响应体回退调用方缺省文案。locale 缺省 zh-CN
 * 保持既有行为。
 */
export function errorMessageFromData(data: unknown, fallback: string, locale: "zh-CN" | "en" = "zh-CN"): string {
  if (typeof data !== "object" || data === null) return fallback;
  const body = data as { code?: unknown; error?: unknown };
  if (typeof body.code === "string" && body.code in ERROR_MESSAGES) {
    return ERROR_MESSAGES[body.code as keyof typeof ERROR_MESSAGES][locale];
  }
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

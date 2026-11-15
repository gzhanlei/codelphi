/**
 * Wave 4e：API 错误码化（渐进式）。高频通用错误带 code 字段（中文 error 文本保持
 * 兼容），客户端按 code 查本字典取界面语言文案；未覆盖的业务错误回退原文。
 * OAuth 端点（/.well-known、/api/mcp）已用 RFC 风格英文码，不在此表。
 * 错误码即稳定键：新增码必须同时补双语消息。
 */

export const ERROR_CODES = [
  "product_not_found",
  "product_forbidden",
  "product_edit_forbidden",
  "unauthorized",
  "invalid_params",
  "release_not_found",
  "note_not_found",
  "workspace_member_only",
  "not_published_readonly",
  "feature_not_found",
  "channel_not_found",
  "slug_conflict",
  "demo_not_open",
] as const;

export type ApiErrorCode = (typeof ERROR_CODES)[number];

import { ERROR_MESSAGES } from "./ui-strings/errors";

export { ERROR_MESSAGES };
export function apiErrorBody(code: ApiErrorCode, zhOverride?: string): { error: string; code: ApiErrorCode } {
  return { error: zhOverride ?? ERROR_MESSAGES[code]["zh-CN"], code };
}

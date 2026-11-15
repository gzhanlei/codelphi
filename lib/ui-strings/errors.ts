import type { LocaleEntry } from "../ui-locale";

/**
 * Wave 4e：API 错误码的双语消息表（错误码稳定键 = lib/api-errors.ts 的 ERROR_CODES）。
 * 客户端 lib/error-message.ts 按响应体 code 查此表；未覆盖的业务错误回退原文。
 */
export const ERROR_MESSAGES: Record<string, LocaleEntry> = {
  product_not_found: { "zh-CN": "产品不存在或不属于当前工作区", en: "The product does not exist in this workspace" },
  product_forbidden: { "zh-CN": "产品不存在或无访问权限", en: "The product does not exist or you have no access" },
  product_edit_forbidden: { "zh-CN": "产品不存在或无编辑权限", en: "The product does not exist or you have no edit permission" },
  unauthorized: { "zh-CN": "未登录", en: "Not signed in" },
  invalid_params: { "zh-CN": "参数无效", en: "Invalid parameters" },
  release_not_found: { "zh-CN": "发布不存在", en: "The release does not exist" },
  note_not_found: { "zh-CN": "发布稿不存在", en: "The release notes do not exist" },
  workspace_member_only: { "zh-CN": "只有工作区成员可以修改此设置", en: "Only workspace members can change this setting" },
  not_published_readonly: { "zh-CN": "已发布只读：先下线才能改", en: "Published notes are read-only: unpublish first" },
  feature_not_found: { "zh-CN": "功能不存在", en: "The feature does not exist" },
  channel_not_found: { "zh-CN": "通知渠道不存在", en: "The notification channel does not exist" },
  slug_conflict: { "zh-CN": "该 Slug 已被同工作区其他产品使用", en: "This slug is already used by another product in the workspace" },
  demo_not_open: { "zh-CN": "产品不存在或未开放", en: "The product does not exist or is not public" },
};

import type { LocaleEntry } from "./ui-locale";

/**
 * 界面文案字典（Wave 3 起）：按域导出 Record<UiLocale, string> 条目，
 * 与 lib/*-view.ts 的标签映射同构——纯函数取值，renderToStaticMarkup 测试零破坏。
 * 页面文案在 Wave 4 按域逐步迁入；API 错误消息走错误码映射（Wave 4e），不入此表。
 */

/** 主导航/公开导航（app-shell.tsx / public-shell.tsx 共用键）。 */
export const NAV_LABELS = {
  overview: { "zh-CN": "产品总览", en: "Products" },
  organizations: { "zh-CN": "我的工作区", en: "Workspaces" },
  adminFeedback: { "zh-CN": "反馈管理", en: "Feedback" },
  adminPay: { "zh-CN": "支付管理", en: "Payments" },
  adminCosts: { "zh-CN": "成本观测", en: "Costs" },
  integrations: { "zh-CN": "代码仓库", en: "Repositories" },
  mcp: { "zh-CN": "MCP", en: "MCP" },
  settings: { "zh-CN": "设置", en: "Settings" },
  pricing: { "zh-CN": "套餐与定价", en: "Pricing" },
  terms: { "zh-CN": "服务条款", en: "Terms" },
  dataNotice: { "zh-CN": "数据说明", en: "Data notice" },
  chandler: { "zh-CN": "Chandler", en: "Chandler" },
} satisfies Record<string, LocaleEntry>;

/** 壳层 chrome 文案（顶栏/侧栏/切换器）。 */
export const COMMON_LABELS = {
  logout: { "zh-CN": "退出", en: "Sign out" },
  login: { "zh-CN": "登录 / 注册", en: "Sign in / Sign up" },
  workspaceFallback: { "zh-CN": "工作区", en: "Workspace" },
  mainNavAria: { "zh-CN": "主导航", en: "Main navigation" },
  siteNavAria: { "zh-CN": "站点导航", en: "Site navigation" },
  brandAria: { "zh-CN": "CoDelphi 首页", en: "CoDelphi home" },
  languageAria: { "zh-CN": "界面语言", en: "Interface language" },
  demoBadge: { "zh-CN": "演示模式", en: "Demo mode" },
  demoNote: { "zh-CN": "只读演示，编辑不可保存", en: "Read-only demo; edits are not saved" },
  chandlerSignIn: { "zh-CN": "使用 Chandler 登录", en: "Sign in with Chandler" },
} satisfies Record<string, LocaleEntry>;

export const BRAND_TAGLINE: LocaleEntry = { "zh-CN": "产品变化雷达", en: "Product change radar" };

export const SIDEBAR_NOTE: LocaleEntry = {
  "zh-CN": "CODE → CONTEXT\n让每一次发布都有据可查",
  en: "CODE → CONTEXT\nEvery release, backed by evidence",
};

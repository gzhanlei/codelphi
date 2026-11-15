import type { LocaleEntry } from "../ui-locale";

/**
 * Wave 4d 域字典：admin 后台（支付/反馈/成本）与 share 公开页 chrome。
 * share 页语言 = 产品分析输出语言（renderChangelogDocument 的 language 参数）；
 * MCP 工具说明与 agent 指令段是 agent 面契约文本，保持中文原文不进字典。
 */

// ── admin/feedback ──
export const ADMIN_FEEDBACK = {
  heading: { "zh-CN": "分析失败反馈", en: "Analysis failure reports" },
  subheading: { "zh-CN": "自动收集的诊断信息，可一键转为 CoDelphi GitHub Issue。", en: "Automatically collected diagnostics, one click away from a CoDelphi GitHub issue." },
  empty: { "zh-CN": "暂无反馈。", en: "No reports yet." },
  tableProduct: { "zh-CN": "产品 / 仓库", en: "Product / repository" },
  tableWorkspace: { "zh-CN": "工作区", en: "Workspace" },
  tableSource: { "zh-CN": "来源", en: "Source" },
  tableRevision: { "zh-CN": "Revision", en: "Revision" },
  tableError: { "zh-CN": "错误", en: "Error" },
  tableStatus: { "zh-CN": "状态", en: "Status" },
  tableActions: { "zh-CN": "操作", en: "Actions" },
  systemSource: { "zh-CN": "系统自动记录", en: "Recorded automatically" },
  statusSubmitted: { "zh-CN": "已提交", en: "Submitted" },
  statusFailed: { "zh-CN": "提交失败", en: "Submission failed" },
  statusPending: { "zh-CN": "待处理", en: "Pending" },
} satisfies Record<string, LocaleEntry>;

// ── admin/pay ──
export const ADMIN_PAY = {
  heading: { "zh-CN": "支付管理", en: "Payments" },
  subheading: {
    "zh-CN": "0.01 元联调测试单、订单台账与管理员退款（超时停 refund_submitted，由对账自动推进确认）。",
    en: "¥0.01 integration test orders, the order ledger and admin refunds (timeout stops at refund_submitted; reconciliation advances confirmation automatically).",
  },
} satisfies Record<string, LocaleEntry>;

// ── admin/costs ──
export const ADMIN_COSTS = {
  heading: { "zh-CN": "成本观测", en: "Costs" },
  subheading: { "zh-CN": "LLM 调用成本与分析产出的观测面板。", en: "Observability for LLM call costs and analysis output." },
  body: {
    "zh-CN": "最近 {days} 天的 LLM 调用实际成本（llm_call_receipts 汇总）。成本 NULL = 单价未配置，按 0 计入行并单独披露调用数——未定价 ≠ 零成本。",
    en: "Actual LLM call costs over the last {days} days (aggregated from llm_call_receipts). A NULL cost means the unit price is not configured: the row counts as 0 and the call count is disclosed separately — unpriced is not zero-cost.",
  },
} satisfies Record<string, LocaleEntry>;

// ── share changelog 公开页 chrome ──
export const SHARE_CHANGELOG = {
  back: { "zh-CN": "← 返回", en: "← Back" },
  title: { "zh-CN": " 变更日志", en: " changelog" },
  source: { "zh-CN": "来源 · ", en: "Source · " },
  sourceLink: { "zh-CN": "源码 ↗", en: "source ↗" },
  allChanges: { "zh-CN": "全部变化（按功能）", en: "All changes (by feature)" },
  specLink: { "zh-CN": "规格 ↗", en: "spec ↗" },
  involvedCode: { "zh-CN": "涉及代码：", en: "Code involved: " },
  footer: {
    "zh-CN": "每条变化由 CoDelphi 从代码行为中提取并附源码依据，经人工审核后发布。",
    en: "Every entry is extracted by CoDelphi from code behavior with source evidence and published after human review.",
  },
  footerSpec: { "zh-CN": "完整功能规格见", en: "The full feature spec is on the " },
  footerSpecLink: { "zh-CN": "产品页", en: "product page" },
  footerSpecTail: { "zh-CN": "。", en: "." },
  // 变化分节标签（featureCopy 存储值为中文规范值，展示按页面语言映射）
  sectionAdded: { "zh-CN": "新增", en: "Added" },
  sectionImproved: { "zh-CN": "改进", en: "Improved" },
  sectionFixed: { "zh-CN": "修复", en: "Fixed" },
  sectionRemoved: { "zh-CN": "移除", en: "Removed" },
} satisfies Record<string, LocaleEntry>;

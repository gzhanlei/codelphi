import type { LocaleEntry } from "../ui-locale";

/**
 * Wave 4c 域字典：工作区设置/定价/集成/邀请接受页。
 * 页面经 resolveUiLocale() 取 locale 后用 pick() 取值；客户端组件经 props 接收 locale（缺省 zh-CN）。
 * API 错误消息与 errorMessage 回退保持中文原样（走 API 通道，Wave 4e 统一迁移），不入此表。
 */

// ── 设置页框架（app/settings/page.tsx） ──
export const SETTINGS_PAGE = {
  heading: { "zh-CN": "设置", en: "Settings" },
  headingBody: {
    "zh-CN": "套餐额度、分析触发与订单记录的统一入口；各产品的成员、通知等设置在对应产品页内。",
    en: "One place for plan quota, analysis triggers and order history; per-product members, notifications and more live on each product's page.",
  },
  holdBanner: {
    "zh-CN": "账户正在对账冻结：暂时无法发起新分析；已有预留与分析结果不受影响，完成后自动解除。",
    en: "The account is frozen for reconciliation: new analyses cannot start for now; existing reservations and analysis results are unaffected and the freeze lifts automatically once it completes.",
  },
  planHeading: { "zh-CN": "套餐与额度", en: "Plan and quota" },
  statAvailable: { "zh-CN": "可用额度", en: "Available quota" },
  statAvailableUnit: { "zh-CN": "SAU · 当前周期", en: "SAU · current period" },
  statReserved: { "zh-CN": "预留中", en: "Reserved" },
  statReservedUnit: { "zh-CN": "在途分析占用", en: "held by running analyses" },
  statPlanStatus: { "zh-CN": "套餐状态", en: "Plan status" },
  statusTrialing: { "zh-CN": "试用中（累计额度，不按周期重置）", en: "Trialing (cumulative quota; never resets per period)" },
  statusActive: { "zh-CN": "生效中", en: "Active" },
  statusGrace: { "zh-CN": "宽限期（只读）", en: "Grace period (read-only)" },
  statusExpired: { "zh-CN": "已到期", en: "Expired" },
  statusUnknown: { "zh-CN": "试用中", en: "Trialing" },
  trialNote: {
    "zh-CN": "试用额度累计发放、不按周期重置；升级付费后剩余试用额度保留并优先消耗。",
    en: "Trial quota accumulates and never resets per period; after upgrading, the remaining trial quota is kept and consumed first.",
  },
  periodPrefix: { "zh-CN": "当前计费周期：", en: "Current billing period: " },
  periodSeparator: { "zh-CN": " → ", en: " → " },
  periodResetPrefix: { "zh-CN": "；下次额度重置：", en: "; next quota reset: " },
  gracePrefix: { "zh-CN": "宽限期至 ", en: "Grace period until " },
  graceSuffix: { "zh-CN": "：期间无法发起新分析，续费立即恢复。", en: ": new analyses cannot start during this time; renew to restore immediately." },
  exceptionPrefix: { "zh-CN": "结算异常待人工确认：", en: "Settlement exceptions awaiting manual review: " },
  exceptionSuffix: { "zh-CN": " 条。", en: "." },
  failedReleasedPrefix: { "zh-CN": "失败的分析不扣额度（累计释放 ", en: "Failed analyses are not charged (" },
  failedReleasedSuffix: { "zh-CN": " 次）。", en: " releases refunded in total)." },
  upgradeLink: { "zh-CN": "升级 / 续费 / 购买超额包 →", en: "Upgrade / renew / buy overage packs →" },
  productsHeading: { "zh-CN": "各产品分析设置", en: "Per-product analysis settings" },
  productsNote: {
    "zh-CN": "触发模式、通知渠道、成员权限等设置在每个产品的「设置」页内管理；额度不足被跳过的自动推送，可在产品页用「补分析最新提交」恢复同步。",
    en: "Trigger modes, notification channels and member permissions are managed on each product's Settings page; automatic pushes skipped for insufficient quota can catch up via \"Analyze latest commit\" on the product page.",
  },
  productSettingsSuffix: { "zh-CN": " · 设置 →", en: " · Settings →" },
  skippedPrefix: { "zh-CN": "自动分析跳过 ", en: "Automatic analysis skipped " },
  skippedMiddle: { "zh-CN": " 次（最近 ", en: " times (most recent " },
  skippedSuffix: { "zh-CN": "）——恢复同步请到产品页「补分析最新提交」", en: ") — resume syncing via \"Analyze latest commit\" on the product page" },
  noSkipped: { "zh-CN": "无被跳过的自动分析", en: "No skipped automatic analyses" },
  noProducts: { "zh-CN": "尚未接入产品。", en: "No products connected yet." },
  walletHeading: { "zh-CN": "额度钱包", en: "Quota wallets" },
  walletType: { "zh-CN": "类型", en: "Type" },
  walletStatus: { "zh-CN": "状态", en: "Status" },
  walletRemaining: { "zh-CN": "剩余", en: "Remaining" },
  walletReserved: { "zh-CN": "预留中", en: "Reserved" },
  walletExpires: { "zh-CN": "到期", en: "Expires" },
  walletTrial: { "zh-CN": "试用额度", en: "Trial quota" },
  walletPlan: { "zh-CN": "套餐额度", en: "Plan quota" },
  walletGift: { "zh-CN": "活动赠送", en: "Campaign gift" },
  walletPack: { "zh-CN": "超额包", en: "Overage pack" },
  noWallets: { "zh-CN": "尚无额度钱包。", en: "No quota wallets yet." },
  ordersHeading: { "zh-CN": "最近订单", en: "Recent orders" },
  orderNo: { "zh-CN": "单号", en: "Order" },
  orderKind: { "zh-CN": "类型", en: "Kind" },
  orderStatus: { "zh-CN": "状态", en: "Status" },
  orderRefund: { "zh-CN": "退款", en: "Refund" },
  orderAmount: { "zh-CN": "金额", en: "Amount" },
  orderCreated: { "zh-CN": "创建", en: "Created" },
  noOrders: { "zh-CN": "暂无订单。", en: "No orders yet." },
} satisfies Record<string, LocaleEntry>;

// ── 触发模式（工作区默认 + 仓库级两个面板共用） ──
export const TRIGGER_MODES = {
  push: { "zh-CN": "每次 push（实时）", en: "Every push (real-time)" },
  daily: { "zh-CN": "每天低峰期一次", en: "Once daily, off-peak" },
  pushCount: { "zh-CN": "每 N 次 push + 当天兜底", en: "Every N pushes + daily catch-up" },
  pushHint: { "zh-CN": "每次推送到主分支都立即分析，消耗 ≈ push 次数 SAU", en: "Every push to the main branch is analyzed immediately, consuming ≈ one SAU per push" },
  dailyHint: { "zh-CN": "每天在设定小时至多分析一次（当天有推送才分析），消耗 ≤31 SAU/月", en: "Analyzes at most once per day at the chosen hour (only if pushes happened that day), ≤31 SAU/month" },
  pushCountHint: { "zh-CN": "每 N 次推送分析一次，并在每天设定小时对当天剩余推送兜底一次；消耗 ≤31 SAU/月，通常更少", en: "Analyzes every N pushes, with a daily catch-up at the chosen hour for the rest of that day; ≤31 SAU/month, usually less" },
  countLabel: { "zh-CN": "每 N 次推送", en: "Push count threshold (N)" },
  hourLabel: { "zh-CN": "低峰分析时间（服务器时区）", en: "Off-peak analysis hour (server time zone)" },
  pushCountUnit: { "zh-CN": " 次", en: " pushes" },
} satisfies Record<string, LocaleEntry>;

// ── 工作区默认触发模式面板 ──
export const WORKSPACE_TRIGGER = {
  heading: { "zh-CN": "新仓库默认触发模式", en: "Default trigger mode for new repositories" },
  note: {
    "zh-CN": "此后新接入的仓库将继承此设置；已有仓库在各产品的「设置 → 分析触发模式」里单独管理，不受影响。",
    en: "Newly connected repositories inherit this setting; existing repositories keep their own per-product \"Settings → Analysis trigger mode\" configuration.",
  },
  countAria: { "zh-CN": "新仓库推送次数阈值", en: "Push count threshold for new repositories" },
  hourAria: { "zh-CN": "新仓库低峰分析时间", en: "Off-peak analysis hour for new repositories" },
  savedNotice: { "zh-CN": "默认触发设置已保存：此后新接入的仓库将继承此模式", en: "Default trigger saved: newly connected repositories will inherit this mode" },
} satisfies Record<string, LocaleEntry>;

// ── 工作区默认输出语言面板 ──
export const WORKSPACE_OUTPUT_LANGUAGE = {
  heading: { "zh-CN": "新仓库默认输出语言", en: "Default output language for new repositories" },
  note: {
    "zh-CN": "此后新接入的产品将继承此设置：AI 提取的功能规格、场景与发布稿按所选语言生成；已有产品在各产品的「设置」里单独管理，不受影响。",
    en: "Newly connected products inherit this setting: AI-extracted feature specs, scenarios and release notes are generated in the chosen language; existing products keep their own per-product Settings configuration.",
  },
  savedNotice: { "zh-CN": "默认输出语言已保存：此后新接入的产品将继承此语言", en: "Default output language saved: newly connected products will inherit it" },
} satisfies Record<string, LocaleEntry>;

/** 面板提示（与 lib/analysis-language 的 OUTPUT_LANGUAGE_HINTS 中文逐字一致；语言名保持自名，不走此表）。 */
export const OUTPUT_LANGUAGE_PANEL_HINTS: Record<string, LocaleEntry> = {
  "zh-CN": { "zh-CN": "功能规格、场景与发布稿将以简体中文生成", en: "Feature specs, scenarios and release notes will be generated in Simplified Chinese" },
  en: { "zh-CN": "Feature specs, scenarios and release notes will be generated in English", en: "Feature specs, scenarios and release notes will be generated in English" },
};

// ── MCP 集成面板 ──
export const MCP_KEYS = {
  heading: { "zh-CN": "MCP 集成", en: "MCP integration" },
  intro: {
    "zh-CN": "组织级只读 API key，供 Claude / ChatGPT 等 AI 客户端经 MCP 读取产品规格与行为变化（每条结论附证据链接）。撤销后立即失效。",
    en: "Organization-level read-only API keys let AI clients such as Claude / ChatGPT read product specs and behavior changes over MCP (every claim carries an evidence link). Revocation takes effect immediately.",
  },
  endpointLabel: { "zh-CN": "MCP 端点（Streamable HTTP，Authorization: Bearer <key>）：", en: "MCP endpoint (Streamable HTTP, Authorization: Bearer <key>):" },
  configFresh: { "zh-CN": "连接配置（已写入刚签发的 key，复制即用）", en: "Connection config (freshly issued key baked in; copy and use)" },
  configPlaceholder: { "zh-CN": "连接配置（签发 key 后自动写入真实值）", en: "Connection config (the real key is baked in once you issue one)" },
  claudeGuidePrefix: { "zh-CN": "Claude Code：存为项目根目录 ", en: "Claude Code: save as " },
  claudeGuideMiddle: { "zh-CN": "，或执行 ", en: " at the project root, or run " },
  zcodeGuidePrefix: { "zh-CN": "ZCode：", en: "ZCode: " },
  zcodeGuideMiddle: { "zh-CN": " 的 ", en: " under " },
  zcodeGuideMiddle2: { "zh-CN": "（服务器对象同形状；团队共享可放仓库 ", en: " (same shape for server objects; for team sharing put it in the repo's " },
  zcodeGuideSuffix: { "zh-CN": "）", en: ")" },
  cursorGuidePrefix: { "zh-CN": "Cursor：", en: "Cursor: " },
  cursorGuideSuffix: { "zh-CN": "（同样的 mcpServers 形状）", en: " (same mcpServers shape)" },
  connectorGuidePrefix: {
    "zh-CN": "ChatGPT / Claude 网页版连接器：选择 OAuth 连接，会自动发现本站授权页；详见 ",
    en: "ChatGPT / Claude web connectors: pick the OAuth connection and this site's authorization page is discovered automatically; see the ",
  },
  guideLink: { "zh-CN": "MCP 连接指南", en: "MCP connection guide" },
  verifyGuide: {
    "zh-CN": "接入验证：在 agent 里问「列出我的 CoDelphi 产品」，应触发 list_projects 返回本工作区产品",
    en: "Verification: ask your agent to \"list my CoDelphi products\"; it should call list_projects and return this workspace's products",
  },
  namePlaceholder: { "zh-CN": "key 名称（如：ChatGPT / Claude）", en: "Key name (e.g. ChatGPT / Claude)" },
  nameAria: { "zh-CN": "key 名称", en: "Key name" },
  issueButton: { "zh-CN": "签发 key", en: "Issue key" },
  issuedNotice: { "zh-CN": "key 已签发，明文只显示这一次，请立即保存", en: "Key issued; the plaintext is shown only this once — save it now" },
  revokedNotice: { "zh-CN": "key 已撤销，使用该 key 的连接将立即失效", en: "Key revoked; connections using it stop working immediately" },
  noKeys: { "zh-CN": "尚无 key。", en: "No keys yet." },
  createdByPrefix: { "zh-CN": "由 ", en: "Created by " },
  createdByMiddle: { "zh-CN": " 创建于 ", en: " on " },
  revokedPrefix: { "zh-CN": "已撤销 ", en: "Revoked " },
  activeStatus: { "zh-CN": "生效中", en: "Active" },
  revokeButton: { "zh-CN": "撤销", en: "Revoke" },
} satisfies Record<string, LocaleEntry>;

// ── 产品标识面板 ──
export const PRODUCT_IDENTITY = {
  heading: { "zh-CN": "产品标识", en: "Product identity" },
  note: {
    "zh-CN": "名称展示在导航与通知里；slug 决定访问地址，修改后旧链接会自动重定向。",
    en: "The name appears in navigation and notifications; the slug decides the URL and old links redirect automatically after a change.",
  },
  nameLabel: { "zh-CN": "产品名称", en: "Product name" },
  slugAria: { "zh-CN": "产品 Slug", en: "Product slug" },
  nameRequired: { "zh-CN": "请输入产品名称", en: "Please enter a product name" },
  savedNotice: { "zh-CN": "产品信息已保存", en: "Product information saved" },
} satisfies Record<string, LocaleEntry>;

// ── 公开演示面板 ──
export const PUBLIC_DEMO = {
  heading: { "zh-CN": "公开演示", en: "Public demo" },
  note: {
    "zh-CN": "把产品作为公开 demo 分享：无需登录即可查看规格、发布与变化，所有编辑操作只作演示不保存。",
    en: "Share the product as a public demo: specs, releases and changes are viewable without signing in, and all edits are demo-only and never saved.",
  },
  on: { "zh-CN": "公开中", en: "Public" },
  off: { "zh-CN": "未公开", en: "Not public" },
  onBody: { "zh-CN": "任何人都可以匿名访问此产品页面。", en: "Anyone can visit this product page anonymously." },
  offBody: { "zh-CN": "只有登录的工作区成员可以访问。", en: "Only signed-in workspace members can access it." },
  disableButton: { "zh-CN": "点击关闭", en: "Click to turn off" },
  enableButton: { "zh-CN": "点击开启", en: "Click to turn on" },
  warning: { "zh-CN": "⚠️ 开启期间，产品全部内容对公网可见，请确认不包含敏感信息。", en: "⚠️ While enabled, all product content is visible on the public internet; make sure it contains nothing sensitive." },
} satisfies Record<string, LocaleEntry>;

// ── 产品成员管理面板 ──
export const PRODUCT_MEMBERS = {
  roleOwner: { "zh-CN": "所有者", en: "Owner" },
  roleEditor: { "zh-CN": "编辑者", en: "Editor" },
  roleViewer: { "zh-CN": "查看者", en: "Viewer" },
  removeButton: { "zh-CN": "移除", en: "Remove" },
  removedNotice: { "zh-CN": "成员已移除", en: "Member removed" },
  heading: { "zh-CN": "成员管理", en: "Members" },
  note: {
    "zh-CN": "工作区成员天然可以访问本产品；产品级成员仅限被单独邀请的人。",
    en: "Workspace members can access this product by default; product-level members are limited to people invited individually.",
  },
  orgMembersPrefix: { "zh-CN": "工作区成员（", en: "Workspace members (" },
  productMembersPrefix: { "zh-CN": "产品级成员（", en: "Product-level members (" },
  pendingPrefix: { "zh-CN": "待接受的邀请（", en: "Pending invitations (" },
  countSuffix: { "zh-CN": "）", en: ")" },
  noneProduct: { "zh-CN": "暂无产品级成员。", en: "No product-level members yet." },
  cancelButton: { "zh-CN": "取消", en: "Cancel" },
  cancelledNotice: { "zh-CN": "邀请已取消", en: "Invitation cancelled" },
  emailRequired: { "zh-CN": "请输入邮箱", en: "Please enter an email" },
  memberAddedNotice: { "zh-CN": "成员已加入。", en: "The member has joined." },
  invitedPrefix: { "zh-CN": "邀请已创建：", en: "Invitation created: " },
  invitedEmailSent: { "zh-CN": "（Chandler 注册邮件已发送）", en: " (a Chandler registration email has been sent)" },
  invitedEmailFallback: { "zh-CN": "（请复制链接发送给对方）", en: " (copy the link and share it)" },
  emailAria: { "zh-CN": "邮箱", en: "Email" },
  roleAria: { "zh-CN": "角色", en: "Role" },
  inviteButton: { "zh-CN": "邀请成员", en: "Invite member" },
  inviting: { "zh-CN": "邀请中…", en: "Inviting…" },
} satisfies Record<string, LocaleEntry>;

// ── 通知分发面板 ──
export const NOTIFICATIONS = {
  kindWebhook: { "zh-CN": "通用 Webhook", en: "Generic webhook" },
  heading: { "zh-CN": "通知分发", en: "Notifications" },
  note: {
    "zh-CN": "分析发现规格行为变化时，把变化摘要推送到团队日常动线；无变化则保持静默。",
    en: "When an analysis finds spec behavior changes, a change digest is pushed into the team's daily flow; silence means no changes.",
  },
  emailSelf: { "zh-CN": "给我自己发行为变化摘要（发送到登录邮箱）", en: "Send myself behavior-change digests (to the sign-in email)" },
  emailOnButton: { "zh-CN": "已开启，点击关闭", en: "On — click to turn off" },
  emailOffButton: { "zh-CN": "已关闭，点击开启", en: "Off — click to turn on" },
  emailOffNotice: { "zh-CN": "邮件通知已关闭", en: "Email notifications turned off" },
  emailOnNotice: { "zh-CN": "邮件通知已开启", en: "Email notifications turned on" },
  weeklyNote: {
    "zh-CN": "每周还有一封周期行为摘要（滚动 7 天，无变化不发）。",
    en: "A weekly behavior digest also goes out (rolling 7 days; skipped when nothing changed).",
  },
  latestDigestLink: { "zh-CN": "查看最近一期 ↗", en: "Open the latest issue ↗" },
  testButton: { "zh-CN": "测试", en: "Test" },
  testNotice: { "zh-CN": "测试消息已发送", en: "Test message sent" },
  disableButton: { "zh-CN": "停用", en: "Disable" },
  enableButton: { "zh-CN": "启用", en: "Enable" },
  disabledNotice: { "zh-CN": "渠道已停用", en: "Channel disabled" },
  enabledNotice: { "zh-CN": "渠道已启用", en: "Channel enabled" },
  deleteButton: { "zh-CN": "删除", en: "Delete" },
  deletedNotice: { "zh-CN": "渠道已删除", en: "Channel deleted" },
  noneConfigured: { "zh-CN": "尚未配置通知渠道。", en: "No notification channels configured yet." },
  kindAria: { "zh-CN": "渠道类型", en: "Channel type" },
  targetAria: { "zh-CN": "Webhook 地址", en: "Webhook URL" },
  saveButton: { "zh-CN": "保存渠道", en: "Save channel" },
  processing: { "zh-CN": "处理中…", en: "Working…" },
  savedNotice: { "zh-CN": "通知渠道已保存", en: "Notification channel saved" },
} satisfies Record<string, LocaleEntry>;

// ── 仓库分析触发模式面板 ──
export const REPO_TRIGGER = {
  heading: { "zh-CN": "分析触发模式", en: "Analysis trigger mode" },
  note: {
    "zh-CN": "控制每次推送到主分支后何时开始分析。分析频率越高，每月消耗的分析单元越多；高频仓库建议切换到每天低峰期或每 N 次推送。",
    en: "Controls when analysis starts after each push to the main branch. More frequent analyses consume more analysis units per month; high-frequency repositories should switch to daily off-peak or every-N-pushes.",
  },
  modeAriaPrefix: { "zh-CN": "分析触发模式 ", en: "Analysis trigger mode " },
  countAriaPrefix: { "zh-CN": "推送次数阈值 ", en: "Push count threshold " },
  hourAriaPrefix: { "zh-CN": "低峰分析时间 ", en: "Off-peak analysis hour " },
  pendingPushesPrefix: { "zh-CN": "（当前有 ", en: " (" },
  pendingPushesMiddle: { "zh-CN": " 次推送等待下次分析）", en: " pushes awaiting the next analysis)" },
  savedNotice: { "zh-CN": "分析触发设置已保存", en: "Analysis trigger settings saved" },
} satisfies Record<string, LocaleEntry>;

// ── 通用按钮（设置面板共用） ──
export const SETTINGS_COMMON = {
  save: { "zh-CN": "保存", en: "Save" },
  saving: { "zh-CN": "保存中…", en: "Saving…" },
  copy: { "zh-CN": "复制", en: "Copy" },
  copied: { "zh-CN": "已复制", en: "Copied" },
  copyConfig: { "zh-CN": "复制配置", en: "Copy config" },
} satisfies Record<string, LocaleEntry>;

// ── 定价页 ──
export const PRICING_PAGE = {
  title: { "zh-CN": "套餐与定价", en: "Plans and pricing" },
  headingBody: {
    "zh-CN": "月费提供确定额度，超量按 SAU 计费；失败的分析不扣额度，消费封顶可配。",
    en: "The monthly fee includes a fixed quota and overage is billed in SAU; failed analyses are not charged and spend caps are configurable.",
  },
  calibrationNote: {
    "zh-CN": "价格与配额以实测成本校准后公布（当前为占位展示，不构成价格承诺）；退款、发票条款以正式服务条款为准。",
    en: "Prices and quotas will be published after calibration against measured costs (currently a placeholder and not a price commitment); refunds and invoicing follow the formal terms of service.",
  },
  termsLink: { "zh-CN": "服务条款与数据处理 →", en: "Terms of service and data handling →" },
  backToOverview: { "zh-CN": "← 返回产品总览", en: "← Back to products" },
} satisfies Record<string, LocaleEntry>;

// ── 套餐购买面板 ──
export const PRICING_PANEL = {
  loading: { "zh-CN": "加载中…", en: "Loading…" },
  calibratingHeading: { "zh-CN": "定价校准中", en: "Pricing being calibrated" },
  calibratingBody: {
    "zh-CN": "套餐价格与配额正在按实测用量校准，暂不开放购买。已注册账户保留试用额度。",
    en: "Plan prices and quotas are being calibrated against measured usage; purchasing is not open yet. Registered accounts keep their trial quota.",
  },
  priceMonthUnit: { "zh-CN": " 个月", en: " months" },
  monthlyIncludePrefix: { "zh-CN": "每月包含 ", en: "Includes " },
  monthlyIncludeSuffix: { "zh-CN": " SAU 标准分析额度", en: " SAU of standard analysis quota per month" },
  planPromise: { "zh-CN": "失败不扣额度 · 消费封顶可配 · 规格历史永久保留", en: "Failures are not charged · spend caps configurable · spec history kept forever" },
  subscribeButton: { "zh-CN": "订阅", en: "Subscribe" },
  packHeadingPrefix: { "zh-CN": "超额包 ", en: "Overage pack " },
  packExtraPrefix: { "zh-CN": "额外 ", en: "An extra " },
  packExtraSuffix: { "zh-CN": " SAU（12 个月有效）", en: " SAU (valid for 12 months)" },
  buyButton: { "zh-CN": "购买", en: "Buy" },
  ordering: { "zh-CN": "下单中…", en: "Placing order…" },
  pendingOrderPrefix: { "zh-CN": "待支付订单 ", en: "Pending order " },
  qrAlt: { "zh-CN": "微信支付二维码", en: "WeChat Pay QR code" },
  wechatScan: { "zh-CN": "微信扫码：请打开微信「扫一扫」支付", en: "WeChat scan: open WeChat's \"Scan\" to pay" },
  wechatH5Link: { "zh-CN": "打开微信 H5 收银台支付 →", en: "Open the WeChat H5 cashier to pay →" },
  pollingNote: { "zh-CN": "支付完成后本页自动更新（轮询中…）。", en: "This page updates automatically once payment completes (polling…)." },
  paidNotice: { "zh-CN": "支付成功，额度已到账。可在「设置」页查看余额。", en: "Payment succeeded and the quota has landed. Check the balance on the Settings page." },
  statusPrefix: { "zh-CN": "订单状态：", en: "Order status: " },
  statusSuffix: { "zh-CN": "。如长时间未更新请刷新或联系支持。", en: ". If it does not update for a long time, refresh or contact support." },
} satisfies Record<string, LocaleEntry>;

// ── 集成页 ──
export const INTEGRATIONS_PAGE = {
  heading: { "zh-CN": "代码仓库连接", en: "Repository connections" },
  headingBody: {
    "zh-CN": "连接 GitHub、Gitee 或自有 Git 服务。按最小权限授权，访问令牌仅保存在服务端加密存储中。",
    en: "Connect GitHub, Gitee or your own Git service. Authorize with least privilege; access tokens are stored only in server-side encrypted storage.",
  },
  messageManifestState: { "zh-CN": "GitHub App 创建状态已失效，请重新发起。", en: "The GitHub App creation state has expired; please start again." },
  messageConversionFailed: { "zh-CN": "无法转换 GitHub App 凭据，请重试。", en: "Could not convert the GitHub App credentials; please retry." },
  messageAppMissing: { "zh-CN": "尚未创建 GitHub App。", en: "No GitHub App has been created yet." },
  messageInstallationId: { "zh-CN": "GitHub 返回的 Installation ID 无效。", en: "The Installation ID returned by GitHub is invalid." },
  messageInstallationFailed: { "zh-CN": "无法验证 GitHub 安装，请检查应用权限后重试。", en: "Could not verify the GitHub installation; check the app permissions and retry." },
  messageInstallationState: {
    "zh-CN": "GitHub 安装状态已失效或与当前工作区不匹配，请重新发起连接。",
    en: "The GitHub installation state has expired or does not match the current workspace; please reconnect.",
  },
  messageConnected: { "zh-CN": "GitHub 已连接，现在可以添加产品。", en: "GitHub is connected; you can now add products." },
} satisfies Record<string, LocaleEntry>;

// ── 连接状态标签（GitHub App 卡片与 Token 卡片共用；与 lib/integration-ui 中文逐字一致） ──
export const CONNECTION_STATUS = {
  connected: { "zh-CN": "已连接", en: "Connected" },
  disconnected: { "zh-CN": "已断开", en: "Disconnected" },
} satisfies Record<string, LocaleEntry>;

// ── GitHub App 卡片 ──
export const GITHUB_APP_CARD = {
  subtitle: { "zh-CN": "推荐使用 GitHub App · 按仓库授权 · Contents 与 Metadata 只读", en: "Recommended: GitHub App · per-repository authorization · read-only Contents and Metadata" },
  emptyEditor: { "zh-CN": "通过 GitHub 官方引导创建 CoDelphi App，然后选择允许读取的仓库。", en: "Create the CoDelphi App through GitHub's official flow, then choose the repositories it may read." },
  emptyViewer: { "zh-CN": "尚未创建 GitHub App，请联系工作区编辑者或所有者配置。", en: "No GitHub App yet; ask a workspace editor or owner to set it up." },
  connectLink: { "zh-CN": "连接 GitHub", en: "Connect GitHub" },
  appPrefix: { "zh-CN": "应用 ", en: "App " },
  installationsSuffix: { "zh-CN": " 个可用安装", en: " active installations" },
  installationsSuffixOne: { "zh-CN": " 个可用安装", en: " active installation" },
  addAccountLink: { "zh-CN": "添加账号或组织", en: "Add an account or organization" },
  pushSettingsLink: { "zh-CN": "设置 Push 通知", en: "Configure push notifications" },
  listEmpty: { "zh-CN": "App 已创建，但尚未安装到任何 GitHub 账号或组织。", en: "The App is created but not installed on any GitHub account or organization yet." },
} satisfies Record<string, LocaleEntry>;

// ── Token 集成卡片（Gitee / 自有 Git 服务） ──
export const TOKEN_CARD = {
  selfHostedHeading: { "zh-CN": "自有 Git 服务", en: "Self-hosted Git service" },
  giteeSubtitle: { "zh-CN": "使用私人令牌连接 Gitee 账号", en: "Connect a Gitee account with a personal token" },
  selfHostedSubtitle: { "zh-CN": "连接 GitLab、Gitea 或内网部署的 Git 服务", en: "Connect GitLab, Gitea or an internally hosted Git service" },
  capability: {
    "zh-CN": "当前开放连接配置与验证；添加产品和代码分析仍仅支持 GitHub。",
    en: "Connection setup and verification are open now; adding products and code analysis still support GitHub only.",
  },
  giteeStep1: { "zh-CN": "在 Gitee 创建私人令牌，只勾选读取用户信息和仓库所需的最小权限。", en: "Create a personal token on Gitee, ticking only the minimum scopes needed to read your profile and repositories." },
  giteeStep2: { "zh-CN": "粘贴令牌，CoDelphi 会验证账号后再加密保存。", en: "Paste the token; CoDelphi verifies the account before encrypting and storing it." },
  giteeTokenLink: { "zh-CN": "打开 Gitee 令牌设置 ↗", en: "Open Gitee token settings ↗" },
  selfHostedStep1: { "zh-CN": "确保 CoDelphi 服务器能访问你的 Git 服务，并启用有效的 HTTPS 证书。", en: "Make sure the CoDelphi server can reach your Git service and that a valid HTTPS certificate is in place." },
  selfHostedStep2Prefix: { "zh-CN": "创建访问令牌：GitLab 使用 ", en: "Create an access token: use " },
  selfHostedStep2Middle: { "zh-CN": "，Gitea 使用 ", en: " for GitLab and " },
  selfHostedStep2Suffix: { "zh-CN": "，再按仓库读取需要授权。", en: " for Gitea, then grant whatever repository read access is needed." },
  selfHostedApiNote: { "zh-CN": "当前支持 GitLab 与 Gitea API；暂不支持 SSH 地址。", en: "GitLab and Gitea APIs are supported for now; SSH addresses are not." },
  allowlistConfigured: { "zh-CN": "仅允许 REPOSITORY_HOST_ALLOWLIST 中登记的主机和端口；GitLab.com 默认可用。", en: "Only hosts and ports registered in REPOSITORY_HOST_ALLOWLIST are allowed; GitLab.com works by default." },
  allowlistMissing: { "zh-CN": "自有服务尚未配置主机白名单，请联系管理员设置 REPOSITORY_HOST_ALLOWLIST；GitLab.com 可直接连接。", en: "No host allowlist is configured for self-hosted services yet; ask an administrator to set REPOSITORY_HOST_ALLOWLIST. GitLab.com connects directly." },
  savedEmpty: { "zh-CN": "还没有已保存的连接。", en: "No saved connections yet." },
  providerLabel: { "zh-CN": "平台类型 ", en: "Platform type " },
  gitlabOption: { "zh-CN": "GitLab（云端或自托管）", en: "GitLab (cloud or self-hosted)" },
  baseUrlLabel: { "zh-CN": "服务地址 ", en: "Server URL " },
  baseUrlHint: { "zh-CN": "填写服务根地址，不要包含 /api/v4、/api/v1 或仓库路径。", en: "Enter the service root URL without /api/v4, /api/v1 or repository paths." },
  tokenLabel: { "zh-CN": "访问令牌 ", en: "Access token " },
  giteeTokenPlaceholder: { "zh-CN": "粘贴 Gitee 私人令牌", en: "Paste the Gitee personal token" },
  providerTokenPlaceholderPrefix: { "zh-CN": "粘贴 ", en: "Paste the " },
  providerTokenPlaceholderSuffix: { "zh-CN": " 访问令牌", en: " access token" },
  tokenHint: { "zh-CN": "仅用于服务端连接验证，保存后不会再次显示；删除连接会清除令牌。", en: "Used only for server-side connection verification and never shown again once saved; deleting the connection clears the token." },
  verifying: { "zh-CN": "正在验证连接…", en: "Verifying connection…" },
  saveConnectionButton: { "zh-CN": "验证并保存连接", en: "Verify and save connection" },
  connectedPrefix: { "zh-CN": "已连接 ", en: "Connected to " },
  connectedMiddle: { "zh-CN": " 账号 @", en: " account @" },
  connectedSuffix: { "zh-CN": "。", en: "." },
  viewerNote: { "zh-CN": "工作区查看者只能查看连接状态，请联系编辑者或所有者配置。", en: "Workspace viewers can only see connection status; ask an editor or owner to configure connections." },
} satisfies Record<string, LocaleEntry>;

// ── 服务器共享 Token 回退卡片 ──
export const PAT_FALLBACK_CARD = {
  heading: { "zh-CN": "服务器共享 Token · 旧版兼容", en: "Server-shared token · legacy compatibility" },
  body: {
    "zh-CN": "仅用于现有 GitHub 产品，不是客户配置入口。新连接请使用上方的工作区级设置。",
    en: "For existing GitHub products only — not a customer configuration entry point. Use the workspace-level settings above for new connections.",
  },
  configured: { "zh-CN": "已配置", en: "Configured" },
  notConfigured: { "zh-CN": "未配置", en: "Not configured" },
} satisfies Record<string, LocaleEntry>;

// ── 邀请接受页 ──
export const INVITATION_ACCEPT = {
  invalidTitle: { "zh-CN": "邀请链接无效或已过期", en: "This invitation link is invalid or expired" },
  invalidBody: { "zh-CN": "请联系工作区所有者重新发送邀请链接。", en: "Please ask the workspace owner to send a new invitation link." },
  backHome: { "zh-CN": "返回 CoDelphi", en: "Back to CoDelphi" },
  productTargetPrefix: { "zh-CN": "产品「", en: "product \"" },
  workspaceTargetPrefix: { "zh-CN": "工作区「", en: "workspace \"" },
  targetSuffix: { "zh-CN": "」", en: "\"" },
  acceptTitle: { "zh-CN": "接受邀请", en: "Accept invitation" },
  bodyPrefix: { "zh-CN": "你被邀请加入 ", en: "You have been invited to join the " },
  bodyRolePrefix: { "zh-CN": "，角色为 ", en: " with the role " },
  bodyEmailPrefix: { "zh-CN": "。请使用 ", en: ". Continue with the Chandler account for " },
  bodyEmailSuffix: { "zh-CN": " 对应的 Chandler 账号继续。", en: "." },
  loginAcceptButton: { "zh-CN": "已有 Chandler 账号，登录并接受邀请", en: "I have a Chandler account — sign in and accept" },
  registerAcceptButton: { "zh-CN": "没有 Chandler 账号？注册后接受邀请", en: "No Chandler account? Register and accept the invitation" },
  failureTitle: { "zh-CN": "无法接受邀请", en: "Could not accept the invitation" },
  mismatchPrefix: { "zh-CN": "此邀请仅接受 ", en: "This invitation only accepts the account for " },
  mismatchSuffix: { "zh-CN": " 对应的账号。请退出当前账号后重新登录。", en: ". Sign out of the current account and sign in again." },
  failureBody: { "zh-CN": "无法接受邀请，请重新打开链接或联系工作区所有者。", en: "The invitation could not be accepted; reopen the link or contact the workspace owner." },
  reloginButton: { "zh-CN": "重新登录", en: "Sign in again" },
} satisfies Record<string, LocaleEntry>;

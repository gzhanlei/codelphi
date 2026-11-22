import type { LocaleEntry } from "../ui-locale";

/**
 * Wave 4a 域字典：登录/403/dashboard/工作区/添加产品/通用反馈件。
 * 页面经 resolveUiLocale() 取 locale 后用 pick() 取值；客户端组件经 props 接收 locale。
 */

// ── 登录页 ──
export const LOGIN = {
  headline: { "zh-CN": "读懂每一次\n产品变化。", en: "Understand every\nproduct change." },
  statement: {
    "zh-CN": "把 GitHub 代码变更翻译成人人看得懂的发布说明与回归范围：每条结论附代码证据，采纳前经人工核实。",
    en: "Translate GitHub code changes into release notes and regression scopes everyone can read: every claim carries code evidence and is signed off by human review.",
  },
  panelEyebrow: { "zh-CN": "工作区登录", en: "Workspace sign-in" },
  welcome: { "zh-CN": "欢迎回来", en: "Welcome back" },
  chandlerIntro: { "zh-CN": "使用 Chandler 统一账号继续；账号与密码由 Chandler 统一身份服务保管。", en: "Continue with your Chandler account; credentials stay in the Chandler identity service." },
  chandlerButton: { "zh-CN": "使用 Chandler 登录", en: "Sign in with Chandler" },
  allChandlerUsers: { "zh-CN": "所有 Chandler 用户均可登录，自动创建个人工作区", en: "Any Chandler user can sign in; a personal workspace is created automatically" },
  dataNoticeLine: {
    "zh-CN": "数据说明：源码仅发送给部署配置的 AI 网关及其上游，不用于模型训练。",
    en: "Data notice: source code is sent only to the configured AI gateway and its upstream; it is not used for model training.",
  },
  demoEntryTitle: { "zh-CN": "不想登录？先看公开演示", en: "Not ready to sign in? Try the public demo" },
  demoEntryBody: { "zh-CN": " 的规格清单、回归用例与 30 天变更索引全部匿名只读开放。", en: "'s spec list, regression cases and 30-day change index are all open anonymously in read-only mode." },
  demoEnter: { "zh-CN": "进入在线演示 →", en: "Open the live demo →" },
  demoExports: {
    specJson: { "zh-CN": "规格清单（spec.json）", en: "Spec list (spec.json)" },
    gherkin: { "zh-CN": "Gherkin 回归用例", en: "Gherkin regression cases" },
    markdown: { "zh-CN": "Markdown 规格书", en: "Markdown spec document" },
    changeIndex: { "zh-CN": "30 天变更索引", en: "30-day change index" },
    explainer: { "zh-CN": "Explainer 一页说明", en: "One-page explainer" },
  } satisfies Record<string, LocaleEntry>,
} satisfies Record<string, LocaleEntry | Record<string, LocaleEntry>>;

// ── 自建注册/登录表单（Chandler 密码认证通道 + Cloudflare Turnstile） ──
export const AUTH_FORM = {
  accountLabel: { "zh-CN": "邮箱或用户名", en: "Email or username" },
  accountPlaceholder: { "zh-CN": "you@example.com", en: "you@example.com" },
  emailLabel: { "zh-CN": "邮箱", en: "Email" },
  passwordLabel: { "zh-CN": "密码", en: "Password" },
  passwordHint: { "zh-CN": "8-255 位，含大小写字母、数字、符号中的至少 3 类", en: "8-255 characters with at least 3 of: upper, lower, digit, symbol" },
  passwordPlaceholder: { "zh-CN": "输入密码", en: "Enter your password" },
  codeLabel: { "zh-CN": "邮箱验证码", en: "Email verification code" },
  codePlaceholder: { "zh-CN": "6 位数字", en: "6-digit code" },
  displayNameLabel: { "zh-CN": "昵称（可选）", en: "Display name (optional)" },
  displayNamePlaceholder: { "zh-CN": "在界面中显示的名字", en: "Name shown in the interface" },
  sendCode: { "zh-CN": "发送验证码", en: "Send code" },
  sending: { "zh-CN": "发送中…", en: "Sending…" },
  codeSent: { "zh-CN": "验证码已发送，请查收邮箱（可能在垃圾箱）。", en: "Code sent — check your inbox (and spam folder)." },
  loginSubmit: { "zh-CN": "登录", en: "Sign in" },
  registerSubmit: { "zh-CN": "创建账号", en: "Create account" },
  submitting: { "zh-CN": "提交中…", en: "Submitting…" },
  mfaLabel: { "zh-CN": "两步验证码", en: "Two-factor code" },
  mfaHint: { "zh-CN": "该账号已开启两步验证，请输入验证器 App 中的 6 位数字。", en: "This account has two-factor auth on; enter the 6-digit code from your authenticator app." },
  mfaSubmit: { "zh-CN": "验证并登录", en: "Verify and sign in" },
  mfaBack: { "zh-CN": "← 返回重新登录", en: "← Back to sign-in" },
  needAccount: { "zh-CN": "还没有账号？", en: "No account yet?" },
  goRegister: { "zh-CN": "注册", en: "Sign up" },
  haveAccount: { "zh-CN": "已有账号？", en: "Already have an account?" },
  goLogin: { "zh-CN": "直接登录", en: "Sign in instead" },
  turnstileLabel: { "zh-CN": "人机验证", en: "Human verification" },
  agreePrefix: { "zh-CN": "已阅读并同意 Chandler", en: "I have read and agree to the Chandler" },
  agreeTerms: { "zh-CN": "《用户协议》", en: "Terms of Service" },
  agreeAnd: { "zh-CN": "与", en: "and" },
  agreePrivacy: { "zh-CN": "《隐私政策》", en: "Privacy Policy" },
} satisfies Record<string, LocaleEntry>;

// ── 注册页文案 ──
export const REGISTER = {
  panelEyebrow: { "zh-CN": "创建账号", en: "Create account" },
  welcome: { "zh-CN": "注册 CoDelphi", en: "Join CoDelphi" },
  intro: {
    "zh-CN": "注册即创建 Chandler 统一账号：邮箱验证通过后自动建立个人工作区，可立即接入产品。",
    en: "Registration creates a Chandler account: once your email is verified, a personal workspace is provisioned right away.",
  },
  headline: { "zh-CN": "把代码变化\n读成产品语言。", en: "Turn code changes\ninto product language." },
} satisfies Record<string, LocaleEntry>;

/** Chandler 认证错误码 → 界面文案（错误码即稳定键：服务端 API 也用本表回中文默认文案）。 */
export const AUTH_ERRORS: Record<string, LocaleEntry> = {
  email_taken: { "zh-CN": "该邮箱已注册，可直接登录。", en: "This email is already registered — sign in instead." },
  email_code_invalid: { "zh-CN": "邮箱验证码不正确或已过期。", en: "The email verification code is invalid or expired." },
  otp_cooldown: { "zh-CN": "验证码发送过于频繁，请稍后再试。", en: "Code requests are too frequent; try again shortly." },
  otp_delivery_failed: { "zh-CN": "验证码发送失败，请稍后再试。", en: "Failed to send the code; try again shortly." },
  invalid_credentials: { "zh-CN": "账号或密码错误。", en: "Incorrect account or password." },
  weak_password: { "zh-CN": "密码需 8-255 位，且包含大小写字母、数字、符号中的至少 3 类。", en: "Password must be 8-255 characters with at least 3 of: upper, lower, digit, symbol." },
  user_disabled: { "zh-CN": "该账号已被限制使用。", en: "This account has been disabled." },
  mfa_invalid_code: { "zh-CN": "动态验证码不正确。", en: "Invalid verification code." },
  turnstile_failed: { "zh-CN": "人机验证未通过，请重试。", en: "Human verification failed — please retry." },
  turnstile_unavailable: { "zh-CN": "人机验证服务暂不可用，请稍后再试。", en: "Human verification is temporarily unavailable; try again later." },
  rate_limited: { "zh-CN": "操作过于频繁，请稍后再试。", en: "Too many attempts; try again shortly." },
  unavailable: { "zh-CN": "Chandler 服务暂不可用，请稍后再试。", en: "Chandler is temporarily unavailable; try again later." },
  invalid_input: { "zh-CN": "请求参数不完整，请检查表单。", en: "The request is incomplete — check the form." },
  missing_turnstile_token: { "zh-CN": "请先完成人机验证。", en: "Please complete the human verification first." },
  forbidden: { "zh-CN": "该账号未获得本部署的访问授权。", en: "This account is not authorized for this deployment." },
} satisfies Record<string, LocaleEntry>;

// ── 403 ──
export const FORBIDDEN = {
  heading: { "zh-CN": "这个账号还没有 CoDelphi 权限", en: "This account does not have CoDelphi access yet" },
  body: {
    "zh-CN": "当前部署启用了专用登录限制。请使用已授权的 Chandler 账号，或联系工作区管理员处理访问授权。",
    en: "This deployment restricts sign-in to approved accounts. Use an authorized Chandler account, or contact your workspace administrator for access.",
  },
  backToLogin: { "zh-CN": "返回登录", en: "Back to sign-in" },
} satisfies Record<string, LocaleEntry>;

// ── Dashboard（产品总览） ──
export const DASHBOARD = {
  heading: { "zh-CN": "产品总览", en: "Products" },
  subheading: { "zh-CN": "所有产品的当前规格与最新变化，集中在这里。", en: "Every product's current spec and latest changes, in one place." },
  addProduct: { "zh-CN": "＋ 添加产品", en: "＋ Add product" },
  statsAria: { "zh-CN": "产品统计", en: "Product stats" },
  statProducts: { "zh-CN": "已接入产品", en: "Connected products" },
  statProductsUnit: { "zh-CN": "个独立产品空间", en: "independent product spaces" },
  statFeatures: { "zh-CN": "活跃功能", en: "Active features" },
  statFeaturesUnit: { "zh-CN": "个可追溯功能", en: "traceable features" },
  statReleases: { "zh-CN": "已分析发布", en: "Analyzed releases" },
  statReleasesUnit: { "zh-CN": "次代码发布", en: "code releases analyzed" },
  sectionProducts: { "zh-CN": "产品空间", en: "Product spaces" },
  sectionProductsCount: { "zh-CN": " 个产品", en: " products" },
  sectionChanges: { "zh-CN": "最近变化", en: "Recent changes" },
  sectionChangesNote: { "zh-CN": "按发布时间排序", en: "Sorted by release time" },
  emptyProductsTitle: { "zh-CN": "还没有接入产品", en: "No products connected yet" },
  emptyProductsBody: { "zh-CN": "配置 MySQL 后运行 ", en: "After configuring MySQL, run " },
  emptyProductsTail: { "zh-CN": " 注册 CoDelphi 自身。", en: " to register CoDelphi itself." },
  emptyTimeline: { "zh-CN": "完成第一次代码分析后，发布变化会出现在这里。", en: "Release changes will appear here after the first code analysis completes." },
  analyzingWithHistory: { "zh-CN": "分析中，历史规格可查看", en: "Analyzing; the previous spec stays readable" },
  analyzing: { "zh-CN": "分析中，请稍候", en: "Analyzing, please wait" },
  featureUnit: { "zh-CN": " 个功能", en: " features" },
  releaseUnit: { "zh-CN": " 次发布", en: " releases" },
  timelineNote: { "zh-CN": "按发布时间排序", en: "Sorted by release time" },
} satisfies Record<string, LocaleEntry>;

// ── 我的工作区 ──
export const ORGANIZATIONS = {
  backLink: { "zh-CN": "← 所有产品", en: "← All products" },
  heading: { "zh-CN": "我的工作区", en: "My workspaces" },
  subheading: { "zh-CN": "你创建或加入的产品空间。", en: "Product spaces you created or joined." },
  inviteHeading: { "zh-CN": "邀请成员", en: "Invite members" },
  inviteBody: { "zh-CN": "邀请成员加入整个工作区。单个产品的成员请在对应产品的「设置」页邀请。", en: "Invite members to the whole workspace. Product-level members are invited from each product's Settings page." },
  email: { "zh-CN": "邮箱", en: "Email" },
  role: { "zh-CN": "角色", en: "Role" },
  inviteButton: { "zh-CN": "邀请", en: "Invite" },
  memberAdded: { "zh-CN": "成员已加入。", en: "The member has joined." },
  inviteCreated: { "zh-CN": "邀请已创建，对方登录或注册后即可加入。", en: "Invitation created; they can join once they sign in or register." },
  openInviteLink: { "zh-CN": "打开邀请链接", en: "Open the invite link" },
  inviteEmailSent: { "zh-CN": " · Chandler 注册邮件已发送", en: " · A Chandler registration email has been sent" },
  inviteEmailFallback: { "zh-CN": " · 该邮箱已注册或未发送注册邮件，请复制邀请链接发送给对方", en: " · That email is already registered or no email was sent; copy the invite link and share it" },
  tableWorkspace: { "zh-CN": "工作区", en: "Workspace" },
  tableRole: { "zh-CN": "角色", en: "Role" },
  tableActions: { "zh-CN": "操作", en: "Actions" },
  roleOwner: { "zh-CN": "所有者", en: "Owner" },
  roleEditor: { "zh-CN": "编辑者", en: "Editor" },
  roleViewer: { "zh-CN": "查看者", en: "Viewer" },
  currentWorkspace: { "zh-CN": "当前工作区", en: "Current workspace" },
  switch: { "zh-CN": "切换", en: "Switch" },
} satisfies Record<string, LocaleEntry>;

// ── 添加产品 ──
export const NEW_PRODUCT = {
  backLink: { "zh-CN": "← 所有产品", en: "← All products" },
  heading: { "zh-CN": "添加产品", en: "Add a product" },
  subheading: { "zh-CN": "接入一个 GitHub 仓库，生成带代码证据的功能清单与变更翻译。", en: "Connect a GitHub repository to generate an evidence-backed feature list and change translation." },
  infoHeading: { "zh-CN": "产品信息", en: "Product information" },
  infoBody: { "zh-CN": "用于在产品总览和浏览器地址中展示。", en: "Shown in the product list and the browser address." },
  nameLabel: { "zh-CN": "产品名称", en: "Product name" },
  namePlaceholder: { "zh-CN": "例如 SalesBuddy", en: "e.g. SalesBuddy" },
  slugLabel: { "zh-CN": "产品 Slug", en: "Product slug" },
  slugHint: { "zh-CN": "小写字母、数字和连字符；中文名产品可填 tingfeng。", en: "Lowercase letters, digits and hyphens." },
  descriptionLabel: { "zh-CN": "产品简介", en: "Description" },
  descriptionPlaceholder: { "zh-CN": "一句话说明这个产品解决什么问题", en: "One sentence on the problem this product solves" },
  outputLanguageLabel: { "zh-CN": "分析输出语言", en: "Analysis output language" },
  outputLanguageHint: { "zh-CN": "；之后可在产品「设置」里切换（切换后下一次分析全量重建）。", en: ". You can switch later in the product's Settings (the next analysis rebuilds fully after a switch)." },
  repoHeading: { "zh-CN": "GitHub 仓库", en: "GitHub repository" },
  repoBody: { "zh-CN": "CoDelphi 会验证当前选择的凭据是否有读取权限。", en: "CoDelphi verifies that the selected credentials can read the repository." },
  repoLabel: { "zh-CN": "仓库", en: "Repository" },
  repoHint: { "zh-CN": "使用 owner/repo 格式，当前先接入一个主仓库。", en: "Use the owner/repo format; connect one primary repository for now." },
  branchLabel: { "zh-CN": "默认分支", en: "Default branch" },
  branchPlaceholder: { "zh-CN": "留空则读取仓库默认分支", en: "Leave empty to read the repository default" },
  branchHint: { "zh-CN": "只有这个分支的 push 会触发自动分析。", en: "Only pushes to this branch trigger automatic analysis." },
  connectionRequiredHeading: { "zh-CN": "先连接 GitHub", en: "Connect GitHub first" },
  connectionRequiredBody: { "zh-CN": "添加产品之前，需要安装只读 CoDelphi GitHub App，或由管理员配置 Personal Access Token。", en: "Before adding a product, install the read-only CoDelphi GitHub App or have an administrator configure a Personal Access Token." },
  goToIntegrations: { "zh-CN": "前往 Integrations", en: "Open Integrations" },
} satisfies Record<string, LocaleEntry>;

// ── 通用反馈件（form-feedback 等） ──
export const FEEDBACK = {
  analyzing: { "zh-CN": "正在提交…", en: "Submitting…" },
  analyzeNow: { "zh-CN": "立即分析", en: "Analyze now" },
  submittingAdd: { "zh-CN": "正在验证并添加…", en: "Verifying and adding…" },
  addAndAnalyze: { "zh-CN": "添加并开始分析", en: "Add and start analysis" },
  addProduct: { "zh-CN": "添加产品", en: "Add product" },
} satisfies Record<string, LocaleEntry>;

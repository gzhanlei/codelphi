import type { LocaleEntry, UiLocale } from "../ui-locale";

/**
 * Wave 4d 域字典：服务条款（terms）与数据说明（data-notice）整页内容双语。
 * 法务页是内容页——整段翻译，不是 chrome 标签；「待业务确认」标注在两种语言下都保留。
 */

export const TERMS: Record<string, LocaleEntry> = {
  title: { "zh-CN": "服务条款与数据处理", en: "Terms of Service & Data Processing" },
  subtitle: {
    "zh-CN": "源码处理、子处理方、事故通知与数据保留的公开说明。",
    en: "Public notes on source-code handling, sub-processors, incident notification and data retention.",
  },
  draftNote: {
    "zh-CN": "本页为条款草稿：标注「待业务确认」的条目尚未经法务与财务出具书面结论，不构成正式服务承诺。",
    en: "This page is a draft: items marked \"pending business confirmation\" have no written legal or finance conclusion yet and do not constitute formal service commitments.",
  },
  pending: { "zh-CN": "（待业务确认）", en: " (pending business confirmation)" },
  pricingLink: { "zh-CN": "套餐与定价 →", en: "Pricing →" },
  backLink: { "zh-CN": "← 返回产品总览", en: "← Back to products" },
};

interface TermsSection {
  title: string;
  body: Array<{ text: string; pending?: boolean }>;
}

const TERMS_SECTIONS: Record<UiLocale, TermsSection[]> = {
  "zh-CN": [
    {
      title: "1. 子处理方名单",
      body: [
        { text: "LLM 网关（当前为自建 LLMGateway）及其上游模型服务商；代码仅在分析请求期间发送给该网关。数据驻留区域：待业务确认。", pending: true },
        { text: "数据库：腾讯云 MySQL 8（中国区）。规格、证据与账务数据存储于此。", pending: false },
        { text: "代码托管平台：GitHub（GitHub App Installation Token）/ GitLab。仅访问你授权的仓库。", pending: false },
        { text: "支付：经 Chandler 通道（微信支付 / 支付宝）。支付信息由 Chandler 处理，CoDelphi 不存储支付凭据。", pending: false },
        { text: "邮件与通知：Slack / Webhook / 邮件渠道。发送服务商名单：待业务确认。", pending: true },
      ],
    },
    {
      title: "2. 源码处理条款",
      body: [
        { text: "源码不用于训练任何模型。", pending: false },
        { text: "留存时长：分析的产物为规格与证据引用（文件路径 + 行号），不整仓留存源码内容；拉取的源码切片仅存在于分析运行期间。精确留存窗口：待业务确认。", pending: true },
        { text: "删除与撤回：删除产品即级联删除其规格、证据与索引；断开仓库授权后不再读取代码。全量数据导出 / 删除请求的处理时限：待业务确认。", pending: true },
        { text: "代码出域路径：仅「你的仓库 → CoDelphi 分析服务 → 配置的 AI 网关」一条路径；无其他副本。", pending: false },
        { text: "AI 只能引用本次读取的代码或 diff 文件，未知证据路径会使分析失败（assertEvidence 门禁）。", pending: false },
      ],
    },
    {
      title: "3. 事故通知与责任上限",
      body: [
        { text: "影响源码或规格数据保密性的事故，通知时限与方式：待业务确认（正式 SLA 条款）。", pending: true },
        { text: "DPA（数据处理协议）可应请求提供：待业务确认。", pending: true },
        { text: "本产品不判断「做对了没有」：规格输出是证据覆盖率与可追溯引用，不是结论正确性；输出应经人工核实后采纳（README 已知边界）。", pending: false },
      ],
    },
    {
      title: "4. 数据保留与账户",
      body: [
        { text: "登录仅保存 Chandler sub、邮箱、显示名与头像；不保存 Chandler 密码或 OAuth token。会话有效期 7 天。", pending: false },
        { text: "订阅到期后：7 天只读宽限（grace）→ 过期停止新增分析；历史规格与导出的保留与删除政策：待业务确认。", pending: true },
        { text: "账务流水（预留、捕获、冲正）按审计要求保留原始记录，不删除、不倒改；退款按剩余天数 / 剩余额度折算，以财务与法务书面结论为准。", pending: false },
      ],
    },
  ],
  en: [
    {
      title: "1. Sub-processor list",
      body: [
        { text: "LLM gateway (currently the self-hosted LLMGateway) and its upstream model providers; code is sent to that gateway only for the duration of an analysis request. Data residency region: pending business confirmation.", pending: true },
        { text: "Database: Tencent Cloud MySQL 8 (China region). Specs, evidence and billing data are stored there.", pending: false },
        { text: "Code hosting: GitHub (GitHub App Installation Token) / GitLab. Only repositories you authorize are accessed.", pending: false },
        { text: "Payments: through the Chandler channel (WeChat Pay / Alipay). Payment information is handled by Chandler; CoDelphi does not store payment credentials.", pending: false },
        { text: "Email and notifications: Slack / webhook / email channels. Delivery provider list: pending business confirmation.", pending: true },
      ],
    },
    {
      title: "2. Source-code handling",
      body: [
        { text: "Source code is never used to train any model.", pending: false },
        { text: "Retention: the products of analysis are specs and evidence references (file path + line number); full repository source is not retained, and pulled source slices exist only during the analysis run. Exact retention window: pending business confirmation.", pending: true },
        { text: "Deletion and withdrawal: deleting a product cascades to its specs, evidence and indexes; after repository authorization is revoked, code is no longer read. Processing time for full data export / deletion requests: pending business confirmation.", pending: true },
        { text: "Code egress path: exactly one path — your repository → CoDelphi analysis service → the configured AI gateway; no other copies exist.", pending: false },
        { text: "The AI may only cite code or diff files read in this run; an unknown evidence path makes the analysis fail (assertEvidence gate).", pending: false },
      ],
    },
    {
      title: "3. Incident notification and liability",
      body: [
        { text: "For incidents affecting the confidentiality of source code or spec data, notification timing and method: pending business confirmation (formal SLA terms).", pending: true },
        { text: "A DPA (data processing agreement) is available on request: pending business confirmation.", pending: true },
        { text: "This product does not judge \"whether it was done right\": spec output is evidence coverage and traceable references, not conclusion correctness; output should be adopted only after human review (known boundary in the README).", pending: false },
      ],
    },
    {
      title: "4. Data retention and accounts",
      body: [
        { text: "Sign-in stores only the Chandler sub, email, display name and avatar; Chandler passwords and OAuth tokens are never stored. Sessions last 7 days.", pending: false },
        { text: "After a subscription expires: 7 days of read-only grace → new analyses stop when expired. Retention and deletion policy for historical specs and exports: pending business confirmation.", pending: true },
        { text: "Billing ledger entries (reservation, capture, reversal) keep their original records for audit purposes — never deleted or rewritten; refunds are prorated by remaining days / remaining quota, subject to written finance and legal conclusions.", pending: false },
      ],
    },
  ],
};

export function termsSections(locale: UiLocale): TermsSection[] {
  return TERMS_SECTIONS[locale];
}

export const DATA_NOTICE: Record<string, LocaleEntry> = {
  title: { "zh-CN": "数据说明", en: "Data notice" },
  meta: {
    "zh-CN": "最后更新：{updated} · 本页描述 CoDelphi 的实际数据流，与 README「数据与安全边界」保持一致。",
    en: "Last updated: {updated} · This page describes CoDelphi's actual data flow and matches the README's \"data and security boundaries\".",
  },
  backLink: { "zh-CN": "← 返回首页", en: "← Back home" },
};

interface NoticeSection {
  heading: string;
  items: string[];
}

const NOTICE_SECTIONS: Record<UiLocale, NoticeSection[]> = {
  "zh-CN": [
    { heading: "我们读取什么", items: ["你接入产品时授权的 GitHub 仓库代码文件与 diff 内容。优先使用按仓库授权的 GitHub App Installation Token，服务端共享 Token 仅作兼容回退。"] },
    { heading: "发送到哪里", items: ["分析所需的代码文件与 diff 仅发送给部署方配置的 AI 网关（AI_BASE_URL）及其上游模型服务，用于生成功能、场景与变化说明。", "工作区配置了自己的模型时，服务端分析所需的代码文件与 diff 发送到工作区指定的模型服务地址，不经过部署方的网关。", "不发送给任何其他第三方。"] },
    { heading: "我们存储什么", items: ["分析结果：功能、场景、行为变化、证据路径与行号、发布元数据。不存储源码文件全文。", "仓库凭据（GitHub App 密钥、仓库 Token）加密存储。", "工作区自己配置的模型 API key 加密存储，只用于替这个工作区调用它指定的模型服务。", "账号数据只保存 Chandler sub、邮箱、显示名和头像；不保存 Chandler 密码或 OAuth token。"] },
    { heading: "模型训练", items: ["我们不使用你的代码训练任何模型。", "上游模型服务商的数据处理以其自身条款为准；部署方负责确保所选网关及其上游符合保密要求。"] },
    { heading: "删除与留存", items: ["删除产品（工作区级操作）会一并删除该产品的分析数据。", "登录会话有效期 7 天，过期后重新通过 Chandler 登录。", "分析数据保留至对应产品被删除，无自动过期。"] },
    { heading: "事件通知", items: ["如发生影响你源码安全的事件，我们会尽快通知工作区联系人。"] },
    { heading: "结论边界", items: ["路径守卫只防引用幻觉，不防语义幻觉：每条结论都附代码证据，但证据覆盖描述证据范围，不表示结论正确。采纳前应经人工核实。"] },
  ],
  en: [
    { heading: "What we read", items: ["Code files and diff content of the GitHub repositories you authorize when connecting a product. A per-repository GitHub App Installation Token is preferred; a server-wide shared token exists only as a compatibility fallback."] },
    { heading: "Where it is sent", items: ["The code files and diffs needed for analysis are sent only to the AI gateway configured by the deployment (AI_BASE_URL) and its upstream model services, to generate features, scenarios and change descriptions.", "When a workspace configures its own model, the code files and diffs needed for server-side analysis go to the model service address the workspace chose, not through the deployment's gateway.", "They are sent to no other third party."] },
    { heading: "What we store", items: ["Analysis results: features, scenarios, behavior changes, evidence paths and line numbers, release metadata. Full source files are not stored.", "Repository credentials (GitHub App keys, repository tokens) are stored encrypted.", "The API key of a workspace's own model is stored encrypted and is used only to call the model service that workspace chose.", "Account data keeps only the Chandler sub, email, display name and avatar; Chandler passwords and OAuth tokens are never stored."] },
    { heading: "Model training", items: ["We never use your code to train any model.", "Upstream model providers' data handling is governed by their own terms; the deployment operator is responsible for ensuring the chosen gateway and its upstream meet confidentiality requirements."] },
    { heading: "Deletion and retention", items: ["Deleting a product (a workspace-level action) deletes that product's analysis data with it.", "Login sessions last 7 days; after expiry you sign in through Chandler again.", "Analysis data is retained until the corresponding product is deleted — no automatic expiry."] },
    { heading: "Incident notification", items: ["If an event affects the security of your source code, we notify workspace contacts as soon as possible."] },
    { heading: "Conclusion boundaries", items: ["Path guards prevent citation hallucinations, not semantic ones: every conclusion carries code evidence, but evidence coverage describes the evidence scope, not whether the conclusion is correct. Have a human verify before adopting."] },
  ],
};

export function noticeSections(locale: UiLocale): NoticeSection[] {
  return NOTICE_SECTIONS[locale];
}

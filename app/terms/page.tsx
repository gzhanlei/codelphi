import Link from "next/link";

export const metadata = { title: "服务条款与数据处理" };

/**
 * C1 条款页（docs/specsight-gap-improvement-plan.md §6.1）：
 * 四类条款的公开草稿——子处理方名单、源码处理条款、事故通知与责任上限、数据保留。
 * 数据边界事实来自 README「数据与安全边界」与 docs/codelphi-pricing-and-billing.md；
 * 标注「待业务确认」的条目需子处理方清单 / 法务结论后替换，不得当作正式承诺。
 */

const DRAFT_NOTE = "本页为条款草稿：标注「待业务确认」的条目尚未经法务与财务出具书面结论，不构成正式服务承诺。";

const sections = [
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
];

export default function TermsPage() {
  return (
    <main className="terms-page">
      <div className="page-heading">
        <div><span className="eyebrow">LEGAL</span><h1>服务条款与数据处理</h1><p>源码处理、子处理方、事故通知与数据保留的公开说明。</p></div>
      </div>
      <p className="sidebar-note">{DRAFT_NOTE}</p>
      {sections.map((section) => (
        <section key={section.title}>
          <h2>{section.title}</h2>
          <ul>
            {section.body.map((item) => (
              <li key={item.text.slice(0, 24)}>
                {item.text}
                {item.pending ? <strong>（待业务确认）</strong> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p><Link href="/pricing" className="text-button">套餐与定价 →</Link>　<Link href="/" className="text-button">← 返回产品总览</Link></p>
    </main>
  );
}

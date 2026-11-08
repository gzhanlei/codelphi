import Link from "next/link";

const NOTICE_UPDATED = "2026-11-08";

const sections: Array<{ heading: string; items: string[] }> = [
  {
    heading: "我们读取什么",
    items: [
      "你接入产品时授权的 GitHub 仓库代码文件与 diff 内容。优先使用按仓库授权的 GitHub App Installation Token，服务端共享 Token 仅作兼容回退。",
    ],
  },
  {
    heading: "发送到哪里",
    items: [
      "分析所需的代码文件与 diff 仅发送给部署方配置的 AI 网关（AI_BASE_URL）及其上游模型服务，用于生成功能、场景与变化说明。",
      "不发送给任何其他第三方。",
    ],
  },
  {
    heading: "我们存储什么",
    items: [
      "分析结果：功能、场景、行为变化、证据路径与行号、发布元数据。不存储源码文件全文。",
      "仓库凭据（GitHub App 密钥、仓库 Token）加密存储。",
      "账号数据只保存 Chandler sub、邮箱、显示名和头像；不保存 Chandler 密码或 OAuth token。",
    ],
  },
  {
    heading: "模型训练",
    items: [
      "我们不使用你的代码训练任何模型。",
      "上游模型服务商的数据处理以其自身条款为准；部署方负责确保所选网关及其上游符合保密要求。",
    ],
  },
  {
    heading: "删除与留存",
    items: [
      "删除产品（工作区级操作）会一并删除该产品的分析数据。",
      "登录会话有效期 7 天，过期后重新通过 Chandler 登录。",
      "分析数据保留至对应产品被删除，无自动过期。",
    ],
  },
  {
    heading: "事件通知",
    items: ["如发生影响你源码安全的事件，我们会尽快通知工作区联系人。"],
  },
  {
    heading: "结论边界",
    items: [
      "路径守卫只防引用幻觉，不防语义幻觉：每条结论都附代码证据，但证据覆盖描述证据范围，不表示结论正确。采纳前应经人工核实。",
    ],
  },
];

export default function DataNoticePage() {
  return (
    <main className="data-notice-page">
      <div className="data-notice-body">
        <Link href="/" className="back-link">← 返回首页</Link>
        <span className="eyebrow">DATA NOTICE</span>
        <h1>数据说明</h1>
        <p className="data-notice-meta">最后更新：{NOTICE_UPDATED} · 本页描述 CoDelphi 的实际数据流，与 README「数据与安全边界」保持一致。</p>
        {sections.map((section) => (
          <section key={section.heading} className="data-notice-section">
            <h2>{section.heading}</h2>
            <ul>
              {section.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

import Link from "next/link";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { verificationLabel } from "@/lib/spec-editor-ui";
import type { buildProductFocus } from "@/lib/product-focus";

const COPY = {
  mapTitle: { "zh-CN": "部分产品能力", en: "Selected product capabilities" },
  changesTitle: { "zh-CN": "最近重要变化", en: "Important recent changes" },
  changesNotice: { "zh-CN": "含 AI 提取的候选变化；全部内容需人工确认", en: "Includes AI-extracted candidates; all content requires confirmation" },
  attentionTitle: { "zh-CN": "需要关注", en: "Needs attention" },
  confirmationTitle: { "zh-CN": "需要确认", en: "Needs confirmation" },
  empty: { "zh-CN": "当前没有需要重点关注的变化", en: "No changes need attention right now" },
  all: { "zh-CN": "查看全部产品信息", en: "View all product information" },
  scenarios: { "zh-CN": "个场景", en: " scenarios" },
  overview: { "zh-CN": "功能概述", en: "Overview" },
  noChanges: { "zh-CN": "暂无重要变化", en: "No important changes yet" },
  stale: { "zh-CN": "可能过时", en: "Possibly stale" },
  unverified: { "zh-CN": "待确认", en: "Unverified" },
  verified: { "zh-CN": "已确认", en: "Verified" },
  manual: { "zh-CN": "人工维护", en: "Manual" },
  generated: { "zh-CN": "AI 提取", en: "AI extracted" },
  behaviorDetails: { "zh-CN": "查看行为规格与证据", en: "View behavior spec and evidence" },
  allCapabilities: { "zh-CN": "查看全部", en: "View all" },
} as const;

export function ProductFocus({ data, locale = "zh-CN" }: { data: ReturnType<typeof buildProductFocus>; locale?: UiLocale }) {
  return (
    <div className="product-focus">
      <section className="overview-panel">
        <div className="overview-panel-heading"><h2>{pick(locale, COPY.mapTitle)}</h2><Link className="overview-text-link" href={data.allFeaturesHref}>共 {data.featureTotal} 项 · {pick(locale, COPY.allCapabilities)}</Link></div>
        {data.map.length === 0 ? <p className="overview-note">No feature specifications yet</p> : data.map.map((feature) => (
          <article className="impact-item" key={feature.id}>
            <strong>{feature.name}</strong><span className="overview-meta-inline"> · {feature.scenarioCount > 0 ? `${feature.scenarioCount}${pick(locale, COPY.scenarios)}` : pick(locale, COPY.overview)} · {feature.source === "manual" ? pick(locale, COPY.manual) : pick(locale, COPY.generated)} · {verificationLabel(feature.verification, locale)}</span>
            <p>{feature.summary}</p>
            <details>
              <summary>{pick(locale, COPY.behaviorDetails)}</summary>
              {feature.scenarios.map((scenario) => <p key={scenario.reference}>{scenario.reference}：{scenario.context} → {scenario.action} → {scenario.outcome}</p>)}
              <Link className="overview-text-link" href={feature.href}>查看功能与证据</Link>
            </details>
          </article>
        ))}
      </section>

      <section className="overview-panel">
        <div className="overview-panel-heading"><h2>{pick(locale, COPY.changesTitle)}</h2></div>
        {data.changes.length > 0 ? <p className="overview-note">{pick(locale, COPY.changesNotice)}</p> : null}
        {data.changes.length === 0 ? <p className="overview-note">{pick(locale, COPY.noChanges)}</p> : data.changes.map((change) => (
          <details className="impact-item" key={change.id}>
            <summary><strong>{change.featureName}</strong> · {change.groupLabel}</summary>
            {change.summaries.map((summary) => <p key={summary}>{summary}</p>)}
            {change.evidencePaths.length > 0 ? <p>证据：{[...new Set(change.evidencePaths)].join("、")}</p> : null}
          </details>
        ))}
      </section>

      <section className="overview-panel">
        <div className="overview-panel-heading"><h2>{pick(locale, COPY.attentionTitle)}</h2></div>
        {data.emptyAttention ? <p className="overview-note">{pick(locale, COPY.empty)}</p> : data.attention.map((item) => (
          <div className="impact-item" key={item.featureName}><strong>{item.featureName}</strong><p>{item.reason}</p></div>
        ))}
        {data.confirmations.length > 0 ? <details className="overview-note"><summary>{pick(locale, COPY.confirmationTitle)}（{data.confirmations.length}）</summary><p>{data.confirmations.map((item) => item.featureName).join("、")}</p></details> : null}
      </section>
      <details className="overview-note"><summary>{pick(locale, COPY.all)}</summary><p>完整时间线、能力列表和健康统计在下方展开。</p></details>
    </div>
  );
}

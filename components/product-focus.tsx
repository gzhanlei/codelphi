import { pick, type UiLocale } from "@/lib/ui-locale";
import type { buildProductFocus } from "@/lib/product-focus";

const COPY = {
  changesTitle: { "zh-CN": "最近重要变化", en: "Important recent changes" },
  changesNotice: { "zh-CN": "含 AI 提取的候选变化；全部内容需人工确认", en: "Includes AI-extracted candidates; all content requires confirmation" },
  attentionTitle: { "zh-CN": "需要关注", en: "Needs attention" },
  confirmationTitle: { "zh-CN": "需要确认", en: "Needs confirmation" },
  empty: { "zh-CN": "当前没有需要重点关注的变化", en: "No changes need attention right now" },
  noChanges: { "zh-CN": "暂无重要变化", en: "No important changes yet" },
} as const;

export function ProductFocus({ data, locale = "zh-CN" }: { data: ReturnType<typeof buildProductFocus>; locale?: UiLocale }) {
  return (
    <div className="product-focus">
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
    </div>
  );
}

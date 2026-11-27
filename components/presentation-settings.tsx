import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { formatDateIn } from "@/lib/format";
import type { ProductPresentationRow } from "@/lib/product-presentation";
import { PRESENTATION_SETTINGS } from "@/lib/ui-strings/product";
import { PresentationRegenerateButton } from "./presentation-regenerate-button";

/**
 * 设置页「理解层」卡片：总览能力归纳与使用场景视图的生成状态，编辑者可手动重新生成。
 * 只读成员看状态、不见按钮；展示的是落库元数据，不在渲染时发起任何生成。
 */
export function PresentationSettings({ slug, presentation, hasFeatures, canEdit, locale = "zh-CN" }: { slug: string; presentation: ProductPresentationRow | null; hasFeatures: boolean; canEdit: boolean; locale?: UiLocale }) {
  const t = PRESENTATION_SETTINGS;
  const status = !hasFeatures
    ? pick(locale, t.statusNone)
    : !presentation
      ? pick(locale, t.statusNone)
      : presentation.refreshing
        ? pick(locale, t.statusRefreshing)
        : presentation.pending
          ? pick(locale, t.statusPending)
          : presentation.status === "failed"
            ? pick(locale, t.statusFailed)
            : presentation.status === "partial"
              ? pick(locale, t.statusPartial)
              : pick(locale, t.statusGenerated);
  return (
    <section className="overview-panel settings-panel" id="presentation-settings">
      <div className="overview-panel-heading"><span>09</span><h2>{pick(locale, t.title)}</h2></div>
      <p className="overview-note">{pick(locale, t.summary)}</p>
      <dl className="settings-facts">
        <div><dt>{pick(locale, t.status)}</dt><dd role="status">{status}</dd></div>
        {presentation ? (
          <>
            <div><dt>{pick(locale, t.journeys)}</dt><dd>{presentation.journeys.length}</dd></div>
            <div><dt>{pick(locale, t.coverage)}</dt><dd>{presentation.coverage.featuresInJourneys}/{presentation.coverage.featuresTotal}</dd></div>
            <div><dt>{pick(locale, t.generatedAt)}</dt><dd>{formatDateIn(locale, presentation.generatedAt, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</dd></div>
            {presentation.lastError ? <div><dt>{pick(locale, t.lastError)}</dt><dd><code>{presentation.lastError}</code></dd></div> : null}
          </>
        ) : null}
      </dl>
      {canEdit && hasFeatures ? <PresentationRegenerateButton slug={slug} locale={locale} /> : null}
    </section>
  );
}

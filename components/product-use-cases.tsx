import { Fragment } from "react";
import Link from "next/link";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { formatDateIn } from "@/lib/format";
import { evidenceItems } from "@/lib/evidence";
import type { PresentationJourneyView, ProductPresentationView } from "@/lib/product-presentation";
import { PRODUCT_JOURNEYS } from "@/lib/ui-strings/product";
import { EvidenceLinks } from "./evidence-links";

/**
 * 使用场景视图（?view=journeys）：产品理解层的「典型使用场景」全文。
 * 每条旅程是一段「起点 → 步骤 → 终点」的叙事，但旅程本身只是引用链——步骤文字、证据全部来自
 * 被引用的规格场景，不新增事实。服务端渲染、无 JS 也可读：分组用原生 details，页内跳转用锚点。
 */

function JourneyArc({ journey, locale }: { journey: PresentationJourneyView; locale: UiLocale }) {
  return (
    <p className="journey-arc">
      <span><b>{pick(locale, PRODUCT_JOURNEYS.startingPoint)}</b>{journey.startingPoint}</span>
      <span aria-hidden="true">→</span>
      <span><b>{pick(locale, PRODUCT_JOURNEYS.finalOutcome)}</b>{journey.finalOutcome}</span>
    </p>
  );
}

function JourneyCard({ journey, locale }: { journey: PresentationJourneyView; locale: UiLocale }) {
  return (
    <article className="journey" id={journey.id}>
      <h4>{journey.name}</h4>
      <JourneyArc journey={journey} locale={locale} />
      <ol className="journey-steps">
        {journey.steps.map((step, index) => (
          <li className="journey-step" key={`${step.featureName}-${step.reference}-${index}`}>
            <div className="journey-step-head">
              <span className="journey-step-index">{pick(locale, PRODUCT_JOURNEYS.stepLabel).replace("{count}", String(index + 1))}</span>
              {/* 步骤以「结果」为标题（读者先看到这一步得到了什么），情境与操作在后 */}
              <strong>{step.outcome}</strong>
            </div>
            <dl className="journey-step-fields">
              <div><dt>{pick(locale, PRODUCT_JOURNEYS.context)}</dt><dd>{step.context}</dd></div>
              <div><dt>{pick(locale, PRODUCT_JOURNEYS.action)}</dt><dd>{step.action}</dd></div>
            </dl>
            {/* 深链落到规格工作台的具体场景；匿名演示访客也能走 ?view=spec&feature=（稳定链接会跳登录） */}
            {step.href
              ? <Link className="journey-step-link" href={step.href}>{pick(locale, PRODUCT_JOURNEYS.openScenario).replace("{feature}", step.featureDisplayName).replace("{reference}", step.reference)}</Link>
              : <span className="journey-step-missing">{pick(locale, PRODUCT_JOURNEYS.missingScenario)}</span>}
            {/* 这一步没有任何证据时不渲染空标签（与规格页的场景卡一致） */}
            {evidenceItems(step.evidence).length > 0 ? <div className="journey-step-evidence"><span>{pick(locale, PRODUCT_JOURNEYS.evidence)}</span><EvidenceLinks value={step.evidence} /></div> : null}
          </li>
        ))}
      </ol>
    </article>
  );
}

function groupTitle(group: ProductPresentationView["groups"][number], locale: UiLocale) {
  if (group.kind === "headline") return pick(locale, PRODUCT_JOURNEYS.headlineGroup);
  if (group.kind === "ungrouped") return pick(locale, PRODUCT_JOURNEYS.ungroupedGroup);
  return group.name ?? pick(locale, PRODUCT_JOURNEYS.ungroupedGroup);
}

/** 失败原因给成「人话 + 可行动」的一句：技术原文留在库里，不直接甩给读者。 */
function failureReason(view: ProductPresentationView, locale: UiLocale): string {
  const raw = view.row.lastError ?? "";
  const transient = /gateway|HTTP \d{3}|timeout|timed out|fetch failed|ECONN|ENOTFOUND|AI_MODEL|API key|not configured/i.test(raw);
  return pick(locale, transient ? PRODUCT_JOURNEYS.failureAiUnavailable : PRODUCT_JOURNEYS.failureUnknown);
}

/** 真实空态：按原因说明为什么没有，编辑者给出去设置重新生成的入口（入口不因数据为空而消失）。 */
function EmptyState({ presentation, hasFeatures, canEdit, locale }: { presentation: ProductPresentationView | null; hasFeatures: boolean; canEdit: boolean; locale: UiLocale }) {
  let message: string;
  if (!hasFeatures) message = pick(locale, PRODUCT_JOURNEYS.emptyNoSpec);
  else if (!presentation) message = pick(locale, PRODUCT_JOURNEYS.emptyNotGenerated);
  else if (presentation.row.refreshing) message = pick(locale, PRODUCT_JOURNEYS.emptyGenerating);
  else if (presentation.row.status === "failed") message = pick(locale, PRODUCT_JOURNEYS.emptyFailed).replace("{reason}", failureReason(presentation, locale));
  else message = pick(locale, PRODUCT_JOURNEYS.emptyNoJourneys);
  return (
    <section className="overview-panel use-cases-empty" data-use-cases-empty="">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_JOURNEYS.heading)}</h2></div>
      <p className="overview-note" role="status">{message}</p>
      {canEdit && hasFeatures ? <Link className="overview-text-link" href={`?view=settings#presentation-settings`}>{pick(locale, PRODUCT_JOURNEYS.goSettings)}</Link> : null}
    </section>
  );
}

export function ProductUseCases({ presentation, hasFeatures, canEdit, locale = "zh-CN" }: { presentation: ProductPresentationView | null; hasFeatures: boolean; canEdit: boolean; locale?: UiLocale }) {
  if (!presentation || presentation.visibleJourneys.length === 0) return <EmptyState presentation={presentation} hasFeatures={hasFeatures} canEdit={canEdit} locale={locale} />;
  const { row, groups, staleJourneys, foldedJourneys } = presentation;
  // 分组里的旅程都是完好且互不重复的；只有链接引用的分组也保留（总览能力卡链进来要有落点）
  const liveGroups = groups.filter((group) => group.journeys.length > 0 || group.related.length > 0);
  return (
    <div className="use-cases">
      <section className="overview-panel">
        <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_JOURNEYS.heading)}</h2><span className="overview-meta-inline">{pick(locale, PRODUCT_JOURNEYS.aiNote)}</span></div>
        <p>{pick(locale, PRODUCT_JOURNEYS.note)}</p>
        <p className="use-cases-summary" data-use-cases-summary="">
          {pick(locale, PRODUCT_JOURNEYS.summary)
            .replace("{journeys}", String(presentation.visibleJourneys.length))
            .replace("{covered}", String(presentation.coverage.featuresInJourneys))
            .replace("{total}", String(presentation.coverage.featuresTotal))
            .replace("{time}", formatDateIn(locale, row.generatedAt))}
        </p>
        {row.source === "ai_snapshot_import" ? <p className="use-cases-notice">{pick(locale, PRODUCT_JOURNEYS.importedNote)}</p> : null}
        {row.pending || staleJourneys.length > 0 ? <p className="use-cases-notice" role="status">{pick(locale, PRODUCT_JOURNEYS.pendingNote)}</p> : null}
        {liveGroups.length > 1 ? (
          <nav className="use-cases-nav" aria-label={pick(locale, PRODUCT_JOURNEYS.navLabel)}>
            {liveGroups.map((group) => <a href={`#${group.key}`} key={group.key}>{groupTitle(group, locale)}</a>)}
          </nav>
        ) : null}
      </section>
      {liveGroups.map((group) => (
        // 分组默认展开：总览深链（#capability-N）要直接落到可见的旅程上
        <details className="overview-panel use-case-group" id={group.key} open key={group.key}>
          <summary className="use-case-group-heading">
            <h3>{groupTitle(group, locale)}</h3>
            {/* 没有完整卡片、只有链接引用的分组不显示「0 条」 */}
            {group.journeys.length > 0 ? <span>{pick(locale, PRODUCT_JOURNEYS.groupCount).replace("{count}", String(group.journeys.length))}</span> : null}
          </summary>
          <div className="journey-list">{group.journeys.map((journey) => <JourneyCard journey={journey} locale={locale} key={journey.id} />)}</div>
          {/* 每条旅程只完整展示一次：途经本能力、在别的分组展示的场景只给链接 */}
          {group.related.length > 0 ? (
            <p className="use-cases-related">
              {pick(locale, PRODUCT_JOURNEYS.related)}
              {group.related.map((journey, index) => (
                <Fragment key={journey.id}>{index > 0 ? pick(locale, PRODUCT_JOURNEYS.relatedSeparator) : null}<a href={`#${journey.id}`}>{journey.name}</a></Fragment>
              ))}
            </p>
          ) : null}
        </details>
      ))}
      {staleJourneys.length > 0 ? (
        <details className="overview-panel use-case-group use-case-group-stale">
          <summary className="use-case-group-heading">
            <h3>{pick(locale, PRODUCT_JOURNEYS.staleGroup)}</h3>
            <span>{pick(locale, PRODUCT_JOURNEYS.groupCount).replace("{count}", String(staleJourneys.length))}</span>
          </summary>
          {staleJourneys.map((journey) => (
            <div key={journey.id}>
              <p className="overview-note" role="status">{pick(locale, PRODUCT_JOURNEYS.staleNote).replace("{count}", String(journey.steps.length - journey.resolvedSteps))}</p>
              <JourneyCard journey={journey} locale={locale} />
            </div>
          ))}
        </details>
      ) : null}
      {/* 落库内容里按当前规则不再展示的条目（较早的生成规则或快照导入留下的：互相重复、罗列同一功能的多条场景）：不画卡，但如实列出 */}
      {foldedJourneys.length > 0 ? (
        <details className="overview-panel use-case-group use-case-group-folded">
          <summary className="use-case-group-heading">
            <h3>{pick(locale, PRODUCT_JOURNEYS.foldedGroup)}</h3>
            <span>{pick(locale, PRODUCT_JOURNEYS.groupCount).replace("{count}", String(foldedJourneys.length))}</span>
          </summary>
          <p className="overview-note">{pick(locale, PRODUCT_JOURNEYS.foldedNote)}</p>
          <ul className="use-cases-folded">{foldedJourneys.map((journey) => <li key={journey.id}>{journey.name}</li>)}</ul>
        </details>
      ) : null}
      {presentation.brokenJourneys > 0 ? <p className="overview-note use-cases-broken">{pick(locale, PRODUCT_JOURNEYS.brokenNote).replace("{count}", String(presentation.brokenJourneys))}</p> : null}
    </div>
  );
}

import Link from "next/link";
import { ProductFocus } from "./product-focus";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { KNOWLEDGE_HEALTH, PRODUCT_OVERVIEW, SPEC_EDITOR } from "@/lib/ui-strings/product";
import { KnowledgeHealthPanel } from "./knowledge-health-panel";
import { SpecAsk } from "./spec-ask";
import { changeGroupLabel, type ProductOverviewData, type TimelineEntry } from "@/lib/product-overview";
import { coverageExplainer } from "@/lib/coverage-display";

function CapabilityList({ capabilities, locale = "zh-CN" }: { capabilities: ProductOverviewData["capabilities"]; locale?: UiLocale }) {
  if (capabilities.length === 0) return <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.emptyCapabilities)}</p>;
  return <div className="capability-list">{capabilities.map((feature) => <Link href={feature.href} className="capability-item" key={feature.id}><strong>{feature.name}</strong><span>{feature.scenarioCount}{pick(locale, PRODUCT_OVERVIEW.capabilityScenarios)}{feature.source === "manual" ? pick(locale, SPEC_EDITOR.sourceManual) : pick(locale, SPEC_EDITOR.sourceGenerated)}</span><p>{feature.summary}</p></Link>)}</div>;
}

function CapabilitiesPanel({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  if (data.capabilities.length === 0) return <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.emptyCapabilities)}</p>;
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.capabilitiesHeading)}</h2><p>{pick(locale, PRODUCT_OVERVIEW.capabilitiesNote)}</p></div>
      <CapabilityList capabilities={data.capabilities} locale={locale} />
    </section>
  );
}

/**
 * 本次发布的用户影响（设计 §6）：只复用已落库 changes.user_impact，
 * 回退态按确定性数据展示，不用更早发布冒充最新发布；历史导航显式带日期与发布身份。
 */
function UserImpactPanel({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  const { userImpact, latestRelease } = data;
  if (userImpact.state === "none" || !latestRelease) return null;
  const deepLink = `?view=changes#release-${latestRelease.id}`;
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.impactHeading)}</h2><span className="overview-meta-inline">{latestRelease.title} · {dayLabel(latestRelease.committedAt, locale)}</span><Link className="overview-text-link" href={deepLink}>{pick(locale, PRODUCT_OVERVIEW.allDiffs)}</Link></div>
      {userImpact.state === "impacts" ? (
        <div className="impact-list">
          {userImpact.items.map((item) => (
            <div className="impact-item" key={`${item.releaseId}-${item.featureName}`}>
              <strong>{item.featureName}</strong>
              {item.userImpacts.map((text) => <p key={text.slice(0, 16)}>{text}</p>)}
              {item.moreCount > 0 ? <p className="impact-more">{pick(locale, PRODUCT_OVERVIEW.impactMore).replace("{count}", String(item.moreCount))}</p> : null}
              <Link className="overview-text-link" href={deepLink}>{pick(locale, PRODUCT_OVERVIEW.viewDiffs)}</Link>
            </div>
          ))}
        </div>
      ) : null}
      {userImpact.state === "changes" ? (
        <div className="impact-list">
          <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.impactFallback).replace("{count}", String(userImpact.changeStats.added + userImpact.changeStats.removed + userImpact.changeStats.changed))}</p>
          {data.changeGroups.slice(0, 3).map((group) => (
            <div className="impact-item" key={group.featureName}>
              <strong>{group.featureName}</strong>
              <p>{changeGroupLabel(group, locale)}</p>
            </div>
          ))}
          <Link className="overview-text-link" href={deepLink}>{pick(locale, PRODUCT_OVERVIEW.viewDiffs)}</Link>
        </div>
      ) : null}
      {userImpact.state === "quiet" ? <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.quietNote)}</p> : null}
      {userImpact.priorBehavioralRelease ? (
        <p className="impact-prior"><Link className="overview-text-link" href={`?view=changes#release-${userImpact.priorBehavioralRelease.id}`}>{pick(locale, PRODUCT_OVERVIEW.priorRelease).replace("{title}", userImpact.priorBehavioralRelease.title).replace("{date}", userImpact.priorBehavioralRelease.dateLabel)}</Link></p>
      ) : null}
    </section>
  );
}

/** 任务入口（设计 §7）：任务文案优先于角色标签；数据缺失时给真实禁用原因，不产出死链。 */
function TaskEntriesPanel({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.tasksHeading)}</h2><p>{pick(locale, PRODUCT_OVERVIEW.tasksNote)}</p></div>
      <div className="task-entries">
        {data.taskEntries.map((entry) => entry.href
          ? <Link className="task-entry" href={entry.href} key={entry.key}><strong>{entry.question}</strong><span>{pick(locale, PRODUCT_OVERVIEW.taskOpen)}</span></Link>
          : <div className="task-entry task-entry-disabled" key={entry.key}><strong>{entry.question}</strong><span>{entry.disabledReason}</span></div>)}
      </div>
    </section>
  );
}

const STATUS_CHIPS: Record<string, { entry: typeof PRODUCT_OVERVIEW.chipDraft; className: string }> = {
  draft: { entry: PRODUCT_OVERVIEW.chipDraft, className: "tl-chip-draft" },
  published: { entry: PRODUCT_OVERVIEW.chipPublished, className: "tl-chip-published" },
  unpublished: { entry: PRODUCT_OVERVIEW.chipUnpublished, className: "tl-chip-unpublished" },
};

function dayLabel(date: Date | string, locale: UiLocale = "zh-CN") {
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(new Date(date));
}

/** 发布时间线：行为账本的发布点投影（日期 + 发布稿状态徽章 + 一句话），条目点击进入发布卡详情。连续零变化发布折叠为一组（details 展开，无 JS 依赖）。 */
function ReleaseTimeline({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  if (data.timelineGroups.length === 0) return null;
  const renderEntry = (entry: TimelineEntry) => {
    const chip = entry.noteStatus ? STATUS_CHIPS[entry.noteStatus] : null;
    return (
      <div className="tl-item" key={entry.id}>
        <div className="tl-date">{entry.dateLabel}{chip ? <span className={`tl-chip ${chip.className}`}>{pick(locale, chip.entry)}</span> : null}</div>
        <Link className="tl-title" href={`?view=changes#release-${entry.id}`}>{entry.headline || entry.title}</Link>
        {entry.firstLine ? <p className="tl-summary">{entry.firstLine}</p> : null}
      </div>
    );
  };
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.timelineHeading)}</h2><span className="overview-meta-inline">{data.freshness} · {data.analysisLabel}{data.headlineSource === "generated" ? `${pick(locale, PRODUCT_OVERVIEW.headlineGenerated)}${pick(locale, PRODUCT_OVERVIEW.evidenceFilesUnit).replace("{count}", String(data.headlineEvidence.length))}` : ""}</span><Link className="overview-text-link" href="?view=changes">{pick(locale, PRODUCT_OVERVIEW.allChanges)}</Link></div>
      <div className="overview-timeline">
        {data.timelineGroups.map((group) => group.kind === "single"
          ? renderEntry(group.release)
          : (
            <details className="tl-quiet-run" key={`quiet-${group.releases[0].id}`}>
              <summary>{pick(locale, PRODUCT_OVERVIEW.quietRunSummary).replace("{count}", String(group.count))}</summary>
              {group.releases.map(renderEntry)}
            </details>
          ))}
      </div>
    </section>
  );
}

function TrustLine({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  const { trust, coverageByte, coverageFiles } = data;
  return (
    <p className="overview-trust-line">{coverageByte ?? pick(locale, PRODUCT_OVERVIEW.trustCoverageMissing)}{coverageFiles ? ` · ${coverageFiles}` : ""} · {pick(locale, PRODUCT_OVERVIEW.trustEvidenceFiles).replace("{count}", String(trust.evidencePathCount))} · {pick(locale, PRODUCT_OVERVIEW.trustManualEntries).replace("{count}", String(trust.manualFeatureCount + trust.manualScenarioCount))}{trust.specVersionId !== null ? ` · Spec v${trust.specVersionId}` : ""}。{coverageExplainer(locale)}{pick(locale, PRODUCT_OVERVIEW.trustDisclaimer)}</p>
  );
}

export function ProductOverview({ data, canEdit = false, locale = "zh-CN" }: { data: ProductOverviewData; canEdit?: boolean; locale?: UiLocale }) {
  return (
    <div className="product-overview">
      <ProductFocus data={data.focus} locale={locale} />
      <TaskEntriesPanel data={data} locale={locale} />
      <div className="overview-ask">
        <section className="overview-panel">
          <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.askHeading)}</h2><p>{pick(locale, PRODUCT_OVERVIEW.askNote)}</p></div>
          <SpecAsk
            slug={data.slug}
            productBase={data.productBase}
            locale={locale}
            // 建议问法从产品自己的能力名生成：检索必命中自己，避免推荐了却答「未覆盖」
            suggestions={data.capabilities.slice(0, 3).map((capability) => pick(locale, PRODUCT_OVERVIEW.askSuggestion).replace("{name}", capability.name))}
          />
        </section>
      </div>
      <details className="overview-secondary">
        <summary>展开完整产品信息</summary>
        <UserImpactPanel data={data} locale={locale} />
        <ReleaseTimeline data={data} locale={locale} />
        <CapabilitiesPanel data={data} locale={locale} />
        <TrustLine data={data} locale={locale} />
        <KnowledgeHealthPanel slug={data.slug} locale={locale} />
      </details>
    </div>
  );
}

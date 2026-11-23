import Link from "next/link";
import { ProductFocus } from "./product-focus";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { PRODUCT_JOURNEYS, PRODUCT_OVERVIEW, SPEC_EDITOR } from "@/lib/ui-strings/product";
import { SpecAsk } from "./spec-ask";
import type { JourneyHighlight, OverviewCapabilityCard, ProductOverviewData, TimelineEntry } from "@/lib/product-overview";

/** 人工业务域卡与平铺功能卡：整卡是一个链接，进入对应的规格页。 */
function CapabilityList({ capabilities, locale = "zh-CN" }: { capabilities: ProductOverviewData["capabilities"]; locale?: UiLocale }) {
  if (capabilities.length === 0) return <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.emptyCapabilities)}</p>;
  return <div className="capability-list">{capabilities.map((capability) => (capability.origin === "ai"
    ? <AiCapabilityCard capability={capability} locale={locale} key={`ai-${capability.id}`} />
    : <Link href={capability.href} className="capability-item" key={capability.id}><strong>{capability.name}</strong><span>{capability.scenarioCount}{pick(locale, PRODUCT_OVERVIEW.capabilityScenarios)}{capability.source === "manual" ? pick(locale, SPEC_EDITOR.sourceManual) : pick(locale, SPEC_EDITOR.sourceGenerated)}</span><p>{capability.summary}</p></Link>))}</div>;
}

/**
 * AI 归纳的能力分组卡（2026-11-23 用户裁决：没有人工业务域时直接展示并标注来源）。
 * 分组本身不是功能行，所以不整卡可点：标题链到该能力的使用场景，成员功能各自链到规格页。
 */
function AiCapabilityCard({ capability, locale }: { capability: OverviewCapabilityCard; locale: UiLocale }) {
  return (
    <article className="capability-item capability-item-ai">
      <div className="capability-item-title">
        <Link href={capability.href}><strong>{capability.name}</strong></Link>
        <span className="ai-badge">{pick(locale, PRODUCT_OVERVIEW.aiBadge)}</span>
      </div>
      <span>{pick(locale, PRODUCT_OVERVIEW.capabilityFeatures).replace("{count}", String(capability.featureCount ?? 0))} · {pick(locale, PRODUCT_OVERVIEW.capabilityScenariosCount).replace("{count}", String(capability.scenarioCount))}</span>
      <p>{capability.summary}</p>
      {capability.members && capability.members.length > 0 ? (
        <details className="capability-members">
          <summary>{pick(locale, PRODUCT_OVERVIEW.capabilityFeaturesToggle)}</summary>
          <ul>{capability.members.map((member) => <li key={member.id}><Link href={member.href}>{member.displayName}</Link></li>)}</ul>
        </details>
      ) : null}
    </article>
  );
}

export function CapabilitiesPanel({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  if (data.capabilities.length === 0) return <p className="overview-note">{pick(locale, PRODUCT_OVERVIEW.emptyCapabilities)}</p>;
  const onlyAi = data.capabilities.every((capability) => capability.origin === "ai");
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.capabilitiesHeading)}</h2><p>{pick(locale, onlyAi ? PRODUCT_OVERVIEW.capabilitiesNoteAi : PRODUCT_OVERVIEW.capabilitiesNote)}</p><Link className="overview-text-link" href={`${data.productBase}?view=spec`}>{pick(locale, PRODUCT_OVERVIEW.fullCapabilitiesLink)}</Link></div>
      <CapabilityList capabilities={data.capabilities} locale={locale} />
    </section>
  );
}

/**
 * 典型使用场景（精简版）：每条只讲「起点 → 终点」，完整步骤在使用场景视图。
 * 没有完好旅程时整块不渲染——空态与原因由「使用场景」Tab 承担，入口不因数据为空而消失。
 */
function JourneysPanel({ data, locale = "zh-CN" }: { data: ProductOverviewData; locale?: UiLocale }) {
  if (data.journeyHighlights.length === 0) return null;
  return (
    <section className="overview-panel" data-overview-journeys="">
      <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.journeysHeading)}</h2><p>{pick(locale, PRODUCT_OVERVIEW.journeysNote)}</p><Link className="overview-text-link" href={`${data.productBase}?view=journeys`}>{pick(locale, PRODUCT_OVERVIEW.allJourneys).replace("{count}", String(data.journeyTotal))}</Link></div>
      <div className="journey-highlights">
        {data.journeyHighlights.map((journey: JourneyHighlight) => (
          <Link className="journey-highlight" href={journey.href} key={journey.id}>
            <strong>{journey.name}</strong>
            <p className="journey-arc"><span><b>{pick(locale, PRODUCT_JOURNEYS.startingPoint)}</b>{journey.startingPoint}</span><span aria-hidden="true">→</span><span><b>{pick(locale, PRODUCT_JOURNEYS.finalOutcome)}</b>{journey.finalOutcome}</span></p>
            <span className="journey-highlight-meta">{pick(locale, PRODUCT_OVERVIEW.journeySteps).replace("{count}", String(journey.stepCount))} · {pick(locale, PRODUCT_OVERVIEW.journeyFeatures).replace("{count}", String(journey.featureCount))}</span>
          </Link>
        ))}
      </div>
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

export function ProductOverview({ data, canEdit = false, locale = "zh-CN" }: { data: ProductOverviewData; canEdit?: boolean; locale?: UiLocale }) {
  return (
    <div className="product-overview">
      <CapabilitiesPanel data={data} locale={locale} />
      <JourneysPanel data={data} locale={locale} />
      <ProductFocus data={data.focus} locale={locale} />
      <TaskEntriesPanel data={data} locale={locale} />
      <div className="overview-ask">
        <section className="overview-panel">
          <div className="overview-panel-heading"><h2>{pick(locale, PRODUCT_OVERVIEW.askHeading)}</h2><p>{pick(locale, PRODUCT_OVERVIEW.askNote)}</p></div>
          <SpecAsk
            slug={data.slug}
            productBase={data.productBase}
            locale={locale}
            // 建议问法从有实际场景的原始功能名生成（业务分组时不用父级名称）：检索必命中自己
            suggestions={data.questionCapabilities.slice(0, 3).map((capability) => pick(locale, PRODUCT_OVERVIEW.askSuggestion).replace("{name}", capability.canonicalName))}
          />
        </section>
      </div>
      <div className="overview-secondary">
        <ReleaseTimeline data={data} locale={locale} />
      </div>
    </div>
  );
}

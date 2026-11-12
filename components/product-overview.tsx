import Link from "next/link";
import { KnowledgeHealthPanel } from "./knowledge-health-panel";
import { SpecAsk } from "./spec-ask";
import { changeGroupLabel, type ProductOverviewData, type TimelineEntry } from "@/lib/product-overview";

function CapabilityList({ capabilities }: { capabilities: ProductOverviewData["capabilities"] }) {
  if (capabilities.length === 0) return <p className="overview-note">尚无功能规格。</p>;
  return <div className="capability-list">{capabilities.map((feature) => <Link href={feature.href} className="capability-item" key={feature.id}><strong>{feature.name}</strong><span>{feature.scenarioCount} 个场景 · {feature.source === "manual" ? "人工维护" : "代码生成"}</span><p>{feature.summary}</p></Link>)}</div>;
}

function CapabilitiesPanel({ data }: { data: ProductOverviewData }) {
  if (data.capabilities.length === 0) return <p className="overview-note">尚无功能规格。</p>;
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>当前核心能力</h2><p>按场景覆盖排序，点击进入规格工作台。</p></div>
      <CapabilityList capabilities={data.capabilities} />
    </section>
  );
}

/**
 * 本次发布的用户影响（设计 §6）：只复用已落库 changes.user_impact，
 * 回退态按确定性数据展示，不用更早发布冒充最新发布；历史导航显式带日期与发布身份。
 */
function UserImpactPanel({ data }: { data: ProductOverviewData }) {
  const { userImpact, latestRelease } = data;
  if (userImpact.state === "none" || !latestRelease) return null;
  const deepLink = `?view=changes#release-${latestRelease.id}`;
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>本次发布对用户的影响</h2><span className="overview-meta-inline">{latestRelease.title} · {dayLabel(latestRelease.committedAt)}</span><Link className="overview-text-link" href={deepLink}>全部前后差异 →</Link></div>
      {userImpact.state === "impacts" ? (
        <div className="impact-list">
          {userImpact.items.map((item) => (
            <div className="impact-item" key={`${item.releaseId}-${item.featureName}`}>
              <strong>{item.featureName}</strong>
              {item.userImpacts.map((text) => <p key={text.slice(0, 16)}>{text}</p>)}
              {item.moreCount > 0 ? <p className="impact-more">另有 {item.moreCount} 条影响说明，见全部前后差异。</p> : null}
              <Link className="overview-text-link" href={deepLink}>查看前后差异 →</Link>
            </div>
          ))}
        </div>
      ) : null}
      {userImpact.state === "changes" ? (
        <div className="impact-list">
          <p className="overview-note">本次发布未附用户影响说明，检测到 {userImpact.changeStats.added + userImpact.changeStats.removed + userImpact.changeStats.changed} 处规格行为变化：</p>
          {data.changeGroups.slice(0, 3).map((group) => (
            <div className="impact-item" key={group.featureName}>
              <strong>{group.featureName}</strong>
              <p>{changeGroupLabel(group)}</p>
            </div>
          ))}
          <Link className="overview-text-link" href={deepLink}>查看前后差异 →</Link>
        </div>
      ) : null}
      {userImpact.state === "quiet" ? <p className="overview-note">本次未发现规格行为变化。</p> : null}
      {userImpact.priorBehavioralRelease ? (
        <p className="impact-prior"><Link className="overview-text-link" href={`?view=changes#release-${userImpact.priorBehavioralRelease.id}`}>最近一次有行为变化的发布：{userImpact.priorBehavioralRelease.title}（{userImpact.priorBehavioralRelease.dateLabel}）→</Link></p>
      ) : null}
    </section>
  );
}

/** 任务入口（设计 §7）：任务文案优先于角色标签；数据缺失时给真实禁用原因，不产出死链。 */
function TaskEntriesPanel({ data }: { data: ProductOverviewData }) {
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>快速导航</h2><p>按你想回答的问题进入对应视图。</p></div>
      <div className="task-entries">
        {data.taskEntries.map((entry) => entry.href
          ? <Link className="task-entry" href={entry.href} key={entry.key}><strong>{entry.question}</strong><span>查看 →</span></Link>
          : <div className="task-entry task-entry-disabled" key={entry.key}><strong>{entry.question}</strong><span>{entry.disabledReason}</span></div>)}
      </div>
    </section>
  );
}

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  draft: { label: "发布稿待校对", className: "tl-chip-draft" },
  published: { label: "已发布", className: "tl-chip-published" },
  unpublished: { label: "已下线", className: "tl-chip-unpublished" },
};

function dayLabel(date: Date | string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(date));
}

/** 发布时间线：行为账本的发布点投影（日期 + 发布稿状态徽章 + 一句话），条目点击进入发布卡详情。连续零变化发布折叠为一组（details 展开，无 JS 依赖）。 */
function ReleaseTimeline({ data }: { data: ProductOverviewData }) {
  if (data.timelineGroups.length === 0) return null;
  const renderEntry = (entry: TimelineEntry) => {
    const chip = entry.noteStatus ? STATUS_CHIP[entry.noteStatus] : null;
    return (
      <div className="tl-item" key={entry.id}>
        <div className="tl-date">{entry.dateLabel}{chip ? <span className={`tl-chip ${chip.className}`}>{chip.label}</span> : null}</div>
        <Link className="tl-title" href={`?view=changes#release-${entry.id}`}>{entry.headline || entry.title}</Link>
        {entry.firstLine ? <p className="tl-summary">{entry.firstLine}</p> : null}
      </div>
    );
  };
  return (
    <section className="overview-panel">
      <div className="overview-panel-heading"><h2>发布时间线</h2><span className="overview-meta-inline">{data.freshness} · {data.analysisLabel}{data.headlineSource === "generated" ? ` · 代码生成 · ${data.headlineEvidence.length} 个证据文件` : ""}</span><Link className="overview-text-link" href="?view=changes">全部发布变化 →</Link></div>
      <div className="overview-timeline">
        {data.timelineGroups.map((group) => group.kind === "single"
          ? renderEntry(group.release)
          : (
            <details className="tl-quiet-run" key={`quiet-${group.releases[0].id}`}>
              <summary>{group.count} 次提交均未发现规格行为变化 · 展开提交记录</summary>
              {group.releases.map(renderEntry)}
            </details>
          ))}
      </div>
    </section>
  );
}

function TrustLine({ data }: { data: ProductOverviewData }) {
  const { trust, coverageByte, coverageFiles } = data;
  return (
    <p className="overview-trust-line">{coverageByte ?? "源码装配覆盖率 —（无覆盖率回执）"}{coverageFiles ? ` · ${coverageFiles}` : ""} · 证据文件 {trust.evidencePathCount} 个 · 人工条目 {trust.manualFeatureCount + trust.manualScenarioCount} 条{trust.specVersionId !== null ? ` · Spec v${trust.specVersionId}` : ""}。覆盖率描述本次分析实际读取的源码范围，不代表结论正确率；规格未覆盖不等于产品不支持，采纳前应经人工核实。</p>
  );
}

export function ProductOverview({ data, canEdit = false }: { data: ProductOverviewData; canEdit?: boolean }) {
  return (
    <div className="product-overview">
      <UserImpactPanel data={data} />
      <div className="overview-ask">
        <section className="overview-panel">
          <div className="overview-panel-heading"><h2>规格问答</h2><p>用一句话问产品行为，答案附源码证据。</p></div>
          <SpecAsk
            slug={data.slug}
            productBase={data.productBase}
            // 建议问法从产品自己的能力名生成：检索必命中自己，避免推荐了却答「未覆盖」
            suggestions={data.capabilities.slice(0, 3).map((capability) => `${capability.name} 是怎么工作的？`)}
          />
        </section>
      </div>
      <TaskEntriesPanel data={data} />
      <ReleaseTimeline data={data} />
      <CapabilitiesPanel data={data} />
      <TrustLine data={data} />
      <KnowledgeHealthPanel slug={data.slug} />
    </div>
  );
}

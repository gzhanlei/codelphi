import Link from "next/link";
import { KnowledgeHealthPanel } from "./knowledge-health-panel";
import { SpecAsk } from "./spec-ask";
import type { ProductOverviewData, TimelineEntry } from "@/lib/product-overview";

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

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  draft: { label: "发布稿待校对", className: "tl-chip-draft" },
  published: { label: "已发布", className: "tl-chip-published" },
  unpublished: { label: "已下线", className: "tl-chip-unpublished" },
};

function firstLine(text: string, max = 70) {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const cut = flat.search(/[。；！？]/);
  const line = cut > 0 ? flat.slice(0, cut + 1) : flat;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

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
  const { trust, coverageLine } = data;
  return (
    <p className="overview-trust-line">证据覆盖率 {trust.coverageRatio ?? "—"} · 证据文件 {trust.evidencePathCount} 个 · 人工条目 {trust.manualFeatureCount + trust.manualScenarioCount} 条{trust.specVersionId !== null ? ` · Spec v${trust.specVersionId}` : ""}{coverageLine ? ` · ${coverageLine}` : ""}。证据覆盖描述证据范围，不等于结论正确，采纳前应经人工核实。</p>
  );
}

export function ProductOverview({ data, canEdit = false }: { data: ProductOverviewData; canEdit?: boolean }) {
  return (
    <div className="product-overview">
      <div className="overview-ask">
        <SpecAsk
          slug={data.slug}
          productBase={data.productBase}
          // 建议问法从产品自己的能力名生成：检索必命中自己，避免推荐了却答「未覆盖」
          suggestions={data.capabilities.slice(0, 3).map((capability) => `${capability.name} 是怎么工作的？`)}
        />
      </div>
      <ReleaseTimeline data={data} />
      <CapabilitiesPanel data={data} />
      <TrustLine data={data} />
      <KnowledgeHealthPanel slug={data.slug} />
    </div>
  );
}
